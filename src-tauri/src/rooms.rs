//! Meeting rooms of a Microsoft 365 tenant, for the event editor's location suggestions.
//!
//! `GET /beta/me/findRooms` is documented as needing only User.Read, but some tenants refuse
//! it ("Access is denied") until the user grants User.ReadBasic.All, which they can do
//! themselves. The v1.0 Places API needs Place.Read.All, which an admin has to approve.
//! When neither works the editor is told what's missing so it can offer to reconnect the
//! account with that permission. Personal Microsoft accounts and Google have no rooms.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use reqwest::Method;
use serde::Serialize;
use serde_json::Value;

use crate::auth::{has_scope, SCOPE_DIRECTORY, SCOPE_PLACES};
use crate::error::{AppError, Result};
use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub name: String,
    /// The room's mailbox: invite it to book the room.
    pub address: String,
    pub capacity: Option<i64>,
    pub building: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomList {
    pub rooms: Vec<Room>,
    /// Why there are none, when a permission would fix it: the scope to ask for, and whether
    /// an admin has to approve it.
    pub needs: Option<Needs>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Needs {
    pub scope: String,
    pub admin: bool,
}

const CACHE_FOR: Duration = Duration::from_secs(6 * 3600);
static CACHE: std::sync::LazyLock<std::sync::Mutex<HashMap<i64, (Instant, RoomList)>>> = std::sync::LazyLock::new(Default::default);

/// After a reconnect: ask again.
pub fn forget(account_id: i64) {
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).remove(&account_id);
}

/// From findRooms ({ name, address }) or the Places API ({ displayName, emailAddress, ... }).
pub fn parse(v: &Value) -> Vec<Room> {
    let mut rooms: Vec<Room> = v["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let address = r["address"].as_str().or_else(|| r["emailAddress"].as_str())?.to_string();
            let name = r["name"].as_str().or_else(|| r["displayName"].as_str()).unwrap_or(&address).to_string();
            Some(Room { name, address, capacity: r["capacity"].as_i64(), building: r["building"].as_str().filter(|b| !b.is_empty()).map(String::from) })
        })
        .collect();
    rooms.sort_by_key(|r| r.name.to_lowercase());
    rooms
}

fn denied(e: &AppError) -> bool {
    matches!(e, AppError::Graph { status: 401 | 403, .. })
}

/// What to ask for when both lookups were refused, given what the account has granted.
pub fn next_permission(granted: &str) -> Option<Needs> {
    if !has_scope(granted, SCOPE_DIRECTORY) {
        Some(Needs { scope: SCOPE_DIRECTORY.into(), admin: false })
    } else if !has_scope(granted, SCOPE_PLACES) {
        Some(Needs { scope: SCOPE_PLACES.into(), admin: true })
    } else {
        None
    }
}

/// The `scp` claim of a work account's Graph token, for the log (no secrets in it).
fn token_scopes(token: &str) -> Option<String> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()?["scp"].as_str().map(String::from)
}

pub async fn list(state: &AppState, account_id: i64) -> Result<RoomList> {
    if state.db.with(|c| crate::db::account_provider(c, account_id))? != "microsoft" {
        return Ok(RoomList { rooms: vec![], needs: None });
    }
    if let Some((at, list)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&account_id)
        && at.elapsed() < CACHE_FOR
    {
        return Ok(list.clone());
    }
    let base = crate::graph::base();
    let beta = base.replacen("/v1.0", "/beta", 1);
    let get = |url: String| async move { crate::mail::graph_call(state, account_id, Method::GET, &url, None, &[]).await };
    let find_err = match get(format!("{beta}/me/findRooms")).await {
        Ok(v) => return Ok(remember(account_id, RoomList { rooms: parse(&v), needs: None })),
        Err(e) => e,
    };
    let places_err = match get(format!("{base}/places/microsoft.graph.room?$top=100")).await {
        Ok(v) => return Ok(remember(account_id, RoomList { rooms: parse(&v), needs: None })),
        Err(e) => e,
    };
    let granted = state.granted_scopes(account_id).await.unwrap_or_default();
    let in_token = match state.access_token(account_id).await {
        Ok(t) => token_scopes(&t).unwrap_or_else(|| "?".into()),
        Err(_) => "?".into(),
    };
    log::info!("no room list for account {account_id}: findRooms: {find_err}; places: {places_err}; asked for [{granted}]; token has [{in_token}]");
    // A personal account (Places says "not supported for MSA") or a failure that isn't about
    // permissions: nothing to offer.
    let needs = if denied(&find_err) || denied(&places_err) { next_permission(&granted) } else { None };
    // Don't hold on to a failure: a network blip or a newly approved permission should show up soon.
    Ok(RoomList { rooms: vec![], needs })
}

fn remember(account_id: i64, list: RoomList) -> RoomList {
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(account_id, (Instant::now(), list.clone()));
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_both_apis_sorted_by_name() {
        let find = json!({ "value": [{ "name": "Room 4", "address": "room4@x.com" }, { "name": "boardroom", "address": "board@x.com" }] });
        assert_eq!(parse(&find).iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["boardroom", "Room 4"]);
        let places = json!({ "value": [{ "displayName": "Huddle 1", "emailAddress": "huddle1@x.com", "capacity": 4, "building": "HQ" }, { "displayName": "No mailbox" }] });
        assert_eq!(parse(&places), vec![Room { name: "Huddle 1".into(), address: "huddle1@x.com".into(), capacity: Some(4), building: Some("HQ".into()) }]);
    }

    #[test]
    fn asks_for_the_self_service_permission_first_then_the_admin_one() {
        assert_eq!(next_permission(crate::auth::SCOPES), Some(Needs { scope: "User.ReadBasic.All".into(), admin: false }));
        let with_dir = crate::auth::merge_scopes(crate::auth::SCOPES, &["User.ReadBasic.All"]);
        assert_eq!(next_permission(&with_dir), Some(Needs { scope: "Place.Read.All".into(), admin: true }));
        assert_eq!(next_permission(&crate::auth::merge_scopes(&with_dir, &["Place.Read.All"])), None);
    }
}
