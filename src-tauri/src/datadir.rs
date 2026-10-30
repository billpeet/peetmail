//! Where PeetMail keeps its data, and carrying it over from the identifier the
//! early dev builds used (`com.boris.peetmail`). Remove the legacy part once nobody has that data.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// tauri.conf.json `identifier`: names the data folders.
pub const IDENTIFIER: &str = "com.peetsoftware.peetmail";
pub const LEGACY_IDENTIFIER: &str = "com.boris.peetmail";

/// The database and its WAL files, in the roaming app data dir.
pub const DB_FILES: &[&str] = &["peetmail.db", "peetmail.db-wal", "peetmail.db-shm"];
/// WebView2's profile (localStorage: hidden accounts, quick-add choices), in the local dir.
pub const WEBVIEW_FILES: &[&str] = &["EBWebView"];

/// The folder Tauri's `app_data_dir` resolves to, for code that runs before Tauri is up
/// (the crash reporter starts first thing). `%APPDATA%\<id>` on Windows,
/// `$XDG_DATA_HOME/<id>` (default `~/.local/share/<id>`) on Linux.
pub fn app_data_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join(IDENTIFIER))
    } else {
        xdg_data_dir(std::env::var_os("XDG_DATA_HOME"), std::env::var_os("HOME"))
    }
}

/// The XDG base directory rule: `XDG_DATA_HOME` if it's an absolute path, else `$HOME/.local/share`.
pub fn xdg_data_dir(xdg_data_home: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    let base = xdg_data_home
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| home.map(|h| PathBuf::from(h).join(".local").join("share")))?;
    Some(base.join(IDENTIFIER))
}

/// Moves `names` from the legacy sibling of `dir` into `dir`, if `dir` doesn't have the
/// first of them yet and the legacy dir does. Returns whether anything moved. Both dirs sit
/// under the same parent, so this is a rename, not a copy.
pub fn adopt_legacy(dir: &Path, names: &[&str]) -> std::io::Result<bool> {
    let Some(parent) = dir.parent() else { return Ok(false) };
    let legacy = parent.join(LEGACY_IDENTIFIER);
    let Some(first) = names.first() else { return Ok(false) };
    if dir.join(first).exists() || !legacy.join(first).exists() {
        return Ok(false);
    }
    std::fs::create_dir_all(dir)?;
    for name in names {
        let from = legacy.join(name);
        if from.exists() {
            std::fs::rename(&from, dir.join(name))?;
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)] // "/data" isn't an absolute path on Windows
    fn xdg_data_dir_follows_the_spec() {
        let os = |s: &str| Some(OsString::from(s));
        assert_eq!(xdg_data_dir(os("/data"), os("/home/ann")), Some(PathBuf::from("/data").join(IDENTIFIER)));
        assert_eq!(xdg_data_dir(None, os("/home/ann")), Some(PathBuf::from("/home/ann/.local/share").join(IDENTIFIER)));
        // A relative XDG_DATA_HOME is invalid and ignored.
        assert_eq!(xdg_data_dir(os("rel/dir"), os("/home/ann")), Some(PathBuf::from("/home/ann/.local/share").join(IDENTIFIER)));
        assert_eq!(xdg_data_dir(None, None), None);
    }
    use std::fs;

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).unwrap();
        let root = std::env::temp_dir().join(format!("peetmail-datadir-{tag}-{:016x}", u64::from_le_bytes(b)));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn moves_the_legacy_database_into_a_new_dir() {
        let root = temp_root("move");
        let legacy = root.join(LEGACY_IDENTIFIER);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("peetmail.db"), b"db").unwrap();
        fs::write(legacy.join("peetmail.db-wal"), b"wal").unwrap();
        let dir = root.join("com.peetsoftware.peetmail");

        assert!(adopt_legacy(&dir, DB_FILES).unwrap());
        assert_eq!(fs::read(dir.join("peetmail.db")).unwrap(), b"db");
        assert_eq!(fs::read(dir.join("peetmail.db-wal")).unwrap(), b"wal");
        assert!(!legacy.join("peetmail.db").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn never_overwrites_an_existing_database() {
        let root = temp_root("keep");
        let legacy = root.join(LEGACY_IDENTIFIER);
        let dir = root.join("com.peetsoftware.peetmail");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(legacy.join("peetmail.db"), b"old").unwrap();
        fs::write(dir.join("peetmail.db"), b"new").unwrap();

        assert!(!adopt_legacy(&dir, DB_FILES).unwrap());
        assert_eq!(fs::read(dir.join("peetmail.db")).unwrap(), b"new");
        assert!(legacy.join("peetmail.db").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn nothing_to_adopt_without_a_legacy_dir() {
        let root = temp_root("none");
        assert!(!adopt_legacy(&root.join("com.peetsoftware.peetmail"), WEBVIEW_FILES).unwrap());
        let _ = fs::remove_dir_all(root);
    }
}
