//! The varlock ECIES wire format, shared by every backend.
//!
//!   version(1) | ephemeralPub(65) | nonce(12) | ciphertext(N) | tag(16)
//!
//! P-256 ECDH, HKDF-SHA256 (salt "varlock-ecies-v1", info = ephemeralPub ||
//! recipientPub), AES-256-GCM.
//!
//! Three implementations write these bytes: this one, the Swift daemon's
//! `Ecies.swift`, and the TypeScript library's `crypto.ts`. `crypto.ts` is the
//! reference, and the fixture in
//! `packages/encryption-binary-swift/swift/Tests/IdentitySessionsTests/fixtures/ecies-vector.json`
//! is what pins all three to it: the tests at the bottom of this file read the
//! same checked-in file the Swift tests do. A failure there means the
//! implementations have drifted, so regenerate the fixture only when the wire
//! format changed on purpose.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use elliptic_curve::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use hkdf::Hkdf;
use p256::{
    ecdh::EphemeralSecret,
    elliptic_curve::rand_core::OsRng,
    PublicKey, SecretKey,
};
use sha2::Sha256;
use zeroize::Zeroize;

/// Payload encrypted directly to a device key (Secure Enclave / TPM / file)
pub const DEVICE_PAYLOAD_VERSION: u8 = 0x01;
/// Payload encrypted to an identity public key, which is itself wrapped to a device key
pub const IDENTITY_PAYLOAD_VERSION: u8 = 0x02;

const HKDF_SALT: &[u8] = b"varlock-ecies-v1";
const PUBLIC_KEY_LENGTH: usize = 65; // uncompressed P-256: 0x04 || x(32) || y(32)
const NONCE_LENGTH: usize = 12;
const TAG_LENGTH: usize = 16;
const HEADER_LENGTH: usize = 1 + PUBLIC_KEY_LENGTH + NONCE_LENGTH;
/// The raw private scalar for P-256
const SCALAR_LENGTH: usize = 32;

/// A P-256 key pair with base64-encoded components.
pub struct KeyPair {
    /// Base64-encoded uncompressed P-256 public key (65 bytes raw)
    pub public_key: String,
    /// Base64-encoded PKCS8 DER private key
    pub private_key: String,
}

/// Generate a new P-256 key pair.
///
/// Returns the public key as uncompressed SEC1 (65 bytes, base64) and the
/// private key as PKCS8 DER (base64), matching the JS/Swift format.
pub fn generate_key_pair() -> Result<KeyPair, String> {
    let secret_key = SecretKey::random(&mut OsRng);

    let public_key_point = secret_key.public_key().to_encoded_point(false);
    let public_key_bytes = public_key_point.as_bytes();

    let private_key_pkcs8 = secret_key
        .to_pkcs8_der()
        .map_err(|e| format!("Failed to encode private key as PKCS8: {e}"))?;

    Ok(KeyPair {
        public_key: BASE64.encode(public_key_bytes),
        private_key: BASE64.encode(private_key_pkcs8.as_bytes()),
    })
}

// ── Key import ───────────────────────────────────────────────────

/// Load a P-256 private key from the PKCS#8 DER the TS side produces.
pub fn secret_key_from_pkcs8(der: &[u8]) -> Result<SecretKey, String> {
    SecretKey::from_pkcs8_der(der).map_err(|e| format!("Invalid PKCS8 private key: {e}"))
}

/// Load a P-256 private key from its raw 32-byte scalar.
///
/// This is the form the daemon holds a session's identity key in: the scalar is
/// the whole secret, and it is 32 fixed bytes, which is what
/// [`crate::secure_mem::GuardedBuffer`] wants.
pub fn secret_key_from_scalar(scalar: &[u8]) -> Result<SecretKey, String> {
    if scalar.len() != SCALAR_LENGTH {
        return Err(format!(
            "Invalid P-256 scalar length: {} (expected {SCALAR_LENGTH})",
            scalar.len()
        ));
    }
    SecretKey::from_slice(scalar).map_err(|e| format!("Invalid P-256 private scalar: {e}"))
}

/// The uncompressed SEC1 public key for a private key, 65 bytes.
pub fn public_key_bytes(secret_key: &SecretKey) -> Vec<u8> {
    secret_key.public_key().to_encoded_point(false).as_bytes().to_vec()
}

// ── HKDF ─────────────────────────────────────────────────────────

fn derive_aes_key(
    shared_secret: &[u8],
    ephemeral_pub: &[u8],
    recipient_pub: &[u8],
) -> Result<[u8; 32], String> {
    let mut info = Vec::with_capacity(ephemeral_pub.len() + recipient_pub.len());
    info.extend_from_slice(ephemeral_pub);
    info.extend_from_slice(recipient_pub);

    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), shared_secret);
    let mut aes_key = [0u8; 32];
    hk.expand(&info, &mut aes_key)
        .map_err(|e| format!("HKDF expand failed: {e}"))?;
    Ok(aes_key)
}

// ── Encrypt ──────────────────────────────────────────────────────

/// Encrypt to a recipient public key given in its raw uncompressed SEC1 form.
///
/// Needs no private key and no auth gate: this is how the daemon can capture a
/// secret and hand back only ciphertext, without unlocking anything.
pub fn encrypt_to_public_key(
    recipient_pub_bytes: &[u8],
    plaintext: &[u8],
    version: u8,
) -> Result<Vec<u8>, String> {
    if recipient_pub_bytes.len() != PUBLIC_KEY_LENGTH {
        return Err(format!(
            "Invalid public key length: {} (expected {PUBLIC_KEY_LENGTH})",
            recipient_pub_bytes.len()
        ));
    }

    let recipient_point = p256::EncodedPoint::from_bytes(recipient_pub_bytes)
        .map_err(|e| format!("Invalid public key encoding: {e}"))?;
    let recipient_pub = PublicKey::from_encoded_point(&recipient_point)
        .into_option()
        .ok_or("Invalid P-256 public key point")?;

    let ephemeral_secret = EphemeralSecret::random(&mut OsRng);
    let ephemeral_pub_point = ephemeral_secret.public_key().to_encoded_point(false);
    let ephemeral_pub_raw = ephemeral_pub_point.as_bytes(); // 65 bytes

    let shared_secret = ephemeral_secret.diffie_hellman(&recipient_pub);
    let mut aes_key = derive_aes_key(
        shared_secret.raw_secret_bytes(),
        ephemeral_pub_raw,
        recipient_pub_bytes,
    )?;

    let cipher = Aes256Gcm::new_from_slice(&aes_key).map_err(|e| {
        aes_key.zeroize();
        format!("AES key init failed: {e}")
    })?;
    aes_key.zeroize(); // the cipher has its own copy

    let mut nonce_bytes = [0u8; NONCE_LENGTH];
    rand::RngCore::fill_bytes(&mut OsRng, &mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext_with_tag = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("AES-GCM encryption failed: {e}"))?;

    // AES-GCM appends the tag to the ciphertext, which is also the wire order,
    // so the two halves need no splitting here.
    let mut payload = Vec::with_capacity(HEADER_LENGTH + ciphertext_with_tag.len());
    payload.push(version);
    payload.extend_from_slice(ephemeral_pub_raw);
    payload.extend_from_slice(&nonce_bytes);
    payload.extend_from_slice(&ciphertext_with_tag);
    Ok(payload)
}

/// Encrypt to a base64 public key, stamping the device version byte.
///
/// The long-standing entry point, kept for the one-shot `encrypt` command and
/// the daemon's `encrypt` action.
pub fn encrypt(public_key_base64: &str, plaintext: &[u8]) -> Result<String, String> {
    let recipient_pub_bytes = BASE64
        .decode(public_key_base64)
        .map_err(|e| format!("Invalid public key base64: {e}"))?;
    let payload = encrypt_to_public_key(&recipient_pub_bytes, plaintext, DEVICE_PAYLOAD_VERSION)?;
    Ok(BASE64.encode(&payload))
}

// ── Decrypt ──────────────────────────────────────────────────────

struct PayloadParts<'a> {
    version: u8,
    ephemeral_pub: &'a [u8],
    nonce: &'a [u8],
    ciphertext_and_tag: &'a [u8],
}

/// Split a payload into its parts, validating the framing but not the key.
fn parse_payload(payload: &[u8]) -> Result<PayloadParts<'_>, String> {
    if payload.len() < HEADER_LENGTH + TAG_LENGTH {
        return Err("Payload too short".into());
    }
    Ok(PayloadParts {
        version: payload[0],
        ephemeral_pub: &payload[1..1 + PUBLIC_KEY_LENGTH],
        nonce: &payload[1 + PUBLIC_KEY_LENGTH..HEADER_LENGTH],
        ciphertext_and_tag: &payload[HEADER_LENGTH..],
    })
}

/// Decrypt a payload with the recipient's private key.
///
/// `accepted_versions` is checked against the payload's version byte. That byte
/// is outside the AEAD tag, so it is a routing hint rather than an authenticated
/// claim: flipping it only sends the payload at the wrong key, where it fails.
///
/// The recipient public key that goes into the HKDF info is derived from the
/// private key rather than passed in, so a caller cannot get a decrypt to
/// succeed against a public key that is not the one it holds.
pub fn decrypt_payload(
    secret_key: &SecretKey,
    payload: &[u8],
    accepted_versions: &[u8],
) -> Result<Vec<u8>, String> {
    let parts = parse_payload(payload)?;
    if !accepted_versions.contains(&parts.version) {
        return Err(format!(
            "Unsupported encrypted payload version {}; upgrade varlock",
            parts.version
        ));
    }

    let ephemeral_point = p256::EncodedPoint::from_bytes(parts.ephemeral_pub)
        .map_err(|e| format!("Invalid ephemeral public key: {e}"))?;
    let ephemeral_pub = PublicKey::from_encoded_point(&ephemeral_point)
        .into_option()
        .ok_or("Invalid ephemeral P-256 point")?;

    let recipient_pub_bytes = public_key_bytes(secret_key);
    let shared_secret =
        p256::ecdh::diffie_hellman(secret_key.to_nonzero_scalar(), ephemeral_pub.as_affine());
    let mut aes_key = derive_aes_key(
        shared_secret.raw_secret_bytes(),
        parts.ephemeral_pub,
        &recipient_pub_bytes,
    )?;

    let cipher = Aes256Gcm::new_from_slice(&aes_key).map_err(|e| {
        aes_key.zeroize();
        format!("AES key init failed: {e}")
    })?;
    aes_key.zeroize(); // the cipher has its own copy

    let nonce = Nonce::from_slice(parts.nonce);
    cipher
        .decrypt(nonce, parts.ciphertext_and_tag)
        .map_err(|_| "Decryption failed: invalid ciphertext or key".to_string())
}

/// Decrypt a base64 device payload with a base64 PKCS8 private key.
///
/// The long-standing entry point, kept for the one-shot `decrypt` command and
/// the daemon's `decrypt` action. Device payloads only: an identity payload has
/// to go through the session ops, which is where the grant is checked.
pub fn decrypt(
    private_key_base64: &str,
    _public_key_base64: &str,
    ciphertext_base64: &str,
) -> Result<Vec<u8>, String> {
    let payload = BASE64
        .decode(ciphertext_base64)
        .map_err(|e| format!("Invalid ciphertext base64: {e}"))?;

    let mut private_key_der = BASE64
        .decode(private_key_base64)
        .map_err(|e| format!("Invalid private key base64: {e}"))?;
    let secret_key = secret_key_from_pkcs8(&private_key_der);
    private_key_der.zeroize(); // the SecretKey has its own copy
    let secret_key = secret_key?;

    decrypt_payload(&secret_key, &payload, &[DEVICE_PAYLOAD_VERSION])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::path::PathBuf;

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

        assert_eq!(payload[0], DEVICE_PAYLOAD_VERSION);
        // 1 + 65 + 12 + N + 16
        assert!(payload.len() >= HEADER_LENGTH + TAG_LENGTH);
        // uncompressed ephemeral public key
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

    #[test]
    fn an_identity_payload_round_trips() {
        let kp = generate_key_pair().unwrap();
        let recipient_pub = BASE64.decode(&kp.public_key).unwrap();
        let payload =
            encrypt_to_public_key(&recipient_pub, "hello 🔐".as_bytes(), IDENTITY_PAYLOAD_VERSION)
                .unwrap();
        assert_eq!(payload[0], IDENTITY_PAYLOAD_VERSION);

        let secret = secret_key_from_pkcs8(&BASE64.decode(&kp.private_key).unwrap()).unwrap();
        let plaintext = decrypt_payload(&secret, &payload, &[IDENTITY_PAYLOAD_VERSION]).unwrap();
        assert_eq!(String::from_utf8(plaintext).unwrap(), "hello 🔐");
    }

    #[test]
    fn a_version_the_caller_did_not_ask_for_is_refused() {
        let kp = generate_key_pair().unwrap();
        let recipient_pub = BASE64.decode(&kp.public_key).unwrap();
        let secret = secret_key_from_pkcs8(&BASE64.decode(&kp.private_key).unwrap()).unwrap();

        let identity_payload =
            encrypt_to_public_key(&recipient_pub, b"x", IDENTITY_PAYLOAD_VERSION).unwrap();
        let err = decrypt_payload(&secret, &identity_payload, &[DEVICE_PAYLOAD_VERSION])
            .expect_err("a v2 payload must not open on the device path");
        assert!(err.contains("Unsupported encrypted payload version 2"));

        // and the device payload is refused on the identity path
        let device_payload =
            encrypt_to_public_key(&recipient_pub, b"x", DEVICE_PAYLOAD_VERSION).unwrap();
        assert!(decrypt_payload(&secret, &device_payload, &[IDENTITY_PAYLOAD_VERSION]).is_err());
    }

    #[test]
    fn the_legacy_decrypt_entry_point_refuses_identity_payloads() {
        let kp = generate_key_pair().unwrap();
        let recipient_pub = BASE64.decode(&kp.public_key).unwrap();
        let payload =
            encrypt_to_public_key(&recipient_pub, b"x", IDENTITY_PAYLOAD_VERSION).unwrap();
        let err = decrypt(&kp.private_key, &kp.public_key, &BASE64.encode(&payload)).unwrap_err();
        assert!(err.contains("upgrade varlock"), "{err}");
    }

    #[test]
    fn a_scalar_and_its_pkcs8_are_the_same_key() {
        let kp = generate_key_pair().unwrap();
        let der = BASE64.decode(&kp.private_key).unwrap();
        let from_der = secret_key_from_pkcs8(&der).unwrap();
        let scalar = crate::key_store::scalar::pkcs8_to_raw_scalar(&der).unwrap();
        let from_scalar = secret_key_from_scalar(&scalar).unwrap();
        assert_eq!(public_key_bytes(&from_der), public_key_bytes(&from_scalar));

        let payload = encrypt_to_public_key(
            &public_key_bytes(&from_der),
            b"same key either way",
            IDENTITY_PAYLOAD_VERSION,
        )
        .unwrap();
        let plaintext =
            decrypt_payload(&from_scalar, &payload, &[IDENTITY_PAYLOAD_VERSION]).unwrap();
        assert_eq!(plaintext, b"same key either way");
    }

    #[test]
    fn a_scalar_of_the_wrong_length_is_refused() {
        assert!(secret_key_from_scalar(&[0u8; 31]).is_err());
        assert!(secret_key_from_scalar(&[]).is_err());
    }

    #[test]
    fn a_truncated_payload_is_refused() {
        let kp = generate_key_pair().unwrap();
        let secret = secret_key_from_pkcs8(&BASE64.decode(&kp.private_key).unwrap()).unwrap();
        let err = decrypt_payload(&secret, &[0x02; 10], &[IDENTITY_PAYLOAD_VERSION]).unwrap_err();
        assert_eq!(err, "Payload too short");
    }

    #[test]
    fn a_tampered_tag_is_refused() {
        let kp = generate_key_pair().unwrap();
        let recipient_pub = BASE64.decode(&kp.public_key).unwrap();
        let secret = secret_key_from_pkcs8(&BASE64.decode(&kp.private_key).unwrap()).unwrap();

        let mut payload =
            encrypt_to_public_key(&recipient_pub, b"do not tamper", IDENTITY_PAYLOAD_VERSION)
                .unwrap();
        let last = payload.len() - 1;
        payload[last] ^= 0xff;
        assert!(decrypt_payload(&secret, &payload, &[IDENTITY_PAYLOAD_VERSION]).is_err());
    }

    // ── Cross-implementation compatibility ───────────────────────
    //
    // The same fixture the Swift `EciesCompatTests` read, loaded from the same
    // checked-in file rather than a copy, so the two daemons cannot be pinned to
    // different versions of it.

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        version: u8,
        public_key: String,
        private_key_pkcs8: String,
        plaintext: String,
        payload: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        hkdf_salt: String,
        identity: Vector,
        device: Vector,
    }

    fn fixture_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../encryption-binary-swift/swift/Tests/IdentitySessionsTests/fixtures/ecies-vector.json",
        )
    }

    fn load_fixture() -> Fixture {
        let path = fixture_path();
        let data = std::fs::read(&path).unwrap_or_else(|e| {
            panic!(
                "could not read the shared ECIES fixture at {}: {e}",
                path.display()
            )
        });
        serde_json::from_slice(&data).expect("the shared ECIES fixture should parse")
    }

    fn secret_for(vector: &Vector) -> SecretKey {
        let der = BASE64.decode(&vector.private_key_pkcs8).expect("base64 PKCS8");
        secret_key_from_pkcs8(&der).expect("the fixture key should import")
    }

    #[test]
    fn reads_the_identity_payload_typescript_wrote() {
        let fixture = load_fixture();
        assert_eq!(fixture.identity.version, IDENTITY_PAYLOAD_VERSION);

        let payload = BASE64.decode(&fixture.identity.payload).expect("base64 payload");
        assert_eq!(payload.first(), Some(&IDENTITY_PAYLOAD_VERSION));

        let plaintext = decrypt_payload(
            &secret_for(&fixture.identity),
            &payload,
            &[IDENTITY_PAYLOAD_VERSION],
        )
        .expect("the identity vector should decrypt");
        assert_eq!(String::from_utf8(plaintext).unwrap(), fixture.identity.plaintext);
    }

    #[test]
    fn reads_the_device_payload_typescript_wrote() {
        let fixture = load_fixture();
        assert_eq!(fixture.device.version, DEVICE_PAYLOAD_VERSION);

        let payload = BASE64.decode(&fixture.device.payload).expect("base64 payload");
        let plaintext = decrypt_payload(
            &secret_for(&fixture.device),
            &payload,
            &[DEVICE_PAYLOAD_VERSION],
        )
        .expect("the device vector should decrypt");
        assert_eq!(String::from_utf8(plaintext).unwrap(), fixture.device.plaintext);
    }

    #[test]
    fn writes_what_the_fixture_key_can_read_back() {
        // The other direction: a payload this implementation produces has to
        // open under the fixture's own key, which is how the daemon's capture
        // path (encrypt to an identity public key) stays readable elsewhere.
        let fixture = load_fixture();
        let recipient_pub = BASE64.decode(&fixture.identity.public_key).expect("base64 public key");

        let payload = encrypt_to_public_key(
            &recipient_pub,
            fixture.identity.plaintext.as_bytes(),
            IDENTITY_PAYLOAD_VERSION,
        )
        .expect("should encrypt to the fixture identity");

        let plaintext = decrypt_payload(
            &secret_for(&fixture.identity),
            &payload,
            &[IDENTITY_PAYLOAD_VERSION],
        )
        .expect("our own payload should decrypt");
        assert_eq!(String::from_utf8(plaintext).unwrap(), fixture.identity.plaintext);
    }

    #[test]
    fn the_fixtures_public_key_is_the_one_its_private_key_derives() {
        let fixture = load_fixture();
        for vector in [&fixture.identity, &fixture.device] {
            let expected = BASE64.decode(&vector.public_key).unwrap();
            assert_eq!(public_key_bytes(&secret_for(vector)), expected);
        }
    }

    #[test]
    fn the_fixture_pins_the_hkdf_salt_this_build_uses() {
        let fixture = load_fixture();
        assert_eq!(fixture.hkdf_salt.as_bytes(), HKDF_SALT);
    }
}
