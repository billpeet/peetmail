//! Microsoft identity platform sign-in: authorization code + PKCE over a loopback redirect.
//! PeetMail is a public client, so there is no client secret.

use std::collections::HashMap;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

use crate::error::{AppError, Result};

/// `common` accepts both work/school (M365) and personal (outlook.com) accounts.
const DEFAULT_AUTHORITY: &str = "https://login.microsoftonline.com/common/oauth2/v2.0";

static AUTHORITY: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    crate::testenv::get("PEETMAIL_AUTHORITY_URL").unwrap_or_else(|| DEFAULT_AUTHORITY.to_string())
});

/// Requested up front so later phases (send, calendar) don't need a second consent prompt.
pub const SCOPES: &str =
    "offline_access openid profile email User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite";

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds.
    pub expires_at: i64,
}

impl TokenSet {
    pub fn expires_soon(&self) -> bool {
        self.expires_at - chrono::Utc::now().timestamp() < 300
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
    error_description: Option<String>,
}

fn random_b64(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS RNG unavailable");
    URL_SAFE_NO_PAD.encode(buf)
}

pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Opens the system browser, waits for the redirect, and exchanges the code for tokens.
/// Resolves early with an error if `cancel` fires (user pressed Esc, or started another sign-in).
pub async fn sign_in(
    app: &AppHandle,
    http: &reqwest::Client,
    client_id: &str,
    cancel: tokio::sync::oneshot::Receiver<()>,
) -> Result<TokenSet> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    // Entra allows any port on a registered `http://localhost` redirect for desktop apps.
    let redirect_uri = format!("http://localhost:{port}");
    let verifier = random_b64(64);
    let state = random_b64(16);

    let auth_url = Url::parse_with_params(
        &format!("{}/authorize", *AUTHORITY),
        &[
            ("client_id", client_id),
            ("response_type", "code"),
            ("redirect_uri", &redirect_uri),
            ("response_mode", "query"),
            ("scope", SCOPES),
            ("state", &state),
            ("code_challenge", &pkce_challenge(&verifier)),
            ("code_challenge_method", "S256"),
            ("prompt", "select_account"),
        ],
    )
    .map_err(|e| AppError::Auth(e.to_string()))?;

    if crate::testenv::flag("PEETMAIL_AUTH_AUTOFOLLOW") {
        // Test harness: the fake authority redirects straight back to the loopback listener.
        let http = http.clone();
        let url = auth_url.to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = http.get(url).send().await {
                log::error!("auth autofollow failed: {e}");
            }
        });
    } else {
        app.opener()
            .open_url(auth_url.as_str(), None::<&str>)
            .map_err(|e| AppError::Auth(format!("could not open browser: {e}")))?;
    }

    // A wrong client ID shows an error page in the browser and never redirects back,
    // so cancellation is the only way out short of the timeout.
    let code = tokio::select! {
        r = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_code(listener, &state)) => {
            r.map_err(|_| AppError::Auth("timed out waiting for the browser".into()))??
        }
        _ = cancel => return Err(AppError::Auth("cancelled".into())),
    };

    let form = [
        ("client_id", client_id),
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", &redirect_uri),
        ("code_verifier", &verifier),
        ("scope", SCOPES),
    ];
    token_request(http, &form, None).await
}

pub async fn refresh(http: &reqwest::Client, client_id: &str, refresh_token: &str) -> Result<TokenSet> {
    let form = [
        ("client_id", client_id),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("scope", SCOPES),
    ];
    token_request(http, &form, Some(refresh_token)).await
}

async fn token_request(http: &reqwest::Client, form: &[(&str, &str)], old_refresh: Option<&str>) -> Result<TokenSet> {
    // No Origin header here: Entra treats requests with one as SPA traffic and rejects them.
    let res = http.post(format!("{}/token", *AUTHORITY)).form(form).send().await?;
    if !res.status().is_success() {
        let err: TokenError = res.json().await?;
        return Err(AppError::Auth(format!(
            "{}: {}",
            err.error,
            err.error_description.unwrap_or_default().lines().next().unwrap_or_default()
        )));
    }
    let t: TokenResponse = res.json().await?;
    let refresh_token = t
        .refresh_token
        .or_else(|| old_refresh.map(String::from))
        .ok_or_else(|| AppError::Auth("no refresh token returned (is offline_access granted?)".into()))?;
    Ok(TokenSet {
        access_token: t.access_token,
        refresh_token,
        expires_at: chrono::Utc::now().timestamp() + t.expires_in,
    })
}

async fn wait_for_code(listener: TcpListener, expected_state: &str) -> Result<String> {
    loop {
        let (mut sock, _) = listener.accept().await?;
        let mut buf = vec![0u8; 16 * 1024];
        let n = sock.read(&mut buf).await?;
        let req = String::from_utf8_lossy(&buf[..n]);
        let params = parse_redirect(&req);

        if !params.contains_key("code") && !params.contains_key("error") {
            // favicon.ico and other stray requests
            let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }

        let outcome = if let Some(err) = params.get("error") {
            Err(AppError::Auth(format!("{err}: {}", params.get("error_description").cloned().unwrap_or_default())))
        } else if params.get("state").map(String::as_str) != Some(expected_state) {
            Err(AppError::Auth("state mismatch".into()))
        } else {
            Ok(params["code"].clone())
        };

        let message = match &outcome {
            Ok(_) => "Signed in. You can close this tab and go back to PeetMail.",
            Err(_) => "Sign-in failed. Go back to PeetMail for details.",
        };
        let body = format!(
            "<!doctype html><meta charset=utf-8><title>PeetMail</title>\
             <body style=\"font:16px system-ui;background:#0b0b0d;color:#e7e7ea;display:grid;place-items:center;height:100vh;margin:0\">\
             <p>{message}</p>"
        );
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        return outcome;
    }
}

fn parse_redirect(request: &str) -> HashMap<String, String> {
    let path = request.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
    Url::parse(&format!("http://localhost{path}"))
        .map(|u| u.query_pairs().into_owned().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn parses_redirect_query() {
        let p = parse_redirect("GET /?code=abc%2F1&state=xyz HTTP/1.1\r\nHost: localhost\r\n\r\n");
        assert_eq!(p["code"], "abc/1");
        assert_eq!(p["state"], "xyz");
        assert!(parse_redirect("GET /favicon.ico HTTP/1.1\r\n").is_empty());
    }
}
