//! Meeting rooms of a Microsoft 365 tenant, for the event editor's location suggestions.
//!
//! `GET /beta/me/findRooms` needs only User.Read (already granted), so it works without
//! asking for more consent. The v1.0 Places API needs Place.Read.All, which requires admin
//! consent; it's tried only if findRooms fails (a tenant that granted it). Personal
//! Microsoft accounts and Google accounts have no rooms. Cached per account for a while.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use reqwest::Method;
use serde::Serialize;
use serde_json::Value;

use crate::error::Result;
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

const CACHE_FOR: Duration = Duration::from_secs(6 * 3600);
static CACHE: std::sync::LazyLock<std::sync::Mutex<HashMap<i64, (Instant, Vec<Room>)>>> = std::sync::LazyLock::new(Default::default);

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
    rooms.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    rooms
}

pub async fn list(state: &AppState, account_id: i64) -> Result<Vec<Room>> {
    if state.db.with(|c| crate::db::account_provider(c, account_id))? != "microsoft" {
        return Ok(vec![]);
    }
    if let Some((at, rooms)) = CACHE.lock().expect("rooms cache").get(&account_id) {
        if at.elapsed() < CACHE_FOR {
            return Ok(rooms.clone());
        }
    }
    let base = crate::graph::base();
    let beta = base.replacen("/v1.0", "/beta", 1);
    let get = |url: String| async move { crate::mail::graph_call(state, account_id, Method::GET, &url, None, &[]).await };
    let rooms = match get(format!("{beta}/me/findRooms")).await {
        Ok(v) => parse(&v),
        Err(e) => {
            log::info!("findRooms failed ({e}); trying the Places API");
            match get(format!("{base}/places/microsoft.graph.room?$top=100")).await {
                Ok(v) => parse(&v),
                // A personal account, or neither API allowed: no suggestions, not an error.
                Err(e) => {
                    log::info!("no room list for account {account_id}: {e}");
                    vec![]
                }
            }
        }
    };
    CACHE.lock().expect("rooms cache").insert(account_id, (Instant::now(), rooms.clone()));
    Ok(rooms)
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
}
