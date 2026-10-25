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
pub fn compose_html(text: &str) -> String {
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let paragraphs: Vec<String> = text
        .replace("\r\n", "\n")
        .split("\n\n")
        .map(|p| format!("<p>{}</p>", escape(p.trim_end()).replace('\n', "<br>")))
        .collect();
    format!(r#"<div style="font-family:Segoe UI,sans-serif;font-size:14px">{}</div>"#, paragraphs.join(""))
}

static TEXT_ONLY: LazyLock<ammonia::Builder<'static>> = LazyLock::new(ammonia::Builder::empty);

/// Plain text of an HTML body for the search index, capped so huge newsletters stay cheap.
pub fn html_to_text(html: &str) -> String {
    let stripped = TEXT_ONLY.clean(html).to_string();
    let decoded = stripped
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(20_000).collect()
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
    fn compose_html_escapes_and_breaks_lines() {
        let h = compose_html("Hi <Sam>,\r\n\r\nLine one\nLine two");
        assert!(h.contains("<p>Hi &lt;Sam&gt;,</p><p>Line one<br>Line two</p>"));
    }

    #[test]
    fn html_to_text_drops_tags_styles_and_scripts() {
        let t = html_to_text("<style>p{x}</style><p>Hello&nbsp;<b>world</b></p><script>bad()</script> &amp; more");
        assert_eq!(t, "Hello world & more");
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
