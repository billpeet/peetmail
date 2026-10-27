//! Sending from Gmail. Unlike Graph's reply/forward actions, Gmail sends a complete RFC 2822
//! message we build ourselves: headers (encoded where needed), a plain-text and an HTML
//! body, the quoted original for replies and forwards, threading headers (In-Reply-To,
//! References) plus Gmail's threadId, and the original's attachments for forwards.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use reqwest::Method;
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::gmail::{self, base};
use crate::outbox::{Draft, DraftKind};
use crate::sanitize;
use crate::state::AppState;

/// Above this a message goes through the upload endpoint instead of a JSON body.
const JSON_LIMIT: usize = 4 * 1024 * 1024;

// ---------- MIME building (pure) ----------

/// A header value: as is when it's ASCII, else RFC 2047 encoded words (UTF-8, base64),
/// split so each word stays under 75 characters.
pub fn encode_header(s: &str) -> String {
    if s.is_ascii() {
        return s.to_string();
    }
    let mut words = Vec::new();
    let mut chunk = String::new();
    for ch in s.chars() {
        if chunk.len() + ch.len_utf8() > 45 {
            words.push(format!("=?UTF-8?B?{}?=", STANDARD.encode(&chunk)));
            chunk.clear();
        }
        chunk.push(ch);
    }
    if !chunk.is_empty() {
        words.push(format!("=?UTF-8?B?{}?=", STANDARD.encode(&chunk)));
    }
    words.join("\r\n ")
}

/// "Name <addr>" with the name encoded or quoted as needed.
pub fn format_address(name: Option<&str>, address: &str) -> String {
    match name.map(str::trim).filter(|n| !n.is_empty()) {
        None => address.to_string(),
        Some(n) if !n.is_ascii() => format!("{} <{address}>", encode_header(n)),
        Some(n) if n.chars().any(|c| "()<>[]:;@\\,.\"".contains(c)) => format!("\"{}\" <{address}>", n.replace('"', "\\\"")),
        Some(n) => format!("{n} <{address}>"),
    }
}

fn wrap76(b64: &str) -> String {
    b64.as_bytes().chunks(76).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect::<Vec<_>>().join("\r\n")
}

fn boundary(tag: &str) -> String {
    let mut b = [0u8; 9];
    getrandom::fill(&mut b).expect("OS RNG unavailable");
    format!("=_{tag}_{}", URL_SAFE_NO_PAD.encode(b))
}

/// A file carried along: a forwarded attachment, or an inline image of the quoted original.
#[derive(Debug, Clone)]
pub struct Part {
    pub filename: String,
    pub mime: String,
    pub data: Vec<u8>,
    /// Inline images are referenced from the HTML by cid.
    pub content_id: Option<String>,
}

pub struct Outgoing<'a> {
    pub from: String,
    pub to: &'a [String],
    pub cc: &'a [String],
    pub subject: &'a str,
    pub text: String,
    pub html: String,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub inline: Vec<Part>,
    pub attachments: Vec<Part>,
}

fn leaf(content_type: &str, extra: &str, data: &[u8]) -> String {
    format!(
        "Content-Type: {content_type}\r\nContent-Transfer-Encoding: base64\r\n{extra}\r\n{}\r\n",
        wrap76(&STANDARD.encode(data))
    )
}

fn multipart(kind: &str, tag: &str, parts: Vec<String>) -> String {
    let b = boundary(tag);
    let mut s = format!("Content-Type: multipart/{kind}; boundary=\"{b}\"\r\n\r\n");
    for p in parts {
        s.push_str(&format!("--{b}\r\n{p}"));
    }
    s.push_str(&format!("--{b}--\r\n"));
    s
}

fn file_part(p: &Part, inline: bool) -> String {
    let name = encode_header(&p.filename).replace('"', "");
    let mut extra = format!(
        "Content-Disposition: {}; filename=\"{name}\"\r\n",
        if inline { "inline" } else { "attachment" }
    );
    if let Some(cid) = &p.content_id {
        extra.push_str(&format!("Content-ID: <{cid}>\r\n"));
    }
    leaf(&format!("{}; name=\"{name}\"", p.mime), &extra, &p.data)
}

/// The whole message, CRLF line endings.
pub fn build(m: &Outgoing) -> String {
    let mut head = vec![format!("From: {}", m.from)];
    if !m.to.is_empty() {
        head.push(format!("To: {}", m.to.join(", ")));
    }
    if !m.cc.is_empty() {
        head.push(format!("Cc: {}", m.cc.join(", ")));
    }
    head.push(format!("Subject: {}", encode_header(m.subject)));
    if let Some(id) = &m.in_reply_to {
        head.push(format!("In-Reply-To: {id}"));
    }
    if let Some(refs) = &m.references {
        head.push(format!("References: {refs}"));
    }
    head.push("MIME-Version: 1.0".into());

    let alternative = multipart(
        "alternative",
        "alt",
        vec![leaf("text/plain; charset=UTF-8", "", m.text.as_bytes()), leaf("text/html; charset=UTF-8", "", m.html.as_bytes())],
    );
    let mut body = alternative;
    if !m.inline.is_empty() {
        let mut parts = vec![body];
        parts.extend(m.inline.iter().map(|p| file_part(p, true)));
        body = multipart("related", "rel", parts);
    }
    if !m.attachments.is_empty() {
        let mut parts = vec![body];
        parts.extend(m.attachments.iter().map(|p| file_part(p, false)));
        body = multipart("mixed", "mix", parts);
    }
    // The body entity starts with its own Content-Type header and blank line.
    format!("{}\r\n{body}", head.join("\r\n"))
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// "> " in front of every line, for the plain-text quote.
fn quote_text(text: &str) -> String {
    text.lines().map(|l| if l.is_empty() { ">".to_string() } else { format!("> {l}") }).collect::<Vec<_>>().join("\r\n")
}

/// What we know about the original when replying or forwarding.
pub struct Original {
    pub thread_id: Option<String>,
    pub message_id: Option<String>,
    pub references: Option<String>,
    pub from: String,
    pub to: String,
    pub cc: String,
    pub date: String,
    pub subject: String,
    /// Sanitized HTML of the original (cid images left as cid: references).
    pub html: String,
    pub text: String,
}

/// Your text plus the quoted original, as (plain text, HTML).
pub fn compose_bodies(kind: DraftKind, typed: &str, original: Option<&Original>) -> (String, String) {
    let mine_html = sanitize::compose_html(typed);
    let Some(o) = original else { return (typed.to_string(), mine_html) };
    match kind {
        DraftKind::Forward => {
            let mut head = format!("---------- Forwarded message ---------\r\nFrom: {}\r\nDate: {}\r\nSubject: {}\r\nTo: {}", o.from, o.date, o.subject, o.to);
            if !o.cc.is_empty() {
                head.push_str(&format!("\r\nCc: {}", o.cc));
            }
            let text = format!("{typed}\r\n\r\n{head}\r\n\r\n{}", o.text);
            let head_html = head.split("\r\n").map(escape).collect::<Vec<_>>().join("<br>");
            let html = format!(r#"{mine_html}<br><div class="peetmail_fwd">{head_html}<br><br>{}</div>"#, o.html);
            (text, html)
        }
        _ => {
            let attribution = format!("On {}, {} wrote:", o.date, o.from);
            let text = format!("{typed}\r\n\r\n{attribution}\r\n{}", quote_text(&o.text));
            let html = format!(
                r#"{mine_html}<br><div class="peetmail_quote"><div>{}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">{}</blockquote></div>"#,
                escape(&attribution),
                o.html
            );
            (text, html)
        }
    }
}

/// "Re: x" stays, "x" becomes "Re: x" (or "Fwd: x").
pub fn subject_for(kind: DraftKind, typed: &str, original: &str) -> String {
    if !typed.trim().is_empty() {
        return typed.to_string();
    }
    let bare = original.trim();
    match kind {
        DraftKind::Forward => format!("Fwd: {bare}"),
        DraftKind::Reply | DraftKind::ReplyAll if !bare.to_ascii_lowercase().starts_with("re:") => format!("Re: {bare}"),
        _ => bare.to_string(),
    }
}

// ---------- sending ----------

fn header_of<'a>(payload: &'a Value, name: &str) -> Option<&'a str> {
    payload["headers"]
        .as_array()?
        .iter()
        .find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
        .and_then(|h| h["value"].as_str())
}

async fn load_original(state: &AppState, account_id: i64, remote_id: &str, with_files: bool) -> Result<(Original, Vec<Part>, Vec<Part>)> {
    let v = gmail::get_message(state, account_id, remote_id, "full").await?;
    let payload = &v["payload"];
    let parts = gmail::collect_parts(payload);
    let (html, text) = match (&parts.html, &parts.text) {
        (Some((c, is_id, cs)), _) => {
            let raw = gmail::decode_charset(&gmail::content_bytes(state, account_id, remote_id, c, *is_id).await?, cs);
            let html = sanitize::clean_html(&raw);
            let text = sanitize::html_to_text(&html);
            (html, text)
        }
        (None, Some((c, is_id, cs))) => {
            let t = gmail::decode_charset(&gmail::content_bytes(state, account_id, remote_id, c, *is_id).await?, cs);
            (sanitize::text_to_html(&t), t)
        }
        _ => (String::new(), String::new()),
    };
    // Inline images keep the quote intact; attachments only travel with forwards.
    let mut inline = Vec::new();
    if html.contains("cid:") {
        for (cid, (mime, content, is_id)) in &parts.inline {
            if html.contains(&format!("cid:{cid}")) {
                let data = gmail::content_bytes(state, account_id, remote_id, content, *is_id).await?;
                inline.push(Part { filename: cid.clone(), mime: mime.clone(), data, content_id: Some(cid.clone()) });
            }
        }
    }
    let mut attachments = Vec::new();
    if with_files {
        for a in &parts.attachments {
            let data = gmail::attachment(state, account_id, remote_id, &a.id).await?;
            attachments.push(Part { filename: a.name.clone(), mime: a.content_type.clone(), data, content_id: None });
        }
    }
    let h = |n: &str| header_of(payload, n).map(gmail::decode_words).unwrap_or_default();
    let original = Original {
        thread_id: v["threadId"].as_str().map(String::from),
        message_id: header_of(payload, "Message-ID").or_else(|| header_of(payload, "Message-Id")).map(String::from),
        references: header_of(payload, "References").map(String::from),
        from: h("From"),
        to: h("To"),
        cc: h("Cc"),
        date: h("Date"),
        subject: h("Subject"),
        html,
        text,
    };
    Ok((original, inline, attachments))
}

/// Sends a draft from a Gmail account. `reply_to` is the original's Gmail id for replies
/// and forwards.
pub async fn send(state: &AppState, account_id: i64, reply_to: Option<&str>, d: &Draft) -> Result<Value> {
    let account = state
        .db
        .with(|c| crate::db::list_accounts(c))?
        .into_iter()
        .find(|a| a.id == account_id)
        .ok_or_else(|| AppError::Other("unknown account".into()))?;
    let from = format_address(account.display_name.as_deref(), &account.email);

    let (original, inline, attachments) = match (d.kind, reply_to) {
        (DraftKind::New, _) => (None, vec![], vec![]),
        (kind, Some(rid)) => {
            let (o, i, a) = load_original(state, account_id, rid, kind == DraftKind::Forward).await?;
            (Some(o), i, a)
        }
        (_, None) => return Err(AppError::Graph { status: 400, message: "reply has no original message".into() }),
    };

    let mut to = d.to.clone();
    if to.is_empty() && matches!(d.kind, DraftKind::Reply | DraftKind::ReplyAll)
        && let Some(o) = &original {
        to.push(o.from.clone());
    }
    let subject = subject_for(d.kind, &d.subject, original.as_ref().map(|o| o.subject.as_str()).unwrap_or(""));
    let (text, html) = compose_bodies(d.kind, &d.body, original.as_ref());
    let threading = original.as_ref().filter(|_| d.kind != DraftKind::Forward);
    let in_reply_to = threading.and_then(|o| o.message_id.clone());
    let references = threading.and_then(|o| match (&o.references, &o.message_id) {
        (Some(r), Some(id)) => Some(format!("{r} {id}")),
        (None, Some(id)) => Some(id.clone()),
        _ => None,
    });
    let raw = build(&Outgoing { from, to: &to, cc: &d.cc, subject: &subject, text, html, in_reply_to, references, inline, attachments });
    // Replies stay in the original's Gmail thread; forwards start a new one, like Gmail does.
    let thread_id = threading.and_then(|o| o.thread_id.clone());

    if raw.len() <= JSON_LIMIT {
        let mut body = json!({ "raw": URL_SAFE_NO_PAD.encode(raw.as_bytes()) });
        if let Some(t) = &thread_id {
            body["threadId"] = json!(t);
        }
        gmail::call(state, account_id, Method::POST, &format!("{}/messages/send", base()), Some(&body)).await
    } else {
        upload(state, account_id, &raw, thread_id.as_deref()).await
    }
}

/// Big messages: the upload endpoint, multipart (JSON metadata + the message).
async fn upload(state: &AppState, account_id: i64, raw: &str, thread_id: Option<&str>) -> Result<Value> {
    let url = format!("{}/messages/send?uploadType=multipart", base().replacen("/gmail/v1/", "/upload/gmail/v1/", 1));
    let b = boundary("up");
    let meta = match thread_id {
        Some(t) => json!({ "threadId": t }),
        None => json!({}),
    };
    let body = format!(
        "--{b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{b}\r\nContent-Type: message/rfc822\r\n\r\n{raw}\r\n--{b}--\r\n"
    );
    for attempt in 0..2 {
        let token = state.access_token(account_id).await?;
        let res = state
            .http
            .post(&url)
            .bearer_auth(&token)
            .header("Content-Type", format!("multipart/related; boundary={b}"))
            .body(body.clone())
            .send()
            .await?;
        let status = res.status();
        if status.as_u16() == 401 && attempt == 0 {
            state.invalidate_access_token(account_id).await;
            continue;
        }
        let v: Value = res.json().await.unwrap_or_default();
        if !status.is_success() {
            return Err(AppError::Graph { status: status.as_u16(), message: v["error"]["message"].as_str().unwrap_or("upload failed").into() });
        }
        return Ok(v);
    }
    Err(AppError::Other("upload failed".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_are_encoded_only_when_needed() {
        assert_eq!(encode_header("Hello"), "Hello");
        assert_eq!(encode_header("Café"), "=?UTF-8?B?Q2Fmw6k=?=");
        let long = encode_header(&"é".repeat(40));
        assert!(long.split("\r\n ").all(|w| w.len() <= 75), "{long}");
        assert_eq!(crate::gmail::decode_words(&long.replace("\r\n", "")), "é".repeat(40));
        assert_eq!(format_address(Some("Boris Dragon"), "b@x.com"), "Boris Dragon <b@x.com>");
        assert_eq!(format_address(Some("Nair, Priya"), "p@x.com"), "\"Nair, Priya\" <p@x.com>");
        assert_eq!(format_address(Some("Zoë"), "z@x.com"), "=?UTF-8?B?Wm/Dqw==?= <z@x.com>");
        assert_eq!(format_address(None, "z@x.com"), "z@x.com");
    }

    #[test]
    fn subjects_for_replies_and_forwards() {
        assert_eq!(subject_for(DraftKind::Reply, "", "Lunch"), "Re: Lunch");
        assert_eq!(subject_for(DraftKind::Reply, "", "Re: Lunch"), "Re: Lunch");
        assert_eq!(subject_for(DraftKind::Forward, "", "Lunch"), "Fwd: Lunch");
        assert_eq!(subject_for(DraftKind::Reply, "RE: Lunch", "Lunch"), "RE: Lunch");
    }

    fn original() -> Original {
        Original {
            thread_id: Some("t1".into()),
            message_id: Some("<a@x>".into()),
            references: Some("<z@x>".into()),
            from: "Kim Park <kim@x>".into(),
            to: "me@gmail.com".into(),
            cc: String::new(),
            date: "Mon, 26 Oct 2026 10:00:00 +1100".into(),
            subject: "Trip".into(),
            html: "<p>Keen?</p>".into(),
            text: "Keen?\n\nKim".into(),
        }
    }

    #[test]
    fn replies_quote_and_forwards_carry_the_original() {
        let (text, html) = compose_bodies(DraftKind::Reply, "Yes!", Some(&original()));
        assert!(text.starts_with("Yes!\r\n\r\nOn Mon, 26 Oct 2026 10:00:00 +1100, Kim Park <kim@x> wrote:\r\n> Keen?\r\n>\r\n> Kim"), "{text}");
        assert!(html.contains("<blockquote") && html.contains("<p>Keen?</p>") && html.contains("Kim Park &lt;kim@x&gt; wrote:"));
        let (text, html) = compose_bodies(DraftKind::Forward, "FYI", Some(&original()));
        assert!(text.contains("---------- Forwarded message ---------\r\nFrom: Kim Park <kim@x>"));
        assert!(html.contains("Subject: Trip") && html.contains("<p>Keen?</p>"));
    }

    #[test]
    fn builds_a_well_formed_message() {
        let to = vec!["Kim Park <kim@x>".to_string()];
        let raw = build(&Outgoing {
            from: "Boris <b@gmail.com>".into(),
            to: &to,
            cc: &[],
            subject: "Re: Café",
            text: "Yes".into(),
            html: "<p>Yes</p>".into(),
            in_reply_to: Some("<a@x>".into()),
            references: Some("<z@x> <a@x>".into()),
            inline: vec![Part { filename: "logo".into(), mime: "image/png".into(), data: vec![1, 2, 3], content_id: Some("logo@x".into()) }],
            attachments: vec![Part { filename: "plan.pdf".into(), mime: "application/pdf".into(), data: b"%PDF".to_vec(), content_id: None }],
        });
        let (head, body) = raw.split_once("\r\n\r\n").expect("blank line after the headers");
        assert!(head.contains("Subject: =?UTF-8?B?UmU6IENhZsOp?="));
        assert!(head.contains("In-Reply-To: <a@x>\r\nReferences: <z@x> <a@x>"));
        assert!(head.contains("MIME-Version: 1.0\r\nContent-Type: multipart/mixed;"), "{head}");
        assert!(body.contains("Content-Type: multipart/related;") && body.contains("Content-Type: multipart/alternative;"));
        assert!(body.contains("Content-ID: <logo@x>") && body.contains("filename=\"plan.pdf\""));
        assert!(body.contains(&STANDARD.encode("<p>Yes</p>")));
        assert!(!raw.contains("\n\n") || raw.matches("\r\n\r\n").count() > 0);
        assert!(raw.lines().all(|l| l.len() <= 998));
    }
}
