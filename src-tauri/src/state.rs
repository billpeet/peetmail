use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::auth::{self, TokenSet};
use crate::db::{self, Db};
use crate::error::{AppError, Result};
use crate::secure;

pub const KEY_CLIENT_ID: &str = "ms_client_id";
pub const KEY_CACHE_DAYS: &str = "cache_days";
pub const KEY_BODY_CACHE_MB: &str = "body_cache_mb";

pub const KEY_SPLITS: &str = "splits";

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
        } else if let Ok(Some(blob)) = self.db.with(|c| db::get_token_blob(c, account_id)) {
            if let Ok(mut t) = secure::unprotect(&blob).and_then(|b| Ok(serde_json::from_slice::<TokenSet>(&b)?)) {
                t.expires_at = 0;
                cache.insert(account_id, t);
            }
        }
    }

    pub async fn forget_all_tokens(&self) {
        self.tokens.lock().await.clear();
    }

    pub async fn forget_tokens(&self, account_id: i64) {
        self.tokens.lock().await.remove(&account_id);
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
        let client_id = self.require_client_id()?;
        let fresh = auth::refresh(&self.http, &client_id, &current.refresh_token).await?;
        let blob = Self::store_tokens_blob(&fresh)?;
        self.db.with(|c| db::set_token_blob(c, account_id, &blob))?;
        let token = fresh.access_token.clone();
        cache.insert(account_id, fresh);
        Ok(token)
    }
}
