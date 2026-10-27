//! Thin Microsoft Graph client. Callers pass full URLs because delta/next links
//! come back from Graph as absolute URLs.

use std::time::Duration;

use reqwest::{header, Method, StatusCode};
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::telemetry::{self, attr, Key};

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
/// Quota errors wait 5, 10, 20, 40s (or the server's Retry-After) before giving up.
const QUOTA_RETRIES: u32 = 4;

/// A Google API quota / rate-limit error (as opposed to a real permission problem).
pub fn is_quota_error(body: &Value) -> bool {
    let reasons = body["error"]["errors"].as_array().into_iter().flatten().filter_map(|e| e["reason"].as_str());
    let reason_hit = reasons.into_iter().any(|r| matches!(r, "rateLimitExceeded" | "userRateLimitExceeded" | "quotaExceeded"));
    let message = body["error"]["message"].as_str().unwrap_or("");
    reason_hit || message.starts_with("Quota exceeded") || message.contains("Rate Limit Exceeded")
}

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

/// Which API a URL belongs to, for telemetry. Goes by path as well as host, so the test
/// harness's fake servers are classified like the real ones.
pub fn api_of(url: &str) -> &'static str {
    if url.contains("/gmail/") {
        "gmail"
    } else if url.contains("/calendar/v3") {
        "google_calendar"
    } else if url.contains("graph.microsoft.com") || url.contains("/v1.0/") || url.contains("/beta/") {
        "microsoft_graph"
    } else {
        "other"
    }
}

async fn send(
    http: &reqwest::Client,
    token: &str,
    method: Method,
    url: &str,
    body: Option<&Value>,
    prefer: &[&str],
) -> Result<reqwest::Response> {
    let method_name: &'static str = match method {
        Method::GET => "GET",
        Method::POST => "POST",
        Method::PATCH => "PATCH",
        Method::PUT => "PUT",
        Method::DELETE => "DELETE",
        _ => "OTHER",
    };
    let attrs = vec![attr(Key::Method, method_name), attr(Key::Route, telemetry::route_template(url)), attr(Key::Provider, api_of(url))];
    telemetry::traced("http.request", attrs, send_with_retries(http, token, method, url, body, prefer)).await
}

async fn send_with_retries(
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
        telemetry::annotate(&[attr(Key::Status, status.as_u16()), attr(Key::Attempts, attempt + 1)]);

        if status.is_success() {
            return Ok(res);
        }

        let retry_after = res
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        let throttled = status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::SERVICE_UNAVAILABLE;
        if throttled && attempt < MAX_RETRIES {
            let wait = retry_after.unwrap_or(2u64.pow(attempt));
            telemetry::count("peetmail.http.throttled", 1, &[attr(Key::Provider, api_of(url)), attr(Key::Status, status.as_u16())]);
            log::warn!("throttled ({status}), retrying in {wait}s");
            tokio::time::sleep(Duration::from_secs(wait)).await;
            attempt += 1;
            continue;
        }

        let body: Value = res.json().await.unwrap_or_default();
        let message = body["error"]["message"].as_str().unwrap_or("unknown error").to_string();
        // Google reports quota as 403 (rateLimitExceeded / "Quota exceeded"): wait longer.
        if status == StatusCode::FORBIDDEN && is_quota_error(&body) && attempt < QUOTA_RETRIES {
            let wait = retry_after.unwrap_or(5 * 2u64.pow(attempt)).min(60);
            log::warn!("quota exceeded, retrying in {wait}s: {message}");
            tokio::time::sleep(Duration::from_secs(wait)).await;
            attempt += 1;
            continue;
        }
        return Err(AppError::Graph { status: status.as_u16(), message });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_google_quota_errors_but_not_real_403s() {
        let quota = serde_json::json!({ "error": { "code": 403, "message": "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'", "status": "PERMISSION_DENIED" } });
        let rate = serde_json::json!({ "error": { "code": 403, "message": "User Rate Limit Exceeded", "errors": [{ "reason": "userRateLimitExceeded" }] } });
        let denied = serde_json::json!({ "error": { "code": 403, "message": "Insufficient Permission", "errors": [{ "reason": "insufficientPermissions" }] } });
        assert!(is_quota_error(&quota));
        assert!(is_quota_error(&rate));
        assert!(!is_quota_error(&denied));
    }
}
