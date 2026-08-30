//! The real device-key half of an unlock.
//!
//! Everything platform-specific about holding an identity key lives here: which
//! device key unwraps it, and what the user has to do first. The session rules
//! themselves are in [`super::manager`] and never touch a TPM, a keyring, or a
//! fingerprint reader, which is what makes them testable everywhere.
//!
//! Custody chain, unchanged from the macOS design:
//!
//!   device key (NCrypt/TPM or DPAPI on Windows, TPM2 or Secret Service on
//!   Linux) -> identity key -> values
//!
//! The wrap blob in the identity file is a v1 ECIES payload encrypted to the
//! device public key, so unwrapping it is an ordinary device decrypt. The
//! presence check is separate from that decrypt on both platforms (unlike the
//! Secure Enclave, where the two are the same operation), so it is run first,
//! once per unlock, before any unwrapping happens.

use crate::crypto;
use crate::key_store;
use crate::secure_mem::GuardedBuffer;
use zeroize::Zeroize;

use super::manager::{CustodyBackend, SessionError};

/// Unwraps identity keys through the platform key store.
pub struct KeyStoreCustody {
    /// Whether this machine has any way to check for a person at all. Cached at
    /// construction: it is a property of the machine, not of the request, and
    /// re-probing it per unlock would put a Windows Hello availability call on
    /// the hot path.
    presence_available: bool,
}

impl Default for KeyStoreCustody {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyStoreCustody {
    pub fn new() -> Self {
        Self { presence_available: key_store::get_platform_info().biometric_available }
    }
}

impl CustodyBackend for KeyStoreCustody {
    fn unwrap_identity_scalar(
        &self,
        key_id: &str,
        wrap: &[u8],
    ) -> Result<GuardedBuffer, SessionError> {
        let (mut device_private_der, _device_public) =
            key_store::load_key(key_id).map_err(SessionError::Crypto)?;
        let device_key = crypto::secret_key_from_pkcs8(&device_private_der);
        device_private_der.zeroize();
        let device_key = device_key.map_err(SessionError::Crypto)?;

        // The wrap is a device payload: the identity key encrypted to this
        // machine's device key by the TypeScript side.
        let mut identity_der =
            crypto::decrypt_payload(&device_key, wrap, &[crypto::DEVICE_PAYLOAD_VERSION])
                .map_err(|_| {
                    SessionError::Crypto(format!(
                        "Could not unwrap the identity key with device key \"{key_id}\""
                    ))
                })?;

        // Hold the 32-byte scalar rather than the PKCS#8 DER: the scalar is the
        // whole secret, it is a fixed size, and a fixed size is what a guarded
        // buffer can promise not to reallocate.
        let scalar = key_store::scalar::pkcs8_to_raw_scalar(&identity_der);
        identity_der.zeroize();
        let scalar = scalar.ok_or_else(|| {
            SessionError::Crypto("The unwrapped identity key is not a P-256 private key".into())
        })?;

        let mut scalar = scalar;
        let guarded = GuardedBuffer::take_vec(&mut scalar);
        Ok(guarded)
    }

    fn requires_presence(&self, key_id: &str) -> bool {
        // Two independent conditions. A key created with `--no-auth` (CI) has
        // nothing to ask about, and a machine with no Hello, no polkit, and no
        // PAM factor has nothing to ask with. Failing the unlock in the second
        // case would just make the feature unavailable on those machines, which
        // is not a security gain: the key material is protected at rest either
        // way.
        self.presence_available && key_store::key_requires_auth(key_id)
    }

    fn verify_presence(&self, reason: &str) -> Result<bool, String> {
        verify_user_presence(reason)
    }
}

/// Ask the platform to check that a person is there.
///
/// Windows shows the Hello dialog (face, fingerprint, or PIN). Linux goes
/// through polkit, which delegates to PAM, so the factor is whatever the user
/// has configured: fingerprint, face, a security key, or a password.
pub fn verify_user_presence(reason: &str) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        crate::key_store::windows_hello::verify_user(reason)
    }

    #[cfg(target_os = "linux")]
    {
        let _ = reason;
        crate::key_store::polkit::check_authorization()
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        // macOS runs the Swift daemon, so this build is a development one. There
        // is nothing to ask with, and `requires_presence` already returns false
        // here, so this is unreachable in practice.
        let _ = reason;
        Ok(true)
    }
}
