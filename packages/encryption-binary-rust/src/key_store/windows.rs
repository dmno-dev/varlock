//! Windows key protection using DPAPI (CryptProtectData / CryptUnprotectData).
//!
//! DPAPI encrypts data to the current Windows user account. The encrypted blob
//! can only be decrypted by the same user on the same machine. No additional
//! credentials are needed at decrypt time — the user's login session provides
//! the decryption key.
//!
//! Security properties:
//!   - Key is never stored as plaintext on disk
//!   - Encrypted to the current user's master key (derived from password)
//!   - Cannot be decrypted by other users or on other machines
//!   - Survives reboots (unlike Linux keyring)
//!   - Does NOT require TPM (software-only, but user-scoped)

use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    CRYPTPROTECT_UI_FORBIDDEN,
};
use windows::Win32::Foundation::LocalFree;
use std::ptr;

const DPAPI_DESCRIPTION: &str = "Varlock Local Encryption Key";

/// Free a DPAPI-allocated buffer and copy it into a Vec.
unsafe fn copy_and_free_blob(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let slice = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize);
    let vec = slice.to_vec();
    let hlocal = windows::Win32::Foundation::HLOCAL(blob.pbData as *mut _);
    let _ = LocalFree(hlocal);
    vec
}

/// Encrypt data using DPAPI (CryptProtectData).
/// Returns the encrypted blob.
pub fn dpapi_protect(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let data_in = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };

    // Optional entropy — we use the description as additional context
    let entropy_bytes: Vec<u16> = DPAPI_DESCRIPTION.encode_utf16().chain(std::iter::once(0)).collect();
    let entropy_u8: Vec<u8> = entropy_bytes.iter().flat_map(|w| w.to_le_bytes()).collect();
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy_u8.len() as u32,
        pbData: entropy_u8.as_ptr() as *mut u8,
    };

    let mut data_out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    let description: Vec<u16> = DPAPI_DESCRIPTION.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        CryptProtectData(
            &data_in,
            windows::core::PCWSTR(description.as_ptr()),
            Some(&entropy),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut data_out,
        )
        .map_err(|e| format!("CryptProtectData failed: {e}"))?;
    }

    let encrypted = unsafe { copy_and_free_blob(&data_out) };
    Ok(encrypted)
}

/// Decrypt data using DPAPI (CryptUnprotectData).
/// Returns the decrypted plaintext bytes.
pub fn dpapi_unprotect(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    let data_in = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_ptr() as *mut u8,
    };

    let entropy_bytes: Vec<u16> = DPAPI_DESCRIPTION.encode_utf16().chain(std::iter::once(0)).collect();
    let entropy_u8: Vec<u8> = entropy_bytes.iter().flat_map(|w| w.to_le_bytes()).collect();
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy_u8.len() as u32,
        pbData: entropy_u8.as_ptr() as *mut u8,
    };

    let mut data_out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    unsafe {
        CryptUnprotectData(
            &data_in,
            None,
            Some(&entropy),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut data_out,
        )
        .map_err(|e| format!("CryptUnprotectData failed — key may have been encrypted by a different user: {e}"))?;
    }

    let decrypted = unsafe { copy_and_free_blob(&data_out) };
    Ok(decrypted)
}
