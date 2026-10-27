//! Finds an online-meeting join link in free text or HTML (an event's location, preview or
//! description), for events whose service didn't mark one (external invites, a Teams link
//! pasted into the location).

/// Hosts (and the path a join link must start with, "" for any) of meeting services.
const PROVIDERS: &[(&str, &[&str])] = &[
    ("teams.microsoft.com", &["/l/meetup-join/", "/meet/", "/v2/"]),
    ("teams.live.com", &["/meet/", "/l/meetup-join/"]),
    ("zoom.us", &["/j/", "/w/", "/my/", "/s/", "/wc/"]),
    ("zoomgov.com", &["/j/", "/w/"]),
    ("meet.google.com", &["/"]),
    ("webex.com", &["/meet/", "/join/", "/wbxmjs/", "/webappng/", "/m/"]),
    ("gotomeeting.com", &["/join/"]),
    ("gotomeet.me", &["/"]),
    ("meet.goto.com", &["/"]),
    ("meet.jit.si", &["/"]),
    ("whereby.com", &["/"]),
    ("chime.aws", &["/"]),
    ("bluejeans.com", &["/"]),
];

/// The first join link in `text`, with HTML entities in it decoded.
pub fn find(text: &str) -> Option<String> {
    let mut rest = text;
    while let Some(i) = rest.find("https://") {
        let tail = &rest[i..];
        let end = tail.find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | ')' | ']' | '}' | '|')).unwrap_or(tail.len());
        let url = tail[..end].trim_end_matches(['.', ',', ';', ':']).replace("&amp;", "&");
        if is_join_link(&url) {
            return Some(url);
        }
        rest = &tail[end.max(8)..];
    }
    None
}

fn is_join_link(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false };
    let Some(host) = u.host_str() else { return false };
    let host = host.to_ascii_lowercase();
    let path = u.path();
    PROVIDERS.iter().any(|(domain, paths)| {
        (host == *domain || host.ends_with(&format!(".{domain}")))
            && paths.iter().any(|p| path.starts_with(p) && (*p != "/" || path.len() > 1))
    })
}

/// Which service a join link is for, for its label.
pub fn provider_name(url: &str) -> &'static str {
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)).unwrap_or_default();
    let is = |d: &str| host == d || host.ends_with(&format!(".{d}"));
    if is("teams.microsoft.com") || is("teams.live.com") {
        "Microsoft Teams"
    } else if is("zoom.us") || is("zoomgov.com") {
        "Zoom"
    } else if is("meet.google.com") {
        "Google Meet"
    } else if is("webex.com") {
        "Webex"
    } else {
        "Online meeting"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_join_links_from_the_usual_services() {
        assert_eq!(
            find("https://teams.microsoft.com/meet/497178154226638?p=q8OarGuMU3YgdVWxcF"),
            Some("https://teams.microsoft.com/meet/497178154226638?p=q8OarGuMU3YgdVWxcF".into())
        );
        assert_eq!(
            find("Room 4 / https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x."),
            Some("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x".into())
        );
        assert_eq!(find("Zoom: https://us02web.zoom.us/j/81234567890?pwd=abc (passcode 1234)"), Some("https://us02web.zoom.us/j/81234567890?pwd=abc".into()));
        assert_eq!(find("meet.google.com link: https://meet.google.com/abc-defg-hij"), Some("https://meet.google.com/abc-defg-hij".into()));
        assert_eq!(find("https://acme.webex.com/meet/jsmith"), Some("https://acme.webex.com/meet/jsmith".into()));
        // In HTML, entities decoded; the first ordinary link is skipped.
        let html = r#"<p><a href="https://example.com/agenda">Agenda</a></p><a href="https://zoom.us/j/123?pwd=a&amp;uname=b">Join</a>"#;
        assert_eq!(find(html), Some("https://zoom.us/j/123?pwd=a&uname=b".into()));
    }

    #[test]
    fn ignores_links_that_are_not_join_links() {
        assert_eq!(find("https://outlook.office.com/calendar/item/123"), None);
        assert_eq!(find("https://teams.microsoft.com/"), None); // the home page, not a meeting
        assert_eq!(find("https://meet.google.com/"), None);
        assert_eq!(find("https://notzoom.us.example.com/j/1"), None);
        assert_eq!(find("Café Beetroot"), None);
        assert_eq!(find("http://zoom.us/j/1"), None); // only https
    }

    #[test]
    fn names_the_service() {
        assert_eq!(provider_name("https://us02web.zoom.us/j/1"), "Zoom");
        assert_eq!(provider_name("https://teams.microsoft.com/meet/1"), "Microsoft Teams");
        assert_eq!(provider_name("https://meet.google.com/abc-defg-hij"), "Google Meet");
        assert_eq!(provider_name("https://meet.jit.si/room"), "Online meeting");
    }
}
