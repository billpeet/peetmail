//! One small query language for search and split inboxes.
//!
//!   from:contoso.com  to:sam  subject:invoice  is:unread  is:read  is:flagged
//!   is:focused  is:other  is:invite  has:attachment  "exact phrase"  free words
//!
//! Prefix any term with `-` to negate it. Terms are ANDed. Free words hit the FTS
//! index (subject, sender, recipients, preview, and bodies once fetched) as prefixes;
//! "quoted text" matches as an exact phrase.

use rusqlite::types::Value as SqlValue;

#[derive(Debug, Clone, PartialEq)]
enum Term {
    From(String),
    To(String),
    Subject(String),
    Is(String),
    HasAttachment,
    Text(String),
    Phrase(String),
}

#[derive(Debug, Clone, PartialEq)]
struct Clause {
    negated: bool,
    term: Term,
}

/// A compiled filter over the `messages` table aliased as `m`.
#[derive(Debug, Default)]
pub struct Filter {
    pub sql: String,
    pub params: Vec<SqlValue>,
}

fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for ch in input.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                cur.push(ch);
            }
            c if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    tokens.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

fn unquote(s: &str) -> String {
    s.trim_matches('"').to_string()
}

fn parse(input: &str) -> Vec<Clause> {
    tokenize(input)
        .into_iter()
        .filter_map(|tok| {
            let (negated, body) = match tok.strip_prefix('-') {
                Some(rest) if !rest.is_empty() => (true, rest.to_string()),
                _ => (false, tok.clone()),
            };
            let term = match body.split_once(':') {
                Some((k, v)) if !v.is_empty() => match k.to_ascii_lowercase().as_str() {
                    "from" => Term::From(unquote(v)),
                    "to" | "cc" => Term::To(unquote(v)),
                    "subject" => Term::Subject(unquote(v)),
                    "is" => Term::Is(v.to_ascii_lowercase()),
                    "has" if v.starts_with("attach") => Term::HasAttachment,
                    _ => Term::Text(unquote(&body)),
                },
                _ if body.starts_with('"') => Term::Phrase(unquote(&body)),
                _ => Term::Text(unquote(&body)),
            };
            match &term {
                Term::Text(t) | Term::Phrase(t) if t.trim().is_empty() => None,
                _ => Some(Clause { negated, term }),
            }
        })
        .collect()
}

/// FTS5 MATCH expression for free text: each word becomes a quoted prefix query.
fn fts_match(text: &str) -> String {
    text.split_whitespace()
        .map(|w| format!("\"{}\"*", w.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn like(v: &str) -> SqlValue {
    SqlValue::Text(format!("%{}%", v.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")))
}

/// Compiles a query into a SQL condition (always valid, `1` when empty).
pub fn compile(input: &str) -> Filter {
    let mut parts = Vec::new();
    let mut params = Vec::new();
    for Clause { negated, term } in parse(input) {
        let cond = match term {
            Term::From(v) => {
                params.extend([like(&v), like(&v)]);
                "(m.from_address LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\')".to_string()
            }
            Term::To(v) => {
                params.extend([like(&v), like(&v)]);
                "(m.to_json LIKE ? ESCAPE '\\' OR m.cc_json LIKE ? ESCAPE '\\')".to_string()
            }
            Term::Subject(v) => {
                params.push(like(&v));
                "m.subject LIKE ? ESCAPE '\\'".to_string()
            }
            Term::Is(v) => match v.as_str() {
                "unread" => "m.is_read = 0".into(),
                "read" => "m.is_read = 1".into(),
                "flagged" | "starred" => "m.is_flagged = 1".into(),
                "focused" | "important" => "COALESCE(m.inference, 'focused') = 'focused'".into(),
                "other" => "m.inference = 'other'".into(),
                "invite" | "calendar" => "m.message_type = 'eventMessage'".into(),
                _ => "0".into(), // unknown is: matches nothing, so typos are visible
            },
            Term::HasAttachment => "m.has_attachments = 1".into(),
            Term::Text(t) => {
                params.push(SqlValue::Text(fts_match(&t)));
                "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)".into()
            }
            Term::Phrase(t) => {
                params.push(SqlValue::Text(format!("\"{}\"", t.replace('"', "\"\""))));
                "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)".into()
            }
        };
        parts.push(if negated { format!("NOT ({cond})") } else { cond });
    }
    Filter {
        sql: if parts.is_empty() { "1".into() } else { parts.join(" AND ") },
        params,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_keys_negation_and_phrases() {
        let c = parse(r#"from:contoso.com -is:read "q4 plan" budget has:attachments"#);
        assert_eq!(
            c,
            vec![
                Clause { negated: false, term: Term::From("contoso.com".into()) },
                Clause { negated: true, term: Term::Is("read".into()) },
                Clause { negated: false, term: Term::Phrase("q4 plan".into()) },
                Clause { negated: false, term: Term::Text("budget".into()) },
                Clause { negated: false, term: Term::HasAttachment },
            ]
        );
    }

    #[test]
    fn unknown_keys_are_text() {
        assert_eq!(parse("http://x.com")[0].term, Term::Text("http://x.com".into()));
        assert_eq!(parse("re:")[0].term, Term::Text("re:".into()));
    }

    #[test]
    fn compiles_to_parameterised_sql() {
        let f = compile("from:sam is:unread hello");
        assert_eq!(f.params.len(), 3);
        assert!(f.sql.contains("m.is_read = 0"));
        assert!(f.sql.contains("MATCH ?"));
        assert_eq!(compile("").sql, "1");
        assert_eq!(fts_match(r#"say "hi"#), r#""say"* """hi"*"#);
        let p = compile(r#""quick question""#);
        assert_eq!(p.params, vec![SqlValue::Text(r#""quick question""#.into())]);
    }
}
