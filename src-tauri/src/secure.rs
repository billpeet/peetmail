//! Encrypts secrets at rest with Windows DPAPI, scoped to the current user.
//! Credential Manager caps blobs at 2.5KB, which Microsoft refresh tokens can exceed,
//! so tokens are DPAPI-encrypted and stored in SQLite instead.

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

#[cfg(not(windows))]
pub fn protect(_: &[u8]) -> Result<Vec<u8>> {
    Err(AppError::Other("secure storage is only implemented on Windows".into()))
}

#[cfg(not(windows))]
pub fn unprotect(_: &[u8]) -> Result<Vec<u8>> {
    Err(AppError::Other("secure storage is only implemented on Windows".into()))
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
