//! Windows TPM key protection via NCrypt (Microsoft Platform Crypto Provider).
//!
//! A persistent RSA key in the TPM OAEP-wraps the 32-byte P-256 scalar.
//! The seal key is shared per user (`VarlockLocalEncryptSealKey`); each
//! varlock key file stores its own wrapped scalar blob.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr;

use windows::core::PCWSTR;
use windows::Win32::Foundation::NTE_BAD_KEYSET;
use windows::Win32::Security::Cryptography::{
    NCryptCreatePersistedKey, NCryptDecrypt, NCryptEncrypt, NCryptFinalizeKey,
    NCryptFreeObject, NCryptOpenKey, NCryptOpenStorageProvider, BCRYPT_OAEP_PADDING_INFO,
    BCRYPT_RSA_ALGORITHM, BCRYPT_SHA256_ALGORITHM, CERT_KEY_SPEC, MS_PLATFORM_CRYPTO_PROVIDER,
    NCRYPT_FLAGS, NCRYPT_KEY_HANDLE, NCRYPT_PAD_OAEP_FLAG, NCRYPT_PROV_HANDLE,
};

/// Persistent RSA seal key name in the Platform Crypto Provider.
const SEAL_KEY_NAME: &str = "VarlockLocalEncryptSealKey";

/// Detailed result of NCrypt/TPM availability check.
pub enum NcryptStatus {
    /// TPM + PCP available and seal key can be opened or created
    Available,
    /// Microsoft Platform Crypto Provider could not be opened
    ProviderFailed(String),
}

fn to_wide_null(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

struct SealKeySession {
    _provider: NCRYPT_PROV_HANDLE,
    key: NCRYPT_KEY_HANDLE,
}

impl Drop for SealKeySession {
    fn drop(&mut self) {
        unsafe {
            let _ = NCryptFreeObject(self.key);
            let _ = NCryptFreeObject(self._provider);
        }
    }
}

impl SealKeySession {
    fn open() -> Result<Self, String> {
        let mut provider = NCRYPT_PROV_HANDLE::default();
        unsafe {
            NCryptOpenStorageProvider(
                &mut provider,
                PCWSTR(MS_PLATFORM_CRYPTO_PROVIDER.as_ptr()),
                0,
            )
            .map_err(|e| format!("NCryptOpenStorageProvider failed: {e}"))?;
        }

        let key_name = to_wide_null(SEAL_KEY_NAME);
        let mut key = NCRYPT_KEY_HANDLE::default();

        let open_result = unsafe {
            NCryptOpenKey(
                provider,
                &mut key,
                PCWSTR(key_name.as_ptr()),
                CERT_KEY_SPEC(0),
                NCRYPT_FLAGS(0),
            )
        };

        if open_result.is_err() {
            let err = open_result.unwrap_err();
            if err.code() != NTE_BAD_KEYSET.into() {
                unsafe {
                    let _ = NCryptFreeObject(provider);
                }
                return Err(format!("NCryptOpenKey failed: {err}"));
            }

            key = create_seal_key(provider, &key_name)?;
        }

        Ok(Self {
            _provider: provider,
            key,
        })
    }

    fn wrap_scalar(&self, scalar: &[u8]) -> Result<Vec<u8>, String> {
        if scalar.len() != 32 {
            return Err(format!(
                "NCrypt seal expects 32-byte scalar, got {} bytes",
                scalar.len()
            ));
        }

        let padding_info = BCRYPT_OAEP_PADDING_INFO {
            pszAlgId: PCWSTR(BCRYPT_SHA256_ALGORITHM.as_ptr()),
            pbLabel: ptr::null_mut(),
            cbLabel: 0,
        };

        let mut size: u32 = 0;
        unsafe {
            NCryptEncrypt(
                self.key,
                Some(scalar),
                Some(&padding_info as *const _ as *const _),
                None,
                &mut size,
                NCRYPT_PAD_OAEP_FLAG,
            )
            .map_err(|e| format!("NCryptEncrypt size query failed: {e}"))?;
        }

        let mut wrapped = vec![0u8; size as usize];
        unsafe {
            NCryptEncrypt(
                self.key,
                Some(scalar),
                Some(&padding_info as *const _ as *const _),
                Some(wrapped.as_mut_slice()),
                &mut size,
                NCRYPT_PAD_OAEP_FLAG,
            )
            .map_err(|e| format!("NCryptEncrypt failed: {e}"))?;
        }
        wrapped.truncate(size as usize);
        Ok(wrapped)
    }

    fn unwrap_scalar(&self, wrapped: &[u8]) -> Result<Vec<u8>, String> {
        let padding_info = BCRYPT_OAEP_PADDING_INFO {
            pszAlgId: PCWSTR(BCRYPT_SHA256_ALGORITHM.as_ptr()),
            pbLabel: ptr::null_mut(),
            cbLabel: 0,
        };

        let mut size: u32 = 0;
        unsafe {
            NCryptDecrypt(
                self.key,
                Some(wrapped),
                Some(&padding_info as *const _ as *const _),
                None,
                &mut size,
                NCRYPT_PAD_OAEP_FLAG,
            )
            .map_err(|e| format!("NCryptDecrypt size query failed: {e}"))?;
        }

        let mut plain = vec![0u8; size as usize];
        unsafe {
            NCryptDecrypt(
                self.key,
                Some(wrapped),
                Some(&padding_info as *const _ as *const _),
                Some(plain.as_mut_slice()),
                &mut size,
                NCRYPT_PAD_OAEP_FLAG,
            )
            .map_err(|e| format!("NCryptDecrypt failed: {e}"))?;
        }
        plain.truncate(size as usize);
        Ok(plain)
    }
}

fn create_seal_key(
    provider: NCRYPT_PROV_HANDLE,
    key_name: &[u16],
) -> Result<NCRYPT_KEY_HANDLE, String> {
    let mut key = NCRYPT_KEY_HANDLE::default();
    unsafe {
        NCryptCreatePersistedKey(
            provider,
            &mut key,
            PCWSTR(BCRYPT_RSA_ALGORITHM.as_ptr()),
            PCWSTR(key_name.as_ptr()),
            CERT_KEY_SPEC(0),
            NCRYPT_FLAGS(0),
        )
        .map_err(|e| format!("NCryptCreatePersistedKey failed: {e}"))?;

        NCryptFinalizeKey(key, NCRYPT_FLAGS(0))
            .map_err(|e| {
                let _ = NCryptFreeObject(key);
                format!("NCryptFinalizeKey failed: {e}")
            })?;
    }
    Ok(key)
}

/// Check if NCrypt/TPM sealing is available on this machine.
pub fn check_ncrypt_status() -> NcryptStatus {
    match SealKeySession::open() {
        Ok(_) => NcryptStatus::Available,
        Err(e) => NcryptStatus::ProviderFailed(e),
    }
}

/// Simple check: is NCrypt/TPM sealing available?
pub fn is_ncrypt_available() -> bool {
    matches!(check_ncrypt_status(), NcryptStatus::Available)
}

/// Protect a 32-byte P-256 scalar using TPM-backed NCrypt sealing.
pub fn ncrypt_protect(scalar: &[u8]) -> Result<Vec<u8>, String> {
    let session = SealKeySession::open()?;
    session.wrap_scalar(scalar)
}

/// Unprotect an NCrypt-sealed scalar blob.
pub fn ncrypt_unprotect(wrapped: &[u8]) -> Result<Vec<u8>, String> {
    let session = SealKeySession::open()?;
    session.unwrap_scalar(wrapped)
}

/// Setup hint when TPM/PCP might be available but isn't working.
pub fn get_ncrypt_setup_hint() -> Option<String> {
    match check_ncrypt_status() {
        NcryptStatus::Available => None,
        NcryptStatus::ProviderFailed(msg) => Some(format!(
            "TPM sealing unavailable ({msg}). Keys will use DPAPI instead. \
             Ensure TPM 2.0 is enabled in firmware and the device is not in a restricted mode."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "windows")]
    fn ncrypt_round_trip_if_available() {
        if !is_ncrypt_available() {
            eprintln!("Skipping NCrypt test: TPM/PCP not available");
            return;
        }
        let scalar = [0x42u8; 32];
        let wrapped = ncrypt_protect(&scalar).expect("protect");
        let unwrapped = ncrypt_unprotect(&wrapped).expect("unprotect");
        assert_eq!(unwrapped, scalar);
    }
}
