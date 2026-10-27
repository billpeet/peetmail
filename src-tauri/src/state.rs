use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::auth::{self, TokenSet};
use crate::db::{self, Db};
use crate::error::{AppError, Result};
use crate::secure;

pub const KEY_CLIENT_ID: &str = "ms_client_id";
pub const KEY_GOOGLE_CLIENT_ID: &str = "google_client_id";
pub const KEY_GOOGLE_CLIENT_SECRET: &str = "google_client_secret";
pub const KEY_CACHE_DAYS: &str = "cache_days";
pub const KEY_BODY_CACHE_MB: &str = "body_cache_mb";

pub const KEY_SPLITS: &str = "splits";
pub const KEY_HIDE_EMPTY_SPLITS: &str = "hide_empty_splits";
pub const KEY_SHOW_RIGHT_PANE: &str = "show_right_pane";
pub const KEY_RIGHT_PANE_WIDTH: &str = "right_pane_width";
pub const DEFAULT_RIGHT_PANE_WIDTH: i64 = 320;
pub const KEY_LAYOUT: &str = "layout";
pub const KEY_LIST_WIDTH: &str = "list_width";
pub const DEFAULT_LIST_WIDTH: i64 = 420;
pub const KEY_RIGHT_PANE_TAB: &str = "right_pane_tab";
pub const KEY_WEEK_STARTS_ON: &str = "week_starts_on";
pub const KEY_UNDO_SEND_SECS: &str = "undo_send_secs";
pub const KEY_NOTIFY: &str = "notify";
pub const KEY_CLOSE_TO_TRAY: &str = "close_to_tray";
pub const DEFAULT_UNDO_SEND_SECS: i64 = 10;

pub const DEFAULT_CACHE_DAYS: i64 = 90;
pub const DEFAULT_BODY_CACHE_MB: i64 = 500;

pub struct AppState {
    pub db: Db,
    pub http: reqwest::Client,
    tokens: tokio::sync::Mutex<HashMap<i64, TokenSet>>,
    /// Serializes sync runs so the timer and "sync now" never overlap.
    pub sync_lock: tokio::sync::Mutex<()>,
    /// Cancels the sign-in currently waiting on the browser, if any.
    pub sign_in_cancel: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// Held while the outbox worker drains, so only one drain runs.
    pub outbox_lock: tokio::sync::Mutex<()>,
    /// Most recent undoable actions, newest last.
    pub undo: std::sync::Mutex<Vec<crate::actions::UndoEntry>>,
    /// Held while bodies are prefetched in the background, so runs don't pile up.
    pub prefetch_lock: tokio::sync::Mutex<()>,
}

/// UI preferences that live in the settings table.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    /// Hide split tabs with no conversations (the Inbox tab always shows).
    pub hide_empty_splits: bool,
    /// Show the right-hand pane (Recent Opens). On by default.
    pub show_right_pane: bool,
    /// Right pane width in CSS pixels (the UI clamps it to fit the window).
    pub right_pane_width: i64,
    /// "list" (list, Enter opens a conversation) or "preview" (list + reading pane).
    pub layout: String,
    /// Width of the list in the preview layout, in CSS pixels.
    pub list_width: i64,
    /// What the right pane shows: "calendar" (day view, the default) or "recent" (Recent Opens).
    pub right_pane_tab: String,
    /// First day of the week in the calendar: 0 = Sunday, 1 = Monday ... 6 = Saturday.
    pub week_starts_on: i64,
    /// How long a sent message waits, so it can be undone. 0 sends at once.
    pub undo_send_secs: i64,
    /// New-mail notifications: "off", "focused" (default; not Other) or "all".
    pub notify: String,
    /// Closing the window keeps PeetMail running in the tray (default on).
    pub close_to_tray: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheLimits {
    /// Only mail received in the last N days is cached locally.
    pub cache_days: i64,
    /// Upper bound for cached message bodies; least-recently-read are evicted first.
    pub body_cache_mb: i64,
}

impl AppState {
    pub fn new(db: Db) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("PeetMail/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Self {
            db,
            http,
            tokens: Default::default(),
            sync_lock: Default::default(),
            sign_in_cancel: Default::default(),
            outbox_lock: Default::default(),
            undo: Default::default(),
            prefetch_lock: Default::default(),
        }
    }

    pub fn client_id(&self) -> Result<Option<String>> {
        let stored = self.db.with(|c| db::get_setting(c, KEY_CLIENT_ID))?;
        Ok(stored
            .or_else(|| option_env!("PEETMAIL_MS_CLIENT_ID").map(String::from))
            .filter(|s| !s.trim().is_empty()))
    }

    /// Google OAuth client (ID, secret). The secret of a Desktop-app client isn't
    /// confidential (Google says so), but Google may still require it on token requests.
    pub fn google_client(&self) -> Result<Option<(String, Option<String>)>> {
        let (id, secret) = self.db.with(|c| Ok((db::get_setting(c, KEY_GOOGLE_CLIENT_ID)?, db::get_setting(c, KEY_GOOGLE_CLIENT_SECRET)?)))?;
        let id = id.or_else(|| option_env!("PEETMAIL_GOOGLE_CLIENT_ID").map(String::from)).filter(|s| !s.trim().is_empty());
        let secret = secret.or_else(|| option_env!("PEETMAIL_GOOGLE_CLIENT_SECRET").map(String::from)).filter(|s| !s.trim().is_empty());
        Ok(id.map(|id| (id, secret)))
    }

    /// How an account's provider signs in and refreshes.
    pub fn oauth_for(&self, provider: &str) -> Result<auth::OAuthConfig> {
        if provider == "google" {
            let (id, secret) = self.google_client()?.ok_or_else(|| AppError::Other("no Google client ID configured".into()))?;
            Ok(auth::OAuthConfig::google(&id, secret.as_deref()))
        } else {
            Ok(auth::OAuthConfig::microsoft(&self.require_client_id()?))
        }
    }

    pub fn require_client_id(&self) -> Result<String> {
        self.client_id()?
            .ok_or_else(|| AppError::Other("no Microsoft client ID configured".into()))
    }

    pub fn cache_limits(&self) -> Result<CacheLimits> {
        self.db.with(|c| {
            let get = |k, d: i64| -> Result<i64> {
                Ok(db::get_setting(c, k)?.and_then(|v| v.parse().ok()).unwrap_or(d))
            };
            Ok(CacheLimits {
                cache_days: get(KEY_CACHE_DAYS, DEFAULT_CACHE_DAYS)?,
                body_cache_mb: get(KEY_BODY_CACHE_MB, DEFAULT_BODY_CACHE_MB)?,
            })
        })
    }

    pub fn preferences(&self) -> Result<Preferences> {
        self.db.with(|c| {
            Ok(Preferences {
                hide_empty_splits: db::get_setting(c, KEY_HIDE_EMPTY_SPLITS)?.as_deref() == Some("1"),
                show_right_pane: db::get_setting(c, KEY_SHOW_RIGHT_PANE)?.as_deref() != Some("0"),
                right_pane_width: db::get_setting(c, KEY_RIGHT_PANE_WIDTH)?
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(DEFAULT_RIGHT_PANE_WIDTH),
                layout: match db::get_setting(c, KEY_LAYOUT)?.as_deref() {
                    Some("preview") => "preview".into(),
                    _ => "list".into(),
                },
                list_width: db::get_setting(c, KEY_LIST_WIDTH)?.and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_LIST_WIDTH),
                right_pane_tab: match db::get_setting(c, KEY_RIGHT_PANE_TAB)?.as_deref() {
                    // Calendar unless Recent Opens was chosen.
                    Some("recent") => "recent".into(),
                    _ => "calendar".into(),
                },
                week_starts_on: db::get_setting(c, KEY_WEEK_STARTS_ON)?
                    .and_then(|v| v.parse::<i64>().ok())
                    .filter(|d| (0..7).contains(d))
                    .unwrap_or(1),
                undo_send_secs: db::get_setting(c, KEY_UNDO_SEND_SECS)?
                    .or_else(|| crate::testenv::get("PEETMAIL_UNDO_SEND_SECS"))
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|s| s.clamp(0, 60))
                    .unwrap_or(DEFAULT_UNDO_SEND_SECS),
                notify: match db::get_setting(c, KEY_NOTIFY)?.as_deref() {
                    Some("off") => "off".into(),
                    Some("all") => "all".into(),
                    _ => "focused".into(),
                },
                close_to_tray: db::get_setting(c, KEY_CLOSE_TO_TRAY)?.as_deref() != Some("0"),
            })
        })
    }

    pub fn set_preferences(&self, p: &Preferences) -> Result<()> {
        let flag = |b: bool| if b { "1" } else { "0" };
        self.db.with(|c| {
            db::set_setting(c, KEY_HIDE_EMPTY_SPLITS, flag(p.hide_empty_splits))?;
            db::set_setting(c, KEY_SHOW_RIGHT_PANE, flag(p.show_right_pane))?;
            db::set_setting(c, KEY_RIGHT_PANE_WIDTH, &p.right_pane_width.clamp(160, 2000).to_string())?;
            db::set_setting(c, KEY_LAYOUT, if p.layout == "preview" { "preview" } else { "list" })?;
            db::set_setting(c, KEY_LIST_WIDTH, &p.list_width.clamp(200, 2000).to_string())?;
            db::set_setting(c, KEY_RIGHT_PANE_TAB, if p.right_pane_tab == "recent" { "recent" } else { "calendar" })?;
            db::set_setting(c, KEY_WEEK_STARTS_ON, &p.week_starts_on.rem_euclid(7).to_string())?;
            db::set_setting(c, KEY_UNDO_SEND_SECS, &p.undo_send_secs.clamp(0, 60).to_string())?;
            db::set_setting(c, KEY_NOTIFY, match p.notify.as_str() { "off" => "off", "all" => "all", _ => "focused" })?;
            db::set_setting(c, KEY_CLOSE_TO_TRAY, flag(p.close_to_tray))
        })
    }

    pub fn store_tokens_blob(tokens: &TokenSet) -> Result<Vec<u8>> {
        secure::protect(&serde_json::to_vec(tokens)?)
    }

    pub async fn remember_tokens(&self, account_id: i64, tokens: TokenSet) {
        self.tokens.lock().await.insert(account_id, tokens);
    }

    /// Marks the cached access token as expired so the next call refreshes it.
    /// Loads from the DB first so the refresh token survives.
    pub async fn invalidate_access_token(&self, account_id: i64) {
        let mut cache = self.tokens.lock().await;
        if let Some(t) = cache.get_mut(&account_id) {
            t.expires_at = 0;
        } else if let Ok(Some(blob)) = self.db.with(|c| db::get_token_blob(c, account_id))
            && let Ok(mut t) = secure::unprotect(&blob).and_then(|b| Ok(serde_json::from_slice::<TokenSet>(&b)?)) {
            t.expires_at = 0;
            cache.insert(account_id, t);
        }
    }

    pub async fn forget_all_tokens(&self) {
        self.tokens.lock().await.clear();
    }

    pub async fn forget_tokens(&self, account_id: i64) {
        self.tokens.lock().await.remove(&account_id);
    }

    /// The scopes an account's tokens were granted (the provider's defaults for older sign-ins).
    pub async fn granted_scopes(&self, account_id: i64) -> Result<String> {
        self.access_token(account_id).await?;
        let provider = self.db.with(|c| db::account_provider(c, account_id))?;
        let cached = self.tokens.lock().await.get(&account_id).and_then(|t| t.scopes.clone());
        Ok(match cached {
            Some(s) => s,
            None => self.oauth_for(&provider)?.scopes().to_string(),
        })
    }

    /// Returns a valid access token, refreshing and persisting a new token set if needed.
    pub async fn access_token(&self, account_id: i64) -> Result<String> {
        let mut cache = self.tokens.lock().await;
        let current = match cache.get(&account_id) {
            Some(t) => t.clone(),
            None => {
                let blob = self
                    .db
                    .with(|c| db::get_token_blob(c, account_id))?
                    .ok_or_else(|| AppError::Auth("account has no stored credentials".into()))?;
                serde_json::from_slice(&secure::unprotect(&blob)?)?
            }
        };
        if !current.expires_soon() {
            cache.insert(account_id, current.clone());
            return Ok(current.access_token);
        }
        let provider = self.db.with(|c| db::account_provider(c, account_id))?;
        let fresh = auth::refresh(&self.http, &self.oauth_for(&provider)?, &current).await?;
        let blob = Self::store_tokens_blob(&fresh)?;
        self.db.with(|c| db::set_token_blob(c, account_id, &blob))?;
        let token = fresh.access_token.clone();
        cache.insert(account_id, fresh);
        Ok(token)
    }
}
