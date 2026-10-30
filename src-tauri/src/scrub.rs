//! Removes personal and secret data from text that leaves the machine (crash reports now,
//! telemetry later). PeetMail handles mail, so error strings can carry addresses, subjects,
//! tokens and provider IDs. This is the backstop: reports are built from fixed messages
//! where possible, and everything free-text goes through here on the way out.
//!
//! Known values (the signed-in accounts' addresses and names) are replaced exactly; the
//! rest is pattern-based.

use std::sync::{LazyLock, RwLock};

use regex::Regex;

static KNOWN: RwLock<Vec<String>> = RwLock::new(Vec::new());

/// Replaces the exact values to strip (account addresses and display names).
pub fn set_known(values: impl IntoIterator<Item = String>) {
    let mut v: Vec<String> = values.into_iter().map(|s| s.trim().to_string()).filter(|s| s.chars().count() >= 3).collect();
    // Longest first, so "Sam Carter" goes before "Sam".
    v.sort_by_key(|s| std::cmp::Reverse(s.len()));
    v.dedup();
    *KNOWN.write().unwrap_or_else(|e| e.into_inner()) = v;
}

struct Rule {
    re: Regex,
    with: &'static str,
}

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let rule = |re: &str, with| Rule { re: Regex::new(re).expect("scrub rule"), with };
    vec![
        // Credentials first, so later rules don't half-match them.
        rule(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [token]"),
        rule(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?", "[token]"),
        rule(
            r"(?i)\b(code|state|refresh_token|access_token|id_token|client_secret|code_verifier|password|token|login_hint|key)=[^&\s\x22']+",
            "$1=[redacted]",
        ),
        // A URL keeps its path (a route is useful); its query string goes.
        rule(r"(https?://[^\s?#\x22'<>]+)\?[^\s\x22'<>]*", "$1?[query]"),
        rule(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[email]"),
        // Windows profile paths carry the user name, which can contain spaces: take
        // everything up to the next separator, quote or line end.
        rule(r"(?i)\b([A-Z]:[\\/]+Users[\\/]+)[^\\/\x22'\r\n]+", "${1}[user]"),
        // Linux home folders (/home/ann, Fedora Atomic's /var/home/ann), the same way. Only
        // at the start of a path, so a route like /api/home/feed is left alone.
        rule(r#"(^|[\s"'=:(\[])(/(?:var/)?home/)[^/"'\r\n]+"#, "${1}${2}[user]"),
        // Provider message, thread and event IDs and other long opaque strings.
        rule(r"[A-Za-z0-9+/_=-]{40,}", "[id]"),
    ]
});

/// `text` with known values and anything that looks personal or secret replaced.
pub fn scrub(text: &str) -> String {
    let mut out = text.to_string();
    for known in KNOWN.read().unwrap_or_else(|e| e.into_inner()).iter() {
        out = replace_ignoring_case(&out, known, "[redacted]");
    }
    for rule in RULES.iter() {
        if rule.re.is_match(&out) {
            out = rule.re.replace_all(&out, rule.with).into_owned();
        }
    }
    out
}

fn replace_ignoring_case(haystack: &str, needle: &str, with: &str) -> String {
    let re = Regex::new(&format!("(?i){}", regex::escape(needle))).expect("escaped literal");
    re.replace_all(haystack, with).into_owned()
}

/// Scrubs every string inside a JSON value (keys are kept).
pub fn scrub_value(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::String(s) => *s = scrub(s),
        serde_json::Value::Array(a) => a.iter_mut().for_each(scrub_value),
        serde_json::Value::Object(o) => o.values_mut().for_each(scrub_value),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_and_names_go() {
        set_known(["Priya Nair".into(), "priya@fabrikam.io".into(), "Al".into()]);
        assert_eq!(scrub("sent to Priya Nair <priya@fabrikam.io>"), "sent to [redacted] <[redacted]>");
        assert_eq!(scrub("PRIYA NAIR replied"), "[redacted] replied", "case doesn't matter");
        assert_eq!(scrub("Also from sam.carter+news@contoso.co.uk"), "Also from [email]", "too-short names aren't stripped");
        set_known([]);
    }

    #[test]
    fn credentials_go() {
        assert_eq!(scrub("Authorization: Bearer abc.DEF-123_x"), "Authorization: Bearer [token]");
        assert_eq!(scrub("id_token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig"), "id_token [token]");
        assert_eq!(
            scrub("grant_type=refresh_token&refresh_token=0.AAA-xyz&client_id=abc"),
            "grant_type=refresh_token&refresh_token=[redacted]&client_id=abc"
        );
        assert_eq!(scrub("code=M.C123&state=xyz"), "code=[redacted]&state=[redacted]");
    }

    #[test]
    fn urls_keep_their_route() {
        assert_eq!(
            scrub("GET https://graph.microsoft.com/v1.0/me/messages?$filter=from/emailAddress/address eq 'x@y.com' failed"),
            "GET https://graph.microsoft.com/v1.0/me/messages?[query] eq '[email]' failed"
        );
        assert_eq!(scrub("http://tauri.localhost/_app/immutable/chunks/a.js:1:20"), "http://tauri.localhost/_app/immutable/chunks/a.js:1:20");
    }

    #[test]
    fn user_paths_and_ids_go() {
        assert_eq!(scrub(r"C:\Users\marti\AppData\Roaming\x.db"), r"C:\Users\[user]\AppData\Roaming\x.db");
        assert_eq!(scrub("c:/users/Jo Bloggs/Downloads/a.pdf"), "c:/users/[user]/Downloads/a.pdf");
        assert_eq!(scrub("open /home/ann lee/.local/share/x.db: denied"), "open /home/[user]/.local/share/x.db: denied");
        assert_eq!(scrub(r#"path="/var/home/sam/Downloads/q4.pdf""#), r#"path="/var/home/[user]/Downloads/q4.pdf""#);
        assert_eq!(scrub("/home/marti"), "/home/[user]");
        assert_eq!(scrub("GET /api/home/feed"), "GET /api/home/feed");
        assert_eq!(
            scrub("message AAMkADAwATM3ZmYAZS1hNjAwLTRjNDctODdlYS1iMjQ5MTYyYzQ2ZDAARgAAA not found"),
            "message [id] not found"
        );
    }

    #[test]
    fn ordinary_text_is_untouched() {
        let s = "database error: no such table: outbox (at db.rs:42)";
        assert_eq!(scrub(s), s);
    }

    #[test]
    fn json_strings_are_scrubbed_recursively() {
        let mut v = serde_json::json!({ "to": ["a@b.com"], "n": 3, "inner": { "url": "https://x.io/p?q=1" } });
        scrub_value(&mut v);
        assert_eq!(v, serde_json::json!({ "to": ["[email]"], "n": 3, "inner": { "url": "https://x.io/p?[query]" } }));
    }
}
