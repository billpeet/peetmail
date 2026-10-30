//! Encrypts secrets at rest (saved sign-ins), scoped to the current user.
//!
//! - **Windows:** DPAPI. Credential Manager caps blobs at 2.5KB, which Microsoft refresh
//!   tokens can exceed, so tokens are DPAPI-encrypted and stored in SQLite instead.
//! - **Linux:** ChaCha20-Poly1305 under a random 256-bit key. The key lives in the desktop's
//!   keyring through the Secret Service API (GNOME Keyring, KWallet, KeePassXC). A desktop
//!   with no keyring gets the key in a file only the user can read, like Chromium's "basic"
//!   store. Tokens still sit in SQLite, so the database layer is the same on both.

use crate::error::{AppError, Result};

#[cfg(windows)]
pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
        let ok = CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        );
        if ok == 0 {
            return Err(AppError::Other(format!("DPAPI protect failed: {}", std::io::Error::last_os_error())));
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        Ok(v)
    }
}

#[cfg(windows)]
pub fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
        let ok = CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        );
        if ok == 0 {
            return Err(AppError::Other(format!("DPAPI unprotect failed: {}", std::io::Error::last_os_error())));
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        Ok(v)
    }
}

/// Where the Linux key may be kept. Called once from setup, before anything is encrypted.
/// `keyring` is off for test runs, so they never touch the user's real keyring.
#[cfg(windows)]
pub fn init(_data_dir: &std::path::Path, _keyring: bool) {}

#[cfg(target_os = "linux")]
pub use linux::init;

#[cfg(target_os = "linux")]
pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
    sealed::seal(&linux::key()?, data)
}

#[cfg(target_os = "linux")]
pub fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
    sealed::open(&linux::key()?, data)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn init(_data_dir: &std::path::Path, _keyring: bool) {}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn protect(_: &[u8]) -> Result<Vec<u8>> {
    Err(AppError::Other("secure storage isn't implemented on this platform".into()))
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn unprotect(_: &[u8]) -> Result<Vec<u8>> {
    Err(AppError::Other("secure storage isn't implemented on this platform".into()))
}

/// Authenticated encryption under a 256-bit key: `version (1) | nonce (12) | ciphertext+tag`.
#[cfg(target_os = "linux")]
mod sealed {
    use super::{AppError, Result};
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN};

    const VERSION: u8 = 1;

    fn cipher(key: &[u8; 32]) -> LessSafeKey {
        LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, key).expect("a 32-byte key fits ChaCha20-Poly1305"))
    }

    pub fn seal(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>> {
        let mut nonce = [0u8; NONCE_LEN];
        getrandom::fill(&mut nonce).map_err(|e| AppError::Other(format!("OS RNG unavailable: {e}")))?;
        let mut body = data.to_vec();
        cipher(key)
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from([VERSION]), &mut body)
            .map_err(|_| AppError::Other("encrypting failed".into()))?;
        let mut out = Vec::with_capacity(1 + NONCE_LEN + body.len());
        out.push(VERSION);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&body);
        Ok(out)
    }

    pub fn open(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>> {
        let bad = || AppError::Other("saved sign-in can't be decrypted (the key changed); sign in again".into());
        let (&version, rest) = blob.split_first().ok_or_else(bad)?;
        if version != VERSION || rest.len() < NONCE_LEN {
            return Err(bad());
        }
        let (nonce, body) = rest.split_at(NONCE_LEN);
        let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| bad())?;
        let mut body = body.to_vec();
        let plain = cipher(key).open_in_place(nonce, Aad::from([VERSION]), &mut body).map_err(|_| bad())?;
        Ok(plain.to_vec())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{AppError, Result};
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};

    /// The key itself, when the desktop has no keyring.
    pub const KEY_FILE: &str = "token.key";
    /// Says the key is in the keyring. Once it's there, a keyring that won't answer is an
    /// error, not a reason to make a second key that the saved sign-ins don't match.
    pub const MARKER_FILE: &str = "token.key.keyring";

    static CONFIG: OnceLock<(PathBuf, bool)> = OnceLock::new();
    static KEY: Mutex<Option<[u8; 32]>> = Mutex::new(None);

    pub fn init(data_dir: &Path, keyring: bool) {
        let _ = CONFIG.set((data_dir.to_path_buf(), keyring));
    }

    /// The key, looked up once (it may mean a keyring unlock prompt) and then cached.
    pub fn key() -> Result<[u8; 32]> {
        let mut cached = KEY.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(k) = *cached {
            return Ok(k);
        }
        let (dir, keyring) = CONFIG.get().ok_or_else(|| AppError::Other("secure storage used before setup".into()))?;
        let k = if *keyring { load_or_create(dir, &SecretService)? } else { load_or_create(dir, &NoKeyring)? };
        *cached = Some(k);
        Ok(k)
    }

    /// Somewhere to keep the key that isn't a plain file.
    pub trait Keyring {
        fn get(&self) -> std::result::Result<Option<Vec<u8>>, String>;
        fn set(&self, key: &[u8]) -> std::result::Result<(), String>;
    }

    pub struct NoKeyring;
    impl Keyring for NoKeyring {
        fn get(&self) -> std::result::Result<Option<Vec<u8>>, String> {
            Err("keyring not used".into())
        }
        fn set(&self, _: &[u8]) -> std::result::Result<(), String> {
            Err("keyring not used".into())
        }
    }

    fn new_key() -> Result<[u8; 32]> {
        let mut k = [0u8; 32];
        getrandom::fill(&mut k).map_err(|e| AppError::Other(format!("OS RNG unavailable: {e}")))?;
        Ok(k)
    }

    fn as_key(bytes: &[u8]) -> Option<[u8; 32]> {
        bytes.try_into().ok()
    }

    /// A key file wins (the desktop had no keyring when PeetMail first needed one). Else the
    /// keyring's key, or a new one put there. A keyring that fails before it was ever used
    /// means a key file; after that it's an error.
    pub fn load_or_create(dir: &Path, keyring: &dyn Keyring) -> Result<[u8; 32]> {
        let file = dir.join(KEY_FILE);
        if file.exists() {
            let bytes = std::fs::read(&file)?;
            return as_key(&bytes).ok_or_else(|| AppError::Other(format!("{} is damaged", file.display())));
        }
        let marker = dir.join(MARKER_FILE);
        let found = keyring.get();
        if let Ok(Some(bytes)) = &found {
            if let Some(k) = as_key(bytes) {
                if !marker.exists() {
                    std::fs::write(&marker, b"")?;
                }
                return Ok(k);
            }
            log::warn!("the keyring's PeetMail key has the wrong length; making a new one");
        }
        let key = new_key()?;
        let stored = match found {
            Ok(_) => keyring.set(&key),
            Err(e) => Err(e),
        };
        match stored {
            Ok(()) => {
                std::fs::write(&marker, b"")?;
                log::info!("saved sign-ins are encrypted with a key in the desktop keyring");
                Ok(key)
            }
            Err(e) if marker.exists() => Err(AppError::Other(format!("couldn't reach the desktop keyring that holds PeetMail's key: {e}"))),
            Err(e) => {
                log::warn!("no desktop keyring ({e}); keeping the key for saved sign-ins in a private file");
                write_private(&file, &key)?;
                Ok(key)
            }
        }
    }

    /// Creates `path` readable and writable by the owner only.
    fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok(())
    }

    /// The Secret Service (org.freedesktop.secrets) on the session bus.
    struct SecretService;

    fn attributes() -> HashMap<&'static str, &'static str> {
        HashMap::from([("application", crate::datadir::IDENTIFIER), ("purpose", "token-key")])
    }

    impl Keyring for SecretService {
        fn get(&self) -> std::result::Result<Option<Vec<u8>>, String> {
            use secret_service::{blocking::SecretService, EncryptionType};
            let ss = SecretService::connect(EncryptionType::Dh).map_err(|e| e.to_string())?;
            let found = ss.search_items(attributes()).map_err(|e| e.to_string())?;
            let Some(item) = found.unlocked.first().or(found.locked.first()) else { return Ok(None) };
            item.ensure_unlocked().map_err(|e| e.to_string())?;
            item.get_secret().map(Some).map_err(|e| e.to_string())
        }

        fn set(&self, key: &[u8]) -> std::result::Result<(), String> {
            use secret_service::{blocking::SecretService, EncryptionType};
            let ss = SecretService::connect(EncryptionType::Dh).map_err(|e| e.to_string())?;
            let collection = ss.get_default_collection().map_err(|e| e.to_string())?;
            collection.ensure_unlocked().map_err(|e| e.to_string())?;
            collection
                .create_item("PeetMail: key for saved sign-ins", attributes(), key, true, "application/octet-stream")
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn round_trip() {
        let secret = b"refresh-token-\x00\xff-bytes".repeat(200);
        let enc = super::protect(&secret).unwrap();
        assert_ne!(enc, secret);
        assert_eq!(super::unprotect(&enc).unwrap(), secret);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::linux::{load_or_create, Keyring, NoKeyring, KEY_FILE, MARKER_FILE};
    use super::sealed::{open, seal};
    use std::cell::RefCell;
    use std::os::unix::fs::PermissionsExt;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("peetmail-secure-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// An in-memory keyring that can be made to fail.
    struct FakeKeyring {
        stored: RefCell<Option<Vec<u8>>>,
        broken: bool,
    }
    impl FakeKeyring {
        fn new(broken: bool) -> Self {
            FakeKeyring { stored: RefCell::new(None), broken }
        }
    }
    impl Keyring for FakeKeyring {
        fn get(&self) -> Result<Option<Vec<u8>>, String> {
            if self.broken { Err("no service".into()) } else { Ok(self.stored.borrow().clone()) }
        }
        fn set(&self, key: &[u8]) -> Result<(), String> {
            if self.broken {
                return Err("no service".into());
            }
            *self.stored.borrow_mut() = Some(key.to_vec());
            Ok(())
        }
    }

    #[test]
    fn round_trip_and_tamper() {
        let key = [7u8; 32];
        let secret = b"refresh-token-\x00\xff-bytes".repeat(200);
        let enc = seal(&key, &secret).unwrap();
        assert!(!enc.windows(14).any(|w| w == b"refresh-token-"), "ciphertext holds the plaintext");
        assert_eq!(open(&key, &enc).unwrap(), secret);
        assert_ne!(seal(&key, &secret).unwrap(), enc, "every seal gets a fresh nonce");

        let mut flipped = enc.clone();
        *flipped.last_mut().unwrap() ^= 1;
        assert!(open(&key, &flipped).is_err(), "a changed byte is refused");
        assert!(open(&[8u8; 32], &enc).is_err(), "another key is refused");
        assert!(open(&key, &[]).is_err());
        assert!(open(&key, &enc[..5]).is_err());
    }

    #[test]
    fn key_goes_to_the_keyring_and_stays_there() {
        let dir = temp_dir("keyring");
        let ring = FakeKeyring::new(false);
        let k1 = load_or_create(&dir, &ring).unwrap();
        assert_eq!(ring.stored.borrow().as_deref(), Some(&k1[..]));
        assert!(dir.join(MARKER_FILE).exists());
        assert!(!dir.join(KEY_FILE).exists(), "no key on disk when there's a keyring");
        assert_eq!(load_or_create(&dir, &ring).unwrap(), k1, "the same key next time");
    }

    #[test]
    fn no_keyring_means_a_private_key_file() {
        let dir = temp_dir("file");
        let k1 = load_or_create(&dir, &NoKeyring).unwrap();
        let file = dir.join(KEY_FILE);
        assert_eq!(std::fs::read(&file).unwrap(), k1);
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        // A keyring showing up later doesn't move the key (the saved sign-ins match the file).
        let ring = FakeKeyring::new(false);
        assert_eq!(load_or_create(&dir, &ring).unwrap(), k1);
        assert!(ring.stored.borrow().is_none());
    }

    #[test]
    fn a_keyring_that_stops_answering_is_an_error_not_a_new_key() {
        let dir = temp_dir("gone");
        load_or_create(&dir, &FakeKeyring::new(false)).unwrap();
        assert!(load_or_create(&dir, &FakeKeyring::new(true)).is_err());
        assert!(!dir.join(KEY_FILE).exists());
    }
}
