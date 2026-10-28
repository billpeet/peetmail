//! Email HTML sanitizing. Output goes into a sandboxed iframe with scripts disabled,
//! and the app CSP blocks remote loads, so this is the second of three layers.

use std::collections::HashSet;
use std::sync::LazyLock;

static CLEANER: LazyLock<ammonia::Builder<'static>> = LazyLock::new(|| {
    let mut b = ammonia::Builder::default();
    // Email layout relies on legacy presentational markup and inline styles.
    b.add_tags(["font", "center", "style"])
        .rm_clean_content_tags(["style"])
        .add_generic_attributes([
            "style", "class", "align", "valign", "bgcolor", "width", "height", "border", "dir", "color",
            "face", "size", "cellpadding", "cellspacing",
        ])
        .url_schemes(HashSet::from(["http", "https", "mailto", "tel", "cid", "data"]))
        .link_rel(Some("noopener noreferrer"));
    b
});

pub fn clean_html(html: &str) -> String {
    CLEANER.clean(html).to_string()
}

pub fn text_to_html(text: &str) -> String {
    let escaped = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(r#"<pre style="white-space:pre-wrap;font:inherit;margin:0">{escaped}</pre>"#)
}

/// HTML for a message typed as plain text in the composer: escaped, blank lines become
/// paragraphs, single newlines become line breaks.
/// What the composer's rich text may contain: the editor's own markup, nothing else.
static COMPOSE_CLEANER: LazyLock<ammonia::Builder<'static>> = LazyLock::new(|| {
    let mut b = ammonia::Builder::empty();
    b.tags(HashSet::from([
        "p", "br", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li", "blockquote", "code", "pre", "h1", "h2", "h3", "hr",
    ]))
    .tag_attributes(std::collections::HashMap::from([("a", HashSet::from(["href"])), ("ol", HashSet::from(["start"]))]))
    .url_schemes(HashSet::from(["http", "https", "mailto"]))
    .link_rel(Some("noopener noreferrer"));
    b
});

/// The composer's rich text as sent: sanitized to the editor's markup, in the same wrapper
/// as plain-text messages. Each editor paragraph is a line, so it goes out as a `<div>`
/// (an empty one as a blank line), like Gmail's and Outlook's own composers: `<p>` margins
/// differ between mail clients, divs look the same everywhere.
pub fn compose_rich(html: &str) -> String {
    let clean = COMPOSE_CLEANER.clean(html).to_string();
    let mut lines = clean
        .replace("<p></p>", "<div><br></div>")
        .replace("<p>", "<div>")
        .replace("</p>", "</div>")
        .replace("<blockquote>", r#"<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">"#);
    // Blank lines left at the end are just where the caret was.
    while let Some(rest) = lines.strip_suffix("<div><br></div>") {
        lines = rest.to_string();
    }
    format!(r#"<div style="font-family:Segoe UI,sans-serif;font-size:14px">{lines}</div>"#)
}

pub fn compose_html(text: &str) -> String {
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let paragraphs: Vec<String> = text
        .replace("\r\n", "\n")
        .split("\n\n")
        .map(|p| format!("<p>{}</p>", escape(p.trim_end()).replace('\n', "<br>")))
        .collect();
    format!(r#"<div style="font-family:Segoe UI,sans-serif;font-size:14px">{}</div>"#, paragraphs.join(""))
}

/// Plain text of a sanitized HTML body for the search index, capped so huge newsletters
/// stay cheap. A single linear scan: the input is ammonia's well-formed output, so a full
/// HTML parse (which a 1 MB newsletter made cost ~50ms) isn't needed.
pub fn html_to_text(html: &str) -> String {
    const CAP: usize = 20_000;
    let mut out = String::with_capacity(html.len().min(CAP * 2));
    let mut rest = html;
    let mut pending_space = false;
    while !rest.is_empty() && out.len() < CAP {
        if let Some(after) = rest.strip_prefix('<') {
            // Skip <style> and <script> contents entirely; other tags become word breaks.
            let lower: String = after.chars().take(7).collect::<String>().to_ascii_lowercase();
            let skip_to = if lower.starts_with("style") { Some("</style>") } else if lower.starts_with("script") { Some("</script>") } else { None };
            rest = match skip_to {
                Some(close) => match find_ci(rest, close) {
                    Some(i) => &rest[i + close.len()..],
                    None => "",
                },
                None => match after.find('>') {
                    Some(i) => {
                        // Block-level tags separate words; inline ones (<b>, <a>, <span>) don't.
                        let name: String = after[..i]
                            .trim_start_matches('/')
                            .chars()
                            .take_while(|c| c.is_ascii_alphanumeric())
                            .collect::<String>()
                            .to_ascii_lowercase();
                        if BLOCK_TAGS.contains(&name.as_str()) {
                            pending_space = true;
                        }
                        &after[i + 1..]
                    }
                    None => "",
                },
            };
            if skip_to.is_some() {
                pending_space = true;
            }
            continue;
        }
        let end = rest.find('<').unwrap_or(rest.len());
        let (chunk, next) = rest.split_at(end);
        let text = decode_entities(chunk);
        if text.starts_with(char::is_whitespace) {
            pending_space = true;
        }
        for (i, word) in text.split_whitespace().enumerate() {
            if (i > 0 || pending_space) && !out.is_empty() {
                out.push(' ');
            }
            out.push_str(word);
        }
        // Words only run on into the next text node if nothing separated them.
        pending_space = text.ends_with(char::is_whitespace);
        rest = next;
    }
    out.chars().take(CAP).collect()
}

const BLOCK_TAGS: &[&str] = &[
    "p", "div", "br", "hr", "tr", "td", "th", "li", "ul", "ol", "table", "tbody", "thead", "blockquote",
    "h1", "h2", "h3", "h4", "h5", "h6", "pre", "center", "img", "section", "article", "header", "footer",
];

fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    haystack.to_ascii_lowercase().find(needle)
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// Rewrites the `src` of every `<img>` in sanitized HTML. `f` returns the replacement,
/// or `None` to leave it. Relies on ammonia's normalized output (`src="..."`).
pub fn rewrite_img_src(html: &str, mut f: impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find("<img") {
        let tag_end = rest[start..].find('>').map(|e| start + e).unwrap_or(rest.len());
        let tag = &rest[start..tag_end];
        out.push_str(&rest[..start]);
        match tag.find(" src=\"").and_then(|i| tag[i + 6..].find('"').map(|j| (i + 6, i + 6 + j))) {
            Some((vs, ve)) => match f(&tag[vs..ve]) {
                Some(new) => {
                    out.push_str(&tag[..vs]);
                    out.push_str(&new.replace('"', "&quot;"));
                    out.push_str(&tag[ve..]);
                }
                None => out.push_str(tag),
            },
            None => out.push_str(tag),
        }
        rest = &rest[tag_end..];
    }
    out.push_str(rest);
    out
}

/// Remote image URLs in sanitized HTML, deduplicated, in order.
pub fn remote_images(html: &str) -> Vec<String> {
    let mut urls = Vec::new();
    rewrite_img_src(html, |src| {
        let src = src.replace("&amp;", "&");
        if (src.starts_with("https://") || src.starts_with("http://")) && !urls.contains(&src) {
            urls.push(src);
        }
        None
    });
    urls
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_scripts_and_handlers_keeps_layout() {
        let out = clean_html(
            r##"<table bgcolor="#fff" style="width:100%"><tr><td onclick="x()">Hi<script>alert(1)</script></td></tr></table>
               <style>p{color:red}</style><a href="javascript:evil()">x</a><a href="https://a.example">y</a>"##,
        );
        assert!(!out.contains("script"));
        assert!(!out.contains("onclick"));
        assert!(!out.contains("javascript:"));
        assert!(out.contains(r##"bgcolor="#fff""##));
        assert!(out.contains("p{color:red}"));
        assert!(out.contains(r##"href="https://a.example""##));
    }

    #[test]
    fn escapes_plain_text() {
        assert!(text_to_html("<b>&").contains("&lt;b&gt;&amp;"));
    }

    #[test]
    fn rich_text_keeps_formatting_and_drops_everything_else() {
        let h = compose_rich(
            r#"<p>Hi <strong>Sam</strong>, <em>see</em> <a href="https://x.com" target="_blank">this</a></p><p></p><ul><li><p>one</p></li></ul><script>alert(1)</script><img src="https://t/p.gif"><p style="color:red" onclick="x()">plain</p><a href="javascript:alert(1)">bad</a><p></p><p></p>"#,
        );
        assert!(h.starts_with(r#"<div style="font-family:Segoe UI"#), "{h}");
        assert!(h.contains("<div>Hi <strong>Sam</strong>, <em>see</em> <a href=\"https://x.com\" rel=\"noopener noreferrer\">this</a></div><div><br></div><ul>"), "{h}");
        assert!(h.contains("<ul><li><div>one</div></li></ul>"), "{h}");
        assert!(h.contains("<div>plain</div>"), "{h}");
        assert!(h.ends_with("bad</a></div>"), "trailing blank lines dropped: {h}");
        for gone in ["script", "alert(1)", "<img", "style=\"color", "onclick", "target=", "javascript:"] {
            assert!(!h.contains(gone), "{gone} in {h}");
        }
    }

    #[test]
    fn compose_html_escapes_and_breaks_lines() {
        let h = compose_html("Hi <Sam>,\r\n\r\nLine one\nLine two");
        assert!(h.contains("<p>Hi &lt;Sam&gt;,</p><p>Line one<br>Line two</p>"));
    }

    #[test]
    fn html_to_text_drops_tags_styles_and_scripts() {
        let t = html_to_text("<style>p{x}</style><p>Hello&nbsp;<b>world</b></p><script>bad()</script> &amp; more");
        assert_eq!(t, "Hello world & more");
        assert_eq!(html_to_text("<p>Hi</p><p>there</p><b>bo</b>ld"), "Hi there bold");
        assert_eq!(html_to_text("<STYLE>x</STYLE>ok"), "ok");
        assert_eq!(html_to_text(&clean_html(r#"<img src="data:image/png;base64,AAAA" alt="pic">caption"#)), "caption");
    }

    #[test]
    fn rewrites_only_img_src() {
        let html = clean_html(r#"<p><a href="https://a">a</a><img src="cid:logo@1" alt="x"><img src="https://img.example/a.png?x=1&amp;y=2"></p>"#);
        let out = rewrite_img_src(&html, |s| s.strip_prefix("cid:").map(|id| format!("data:image/png;base64,{id}")));
        assert!(out.contains(r#"src="data:image/png;base64,logo@1""#));
        assert!(out.contains(r#"href="https://a""#));
        assert_eq!(remote_images(&html), vec!["https://img.example/a.png?x=1&y=2"]);
    }
}
