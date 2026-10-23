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
}
