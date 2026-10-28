//! Sending from a Microsoft account when files are involved. A plain message is one Graph
//! call (sendMail, reply, replyAll, forward; see `outbox::send_request`). With attachments
//! it's a draft: create it (createReply etc. still thread and quote the original), take out
//! any forwarded attachments the user removed, add each file (inline under 3 MB, an upload
//! session above), then send the draft. A failure part-way deletes the draft again.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use reqwest::Method;
use serde_json::{json, Value};

use crate::draft_files::{self, DraftFile};
use crate::error::{AppError, Result};
use crate::graph::{self, PREFER_IMMUTABLE};
use crate::mail::graph_call;
use crate::outbox::{send_request, Draft, DraftKind};
use crate::state::AppState;

/// Graph takes a file in the attachment request itself only below 3 MB.
const INLINE_LIMIT: usize = 3 * 1024 * 1024;
/// Upload session chunks must be multiples of 320 KiB (and under 4 MB).
const CHUNK: usize = 10 * 320 * 1024;
const _: () = assert!(CHUNK.is_multiple_of(320 * 1024) && CHUNK < 4 * 1024 * 1024);

/// Where the draft is created, and with what: the same content as the one-call send.
pub fn draft_request(base: &str, reply_to: Option<&str>, d: &Draft) -> Result<(String, Value)> {
    let (_, url, body) = send_request(base, reply_to, d)?;
    Ok(match d.kind {
        DraftKind::New => (format!("{base}/me/messages"), body["message"].clone()),
        _ => {
            // .../reply -> .../createReply, replyAll -> createReplyAll, forward -> createForward
            let (head, action) = url.rsplit_once('/').ok_or_else(|| AppError::Other("bad send url".into()))?;
            let mut create = String::from("create");
            let mut chars = action.chars();
            create.extend(chars.next().map(|c| c.to_ascii_uppercase()));
            create.push_str(chars.as_str());
            (format!("{head}/{create}"), body)
        }
    })
}

/// The body that adds a small file to a draft.
pub fn file_attachment(f: &DraftFile, data: &[u8]) -> Value {
    json!({
        "@odata.type": "#microsoft.graph.fileAttachment",
        "name": f.name,
        "contentType": f.mime,
        "contentBytes": STANDARD.encode(data),
    })
}

/// Content-Range headers for uploading `total` bytes in chunks: (start, end inclusive).
pub fn chunks(total: usize) -> Vec<(usize, usize)> {
    (0..total).step_by(CHUNK).map(|start| (start, (start + CHUNK).min(total) - 1)).collect()
}

pub async fn send(state: &AppState, account_id: i64, reply_to: Option<&str>, d: &Draft) -> Result<Value> {
    let base = graph::base();
    let (url, body) = draft_request(base, reply_to, d)?;
    let created = graph_call(state, account_id, Method::POST, &url, Some(&body), &[PREFER_IMMUTABLE]).await?;
    let id = created["id"].as_str().ok_or_else(|| AppError::Other("Graph returned a draft without an id".into()))?;
    let msg = format!("{base}/me/messages/{id}");
    let result = fill_and_send(state, account_id, &msg, d).await;
    if result.is_err() {
        // Don't leave a half-built copy in Drafts; a retry starts over.
        if let Err(e) = graph_call(state, account_id, Method::DELETE, &msg, None, &[PREFER_IMMUTABLE]).await {
            log::warn!("couldn't delete an unsent draft: {e}");
        }
    }
    result
}

async fn fill_and_send(state: &AppState, account_id: i64, msg: &str, d: &Draft) -> Result<Value> {
    if d.kind == DraftKind::Forward && !d.dropped_attachments.is_empty() {
        let list = graph_call(state, account_id, Method::GET, &format!("{msg}/attachments?$select=id,name,isInline"), None, &[PREFER_IMMUTABLE]).await?;
        for a in list["value"].as_array().into_iter().flatten() {
            let name = a["name"].as_str().unwrap_or_default();
            if !a["isInline"].as_bool().unwrap_or(false) && d.dropped_attachments.iter().any(|n| n == name)
                && let Some(aid) = a["id"].as_str() {
                graph_call(state, account_id, Method::DELETE, &format!("{msg}/attachments/{aid}"), None, &[PREFER_IMMUTABLE]).await?;
            }
        }
    }
    for f in &d.attachments {
        let data = state.db.with(|c| draft_files::for_send(c, f))?;
        if data.len() < INLINE_LIMIT {
            graph_call(state, account_id, Method::POST, &format!("{msg}/attachments"), Some(&file_attachment(f, &data)), &[PREFER_IMMUTABLE]).await?;
        } else {
            upload(state, account_id, msg, f, &data).await?;
        }
    }
    // An empty JSON body rather than none, so the POST carries a Content-Length.
    graph_call(state, account_id, Method::POST, &format!("{msg}/send"), Some(&json!({})), &[PREFER_IMMUTABLE]).await
}

/// A big file through an upload session. The upload URL carries its own authorization, so
/// the chunks go without our token (Graph rejects them if it's there).
async fn upload(state: &AppState, account_id: i64, msg: &str, f: &DraftFile, data: &[u8]) -> Result<()> {
    let item = json!({ "AttachmentItem": { "attachmentType": "file", "name": f.name, "size": data.len(), "contentType": f.mime } });
    let session = graph_call(state, account_id, Method::POST, &format!("{msg}/attachments/createUploadSession"), Some(&item), &[]).await?;
    let url = session["uploadUrl"].as_str().ok_or_else(|| AppError::Other("Graph returned no upload URL".into()))?;
    for (start, end) in chunks(data.len()) {
        let res = state
            .http
            .put(url)
            .header("Content-Range", format!("bytes {start}-{end}/{}", data.len()))
            .body(data[start..=end].to_vec())
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            let v: Value = res.json().await.unwrap_or_default();
            let message = v["error"]["message"].as_str().unwrap_or("attachment upload failed").to_string();
            return Err(AppError::Graph { status: status.as_u16(), message });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(kind: DraftKind) -> Draft {
        Draft { kind, to: vec!["sam@x.com".into()], subject: "Plan".into(), body: "see attached".into(), ..Default::default() }
    }

    #[test]
    fn drafts_are_created_where_the_one_call_send_would_go() {
        let (url, body) = draft_request("https://g", None, &draft(DraftKind::New)).unwrap();
        assert_eq!(url, "https://g/me/messages");
        assert_eq!(body["subject"], "Plan");
        assert_eq!(body["toRecipients"][0]["emailAddress"]["address"], "sam@x.com");
        assert!(body["body"]["content"].as_str().unwrap().contains("see attached"));

        let (url, body) = draft_request("https://g", Some("R1"), &draft(DraftKind::ReplyAll)).unwrap();
        assert_eq!(url, "https://g/me/messages/R1/createReplyAll");
        assert!(body["comment"].as_str().unwrap().contains("see attached"));
        let (url, _) = draft_request("https://g", Some("R1"), &draft(DraftKind::Reply)).unwrap();
        assert_eq!(url, "https://g/me/messages/R1/createReply");
        let (url, body) = draft_request("https://g", Some("R1"), &draft(DraftKind::Forward)).unwrap();
        assert_eq!(url, "https://g/me/messages/R1/createForward");
        assert_eq!(body["message"]["toRecipients"][0]["emailAddress"]["address"], "sam@x.com");
    }

    #[test]
    fn small_files_go_inline_as_base64() {
        let f = DraftFile { id: 1, name: "a.txt".into(), mime: "text/plain".into(), size: 2 };
        let b = file_attachment(&f, b"hi");
        assert_eq!(b["@odata.type"], "#microsoft.graph.fileAttachment");
        assert_eq!(b["contentBytes"], "aGk=");
        assert_eq!(b["name"], "a.txt");
    }

    #[test]
    fn uploads_go_in_chunks_of_320_kib_multiples() {
        assert_eq!(chunks(10), vec![(0, 9)]);
        let total = CHUNK * 2 + 5;
        assert_eq!(chunks(total), vec![(0, CHUNK - 1), (CHUNK, 2 * CHUNK - 1), (2 * CHUNK, total - 1)]);
    }
}
