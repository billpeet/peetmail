//! Thin Microsoft Graph client. Callers pass full URLs because delta/next links
//! come back from Graph as absolute URLs.

use std::time::Duration;

use reqwest::{header, Method, StatusCode};
use serde_json::Value;

use crate::error::{AppError, Result};

const DEFAULT_BASE: &str = "https://graph.microsoft.com/v1.0";

static BASE: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    crate::testenv::get("PEETMAIL_GRAPH_URL").unwrap_or_else(|| DEFAULT_BASE.to_string())
});

/// Graph base URL. Overridable in debug builds so tests can use the fake server.
pub fn base() -> &'static str {
    &BASE
}

/// Immutable IDs survive moves between folders, so an archived message keeps its id.
pub const PREFER_IMMUTABLE: &str = r#"IdType="ImmutableId""#;

const MAX_RETRIES: u32 = 5;

pub async fn get(http: &reqwest::Client, token: &str, url: &str, prefer: &[&str]) -> Result<Value> {
    request(http, token, Method::GET, url, None, prefer).await
}

/// Sends a request, retrying 429/503 after Retry-After. 202/204 responses (sendMail,
/// reply, PATCH without return) come back as `Value::Null`.
pub async fn request(
    http: &reqwest::Client,
    token: &str,
    method: Method,
    url: &str,
    body: Option<&Value>,
    prefer: &[&str],
) -> Result<Value> {
    let res = send(http, token, method, url, body, prefer).await?;
    let text = res.text().await?;
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(&text)?)
}

/// GET returning raw bytes (attachment `$value`, images).
pub async fn get_bytes(http: &reqwest::Client, token: &str, url: &str) -> Result<Vec<u8>> {
    let res = send(http, token, Method::GET, url, None, &[]).await?;
    Ok(res.bytes().await?.to_vec())
}

async fn send(
    http: &reqwest::Client,
    token: &str,
    method: Method,
    url: &str,
    body: Option<&Value>,
    prefer: &[&str],
) -> Result<reqwest::Response> {
    let mut attempt = 0;
    loop {
        let mut req = http
            .request(method.clone(), url)
            .bearer_auth(token)
            .header(header::ACCEPT, "application/json");
        if !prefer.is_empty() {
            req = req.header("Prefer", prefer.join(", "));
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let res = req.send().await?;
        let status = res.status();

        if status.is_success() {
            return Ok(res);
        }

        let throttled = status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::SERVICE_UNAVAILABLE;
        if throttled && attempt < MAX_RETRIES {
            let wait = res
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(2u64.pow(attempt));
            log::warn!("graph throttled ({status}), retrying in {wait}s");
            tokio::time::sleep(Duration::from_secs(wait)).await;
            attempt += 1;
            continue;
        }

        let body: Value = res.json().await.unwrap_or_default();
        let message = body["error"]["message"].as_str().unwrap_or("unknown error").to_string();
        return Err(AppError::Graph { status: status.as_u16(), message });
    }
}
