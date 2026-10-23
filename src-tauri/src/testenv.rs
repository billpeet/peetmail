//! Debug-build-only overrides used by the test harness (tests/harness).
//! Release builds ignore every one of these, so a shipped binary always talks to
//! Microsoft and stores data in the standard locations.
//!
//! | Variable                      | Effect                                                   |
//! |-------------------------------|----------------------------------------------------------|
//! | PEETMAIL_DATA_DIR             | SQLite + logs go here instead of %APPDATA%               |
//! | PEETMAIL_GRAPH_URL            | Graph base URL, e.g. http://127.0.0.1:4010/v1.0          |
//! | PEETMAIL_AUTHORITY_URL        | OAuth authority, e.g. http://127.0.0.1:4010/oauth        |
//! | PEETMAIL_AUTH_AUTOFOLLOW=1    | Follow the authorize URL with reqwest, not a browser     |
//! | PEETMAIL_SYNC_INTERVAL_SECS   | Background sync interval (default 60)                    |
//! | PEETMAIL_HEADLESS=1           | Window off-screen, no taskbar entry, never takes focus   |

pub fn get(name: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    } else {
        None
    }
}

pub fn flag(name: &str) -> bool {
    get(name).is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}
