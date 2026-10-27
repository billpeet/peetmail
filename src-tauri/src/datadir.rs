//! Where PeetMail keeps its data, and carrying it over from the identifier the
//! early dev builds used (`com.boris.peetmail`). Remove the legacy part once nobody has that data.

use std::path::Path;

/// tauri.conf.json `identifier`: names the data folders.
pub const IDENTIFIER: &str = "com.peetsoftware.peetmail";
pub const LEGACY_IDENTIFIER: &str = "com.boris.peetmail";

/// The database and its WAL files, in the roaming app data dir.
pub const DB_FILES: &[&str] = &["peetmail.db", "peetmail.db-wal", "peetmail.db-shm"];
/// WebView2's profile (localStorage: hidden accounts, quick-add choices), in the local dir.
pub const WEBVIEW_FILES: &[&str] = &["EBWebView"];

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
