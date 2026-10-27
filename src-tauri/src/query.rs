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
    /// account:work — mail of accounts whose address contains this.
    Account(String),
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

/// Adds "not these accounts" to a filter (accounts hidden in the UI).
pub fn exclude_accounts(f: Filter, ids: &[i64]) -> Filter {
    if ids.is_empty() {
        return f;
    }
    let marks = vec!["?"; ids.len()].join(", ");
    let mut params = f.params;
    params.extend(ids.iter().map(|&i| SqlValue::Integer(i)));
    Filter { sql: format!("({}) AND m.account_id NOT IN ({marks})", f.sql), params }
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
                    "account" | "in" => Term::Account(unquote(v)),
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
/// How many free-text terms and how many operators (`from:`, `is:`…) a query has: its
/// shape for telemetry, without any of its words.
pub fn shape(input: &str) -> (usize, usize) {
    let clauses = parse(input);
    let text = clauses.iter().filter(|c| matches!(c.term, Term::Text(_) | Term::Phrase(_))).count();
    (text, clauses.len() - text)
}

pub fn compile(input: &str) -> Filter {
    let mut parts = Vec::new();
    let mut params = Vec::new();
    for Clause { negated, term } in parse(input) {
        let cond = match term {
            Term::Account(v) => {
                params.push(like(&v));
                "m.account_id IN (SELECT id FROM accounts WHERE email LIKE ? ESCAPE '\\')".to_string()
            }
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

/// Filter for one tab of the split inbox, so every message lands in exactly one tab.
///
/// Tab 0 is the built-in Inbox: mail no split claims. Tab `i` (1-based) is split `i - 1`'s
/// matches that no earlier split already claimed, so order decides ties. Splits with an
/// empty query claim nothing (rather than everything).
pub fn split_filter(queries: &[String], tab: usize) -> Filter {
    let compiled: Vec<Option<Filter>> =
        queries.iter().map(|q| (!q.trim().is_empty()).then(|| compile(q))).collect();
    let (own, earlier): (Option<&Filter>, &[Option<Filter>]) = match tab {
        0 => (None, &compiled[..]),
        i if i <= compiled.len() => match &compiled[i - 1] {
            Some(f) => (Some(f), &compiled[..i - 1]),
            None => return Filter { sql: "0".into(), params: vec![] },
        },
        _ => return Filter { sql: "0".into(), params: vec![] },
    };
    let mut parts = Vec::new();
    let mut params = Vec::new();
    if let Some(f) = own {
        parts.push(format!("({})", f.sql));
        params.extend(f.params.iter().cloned());
    }
    for f in earlier.iter().flatten() {
        parts.push(format!("NOT ({})", f.sql));
        params.extend(f.params.iter().cloned());
    }
    Filter { sql: if parts.is_empty() { "1".into() } else { parts.join(" AND ") }, params }
}

#[cfg(test)]
mod tests {

    #[test]
    fn shape_counts_terms_and_operators() {
        assert_eq!(super::shape(r#"from:sam is:unread budget "q4 plan" -has:attachment"#), (2, 3));
        assert_eq!(super::shape(""), (0, 0));
    }
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
    fn excluding_accounts_appends_a_parameterised_clause() {
        let f = exclude_accounts(compile("from:sam"), &[2, 5]);
        assert!(f.sql.ends_with("AND m.account_id NOT IN (?, ?)"), "{}", f.sql);
        assert_eq!(f.params[f.params.len() - 2..], [SqlValue::Integer(2), SqlValue::Integer(5)]);
        assert_eq!(exclude_accounts(compile(""), &[]).sql, compile("").sql);
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
        assert_eq!(p.params.len(), 1);
        assert_eq!(p.params, vec![SqlValue::Text(r#""quick question""#.into())]);
    }

    #[test]
    fn split_tabs_are_exclusive_and_inbox_catches_the_rest() {
        let q = vec!["from:github.com".to_string(), "is:other".to_string(), "  ".to_string()];
        let inbox = split_filter(&q, 0);
        assert_eq!(inbox.sql, "NOT ((m.from_address LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\')) AND NOT (m.inference = 'other')");
        assert_eq!(inbox.params.len(), 2);
        let github = split_filter(&q, 1);
        assert!(github.sql.starts_with("((m.from_address"));
        assert!(!github.sql.contains("NOT"));
        let other = split_filter(&q, 2);
        assert!(other.sql.starts_with("(m.inference = 'other') AND NOT ("));
        assert_eq!(other.params.len(), 2, "params follow the SQL order");
        assert_eq!(split_filter(&q, 3).sql, "0", "an empty query claims nothing");
        assert_eq!(split_filter(&[], 0).sql, "1", "no splits: Inbox is everything");
    }
}
