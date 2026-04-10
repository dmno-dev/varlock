//! ECIES implementation matching the JS (crypto.ts) and Swift (SecureEnclaveManager.swift) schemes.
//!
//! Wire-compatible payload format:
//!   version(1) | ephemeralPubKey(65) | nonce(12) | ciphertext(N) | tag(16)
//!
//! Crypto:
//!   - P-256 ECDH key agreement
//!   - HKDF-SHA256 (salt: "varlock-ecies-v1", info: ephemeralPub || recipientPub)
//!   - AES-256-GCM with random 12-byte nonce

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use hkdf::Hkdf;
use elliptic_curve::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use p256::{
    ecdh::EphemeralSecret,
    elliptic_curve::rand_core::OsRng,
    PublicKey, SecretKey,
};
use sha2::Sha256;
use zeroize::Zeroize;

const PAYLOAD_VERSION: u8 = 0x01;
const HKDF_SALT: &[u8] = b"varlock-ecies-v1";
const PUBLIC_KEY_LENGTH: usize = 65; // uncompressed P-256: 0x04 || x(32) || y(32)
const NONCE_LENGTH: usize = 12;
const TAG_LENGTH: usize = 16;
const HEADER_LENGTH: usize = 1 + PUBLIC_KEY_LENGTH + NONCE_LENGTH;

/// A P-256 key pair with base64-encoded components.
pub struct KeyPair {
    /// Base64-encoded uncompressed P-256 public key (65 bytes raw)
    pub public_key: String,
    /// Base64-encoded PKCS8 DER private key
    pub private_key: String,
}

/// Generate a new P-256 key pair.
///
/// Returns the public key as uncompressed SEC1 (65 bytes, base64) and
/// the private key as PKCS8 DER (base64), matching the JS/Swift format.
pub fn generate_key_pair() -> Result<KeyPair, String> {
    let secret_key = SecretKey::random(&mut OsRng);

    // Public key: uncompressed SEC1 encoding (65 bytes)
    let public_key_point = secret_key.public_key().to_encoded_point(false);
    let public_key_bytes = public_key_point.as_bytes();

    // Private key: PKCS8 DER encoding
    let private_key_pkcs8 = secret_key
        .to_pkcs8_der()
        .map_err(|e| format!("Failed to encode private key as PKCS8: {e}"))?;

    Ok(KeyPair {
        public_key: BASE64.encode(public_key_bytes),
        private_key: BASE64.encode(private_key_pkcs8.as_bytes()),
    })
}

/// Encrypt plaintext using ECIES with the recipient's public key.
///
/// Only needs the public key — no private key or biometric auth required.
/// Returns base64-encoded ciphertext payload.
pub fn encrypt(public_key_base64: &str, plaintext: &[u8]) -> Result<String, String> {
    let recipient_pub_bytes = BASE64
        .decode(public_key_base64)
        .map_err(|e| format!("Invalid public key base64: {e}"))?;

    if recipient_pub_bytes.len() != PUBLIC_KEY_LENGTH {
        return Err(format!(
            "Invalid public key length: {} (expected {})",
            recipient_pub_bytes.len(),
            PUBLIC_KEY_LENGTH
        ));
    }

    // Import recipient public key
    let recipient_point = p256::EncodedPoint::from_bytes(&recipient_pub_bytes)
        .map_err(|e| format!("Invalid public key encoding: {e}"))?;
    let recipient_pub = PublicKey::from_encoded_point(&recipient_point)
        .into_option()
        .ok_or("Invalid P-256 public key point")?;

    // Generate ephemeral key pair
    let ephemeral_secret = EphemeralSecret::random(&mut OsRng);
    let ephemeral_pub = ephemeral_secret.public_key();
    let ephemeral_pub_bytes = ephemeral_pub.to_encoded_point(false);
    let ephemeral_pub_raw = ephemeral_pub_bytes.as_bytes(); // 65 bytes

    // ECDH: ephemeral private × recipient public → shared secret
    let shared_secret = ephemeral_secret.diffie_hellman(&recipient_pub);
    let shared_secret_bytes = shared_secret.raw_secret_bytes();

    // HKDF-SHA256 → AES-256 key
    // info = ephemeralPubKey || recipientPubKey
    let mut info = Vec::with_capacity(PUBLIC_KEY_LENGTH * 2);
    info.extend_from_slice(ephemeral_pub_raw);
    info.extend_from_slice(&recipient_pub_bytes);

    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), shared_secret_bytes);
    let mut aes_key = [0u8; 32];
    hk.expand(&info, &mut aes_key)
        .map_err(|e| format!("HKDF expand failed: {e}"))?;

    // AES-256-GCM encrypt
    let cipher = Aes256Gcm::new_from_slice(&aes_key)
        .map_err(|e| {
            aes_key.zeroize();
            format!("AES key init failed: {e}")
        })?;
    aes_key.zeroize(); // Cipher has its own copy

    let mut nonce_bytes = [0u8; NONCE_LENGTH];
    rand::RngCore::fill_bytes(&mut OsRng, &mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext_with_tag = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("AES-GCM encryption failed: {e}"))?;

    // AES-GCM appends tag to ciphertext — split for wire format
    let ct_len = ciphertext_with_tag.len() - TAG_LENGTH;
    let ciphertext = &ciphertext_with_tag[..ct_len];
    let tag = &ciphertext_with_tag[ct_len..];

    // Assemble payload: version(1) | ephemeralPub(65) | nonce(12) | ciphertext(N) | tag(16)
    let mut payload = Vec::with_capacity(HEADER_LENGTH + ciphertext.len() + TAG_LENGTH);
    payload.push(PAYLOAD_VERSION);
    payload.extend_from_slice(ephemeral_pub_raw);
    payload.extend_from_slice(&nonce_bytes);
    payload.extend_from_slice(ciphertext);
    payload.extend_from_slice(tag);

    Ok(BASE64.encode(&payload))
}

/// Decrypt ciphertext using ECIES with the recipient's private key.
///
/// `private_key_base64` is PKCS8 DER, `public_key_base64` is uncompressed SEC1.
/// `ciphertext_base64` is the base64-encoded wire-format payload.
/// Returns decrypted plaintext bytes.
pub fn decrypt(
    private_key_base64: &str,
    public_key_base64: &str,
    ciphertext_base64: &str,
) -> Result<Vec<u8>, String> {
    let payload = BASE64
        .decode(ciphertext_base64)
        .map_err(|e| format!("Invalid ciphertext base64: {e}"))?;

    if payload.len() < HEADER_LENGTH + TAG_LENGTH {
        return Err("Payload too short".into());
    }

    // Parse payload
    let version = payload[0];
    if version != PAYLOAD_VERSION {
        return Err(format!("Unsupported payload version: {version}"));
    }

    let ephemeral_pub_raw = &payload[1..1 + PUBLIC_KEY_LENGTH];
    let nonce_bytes = &payload[1 + PUBLIC_KEY_LENGTH..HEADER_LENGTH];
    let ciphertext_and_tag = &payload[HEADER_LENGTH..];

    if ciphertext_and_tag.len() < TAG_LENGTH {
        return Err("Payload too short for tag".into());
    }

    // Import private key from PKCS8 DER
    let mut private_key_der = BASE64
        .decode(private_key_base64)
        .map_err(|e| format!("Invalid private key base64: {e}"))?;
    let secret_key = SecretKey::from_pkcs8_der(&private_key_der)
        .map_err(|e| {
            private_key_der.zeroize();
            format!("Invalid PKCS8 private key: {e}")
        })?;
    private_key_der.zeroize(); // No longer needed — SecretKey has its own copy

    // Import ephemeral public key
    let ephemeral_point = p256::EncodedPoint::from_bytes(ephemeral_pub_raw)
        .map_err(|e| format!("Invalid ephemeral public key: {e}"))?;
    let ephemeral_pub = PublicKey::from_encoded_point(&ephemeral_point)
        .into_option()
        .ok_or("Invalid ephemeral P-256 point")?;

    // Recipient public key bytes for HKDF info
    let recipient_pub_bytes = BASE64
        .decode(public_key_base64)
        .map_err(|e| format!("Invalid public key base64: {e}"))?;

    // ECDH: recipient private × ephemeral public → shared secret
    let shared_secret = p256::ecdh::diffie_hellman(
        secret_key.to_nonzero_scalar(),
        ephemeral_pub.as_affine(),
    );
    let shared_secret_bytes = shared_secret.raw_secret_bytes();

    // HKDF-SHA256 → AES-256 key (must match encrypt side)
    let mut info = Vec::with_capacity(PUBLIC_KEY_LENGTH * 2);
    info.extend_from_slice(ephemeral_pub_raw);
    info.extend_from_slice(&recipient_pub_bytes);

    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), shared_secret_bytes);
    let mut aes_key = [0u8; 32];
    hk.expand(&info, &mut aes_key)
        .map_err(|e| format!("HKDF expand failed: {e}"))?;

    // AES-256-GCM decrypt
    // aes-gcm expects ciphertext || tag concatenated (same as wire format after header)
    let cipher = Aes256Gcm::new_from_slice(&aes_key)
        .map_err(|e| {
            aes_key.zeroize();
            format!("AES key init failed: {e}")
        })?;
    aes_key.zeroize(); // Cipher has its own copy — zeroize ours

    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext_and_tag)
        .map_err(|_| "Decryption failed: invalid ciphertext or key".to_string())?;

    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_roundtrip() {
        let kp = generate_key_pair().unwrap();
        let plaintext = b"hello world";
        let encrypted = encrypt(&kp.public_key, plaintext).unwrap();
        let decrypted = decrypt(&kp.private_key, &kp.public_key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_payload_format() {
        let kp = generate_key_pair().unwrap();
        let encrypted = encrypt(&kp.public_key, b"test").unwrap();
        let payload = BASE64.decode(&encrypted).unwrap();

        // Check version byte
        assert_eq!(payload[0], PAYLOAD_VERSION);
        // Check total minimum length: 1 + 65 + 12 + 0 + 16 = 94
        assert!(payload.len() >= HEADER_LENGTH + TAG_LENGTH);
        // Check ephemeral public key starts with 0x04 (uncompressed)
        assert_eq!(payload[1], 0x04);
    }

    #[test]
    fn test_different_keys_cannot_decrypt() {
        let kp1 = generate_key_pair().unwrap();
        let kp2 = generate_key_pair().unwrap();
        let encrypted = encrypt(&kp1.public_key, b"secret").unwrap();
        let result = decrypt(&kp2.private_key, &kp2.public_key, &encrypted);
        assert!(result.is_err());
    }
}
