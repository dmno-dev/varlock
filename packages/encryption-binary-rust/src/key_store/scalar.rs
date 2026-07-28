//! Shared helpers for P-256 private key scalar ↔ PKCS8 conversion.
//!
//! TPM/NCrypt sealing stores the raw 32-byte scalar (not full PKCS8) because
//! PKCS8 DER is larger and the actual secret is the scalar.

use elliptic_curve::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use p256::SecretKey as P256SecretKey;

/// Extract the raw 32-byte P-256 private key scalar from PKCS8 DER.
/// Returns None if parsing fails (caller should fall back to full DER).
pub fn pkcs8_to_raw_scalar(pkcs8_der: &[u8]) -> Option<Vec<u8>> {
    let sk = P256SecretKey::from_pkcs8_der(pkcs8_der).ok()?;
    Some(sk.to_bytes().to_vec())
}

/// Reconstruct PKCS8 DER from a raw 32-byte P-256 scalar.
/// If input is not 32 bytes, return it unchanged (backward compat).
pub fn raw_scalar_to_pkcs8(raw: &[u8]) -> Result<Vec<u8>, String> {
    if raw.len() != 32 {
        // Not a raw scalar — return as-is (may already be PKCS8)
        return Ok(raw.to_vec());
    }
    let scalar = elliptic_curve::ScalarPrimitive::<p256::NistP256>::from_slice(raw)
        .map_err(|e| format!("Invalid P-256 scalar: {e}"))?;
    let sk = P256SecretKey::new(scalar);
    sk.to_pkcs8_der()
        .map(|d| d.as_bytes().to_vec())
        .map_err(|e| format!("Failed to encode PKCS8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto;

    #[test]
    fn scalar_round_trip() {
        let kp = crypto::generate_key_pair().unwrap();
        let pkcs8 = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &kp.private_key,
        )
        .unwrap();
        let scalar = pkcs8_to_raw_scalar(&pkcs8).unwrap();
        assert_eq!(scalar.len(), 32);
        let restored = raw_scalar_to_pkcs8(&scalar).unwrap();
        assert_eq!(restored, pkcs8);
    }
}
