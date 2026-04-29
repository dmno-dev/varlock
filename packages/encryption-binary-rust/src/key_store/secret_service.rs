//! Linux Secret Service (libsecret / GNOME Keyring / KWallet) backend.
//!
//! Stores the protected private key as an item in the user's default keyring
//! collection. The keyring is automatically unlocked at login on mainstream
//! desktop distros, so this is a "just works" default for interactive users.
//!
//! The on-disk key file still records the keyId, public key, and protection
//! type — only the private-key material lives in the keyring.
//!
//! Availability: requires a running Secret Service provider (GNOME Keyring
//! or KWallet) reachable over the session D-Bus. Not available on headless
//! servers, WSL without a running daemon, or minimal containers.

use secret_service::blocking::SecretService;
use secret_service::EncryptionType;
use std::collections::HashMap;

const APP_ATTR: &str = "varlock";
const CONTENT_TYPE: &str = "application/octet-stream";

fn attrs(key_id: &str) -> HashMap<&str, &str> {
    let mut m = HashMap::new();
    m.insert("application", APP_ATTR);
    m.insert("keyId", key_id);
    m
}

fn connect() -> Result<SecretService<'static>, String> {
    // EncryptionType::Dh uses ephemeral DH key exchange for the transport of
    // the secret over D-Bus. Plain would send it unencrypted on the bus.
    SecretService::connect(EncryptionType::Dh)
        .map_err(|e| format!("Secret Service unavailable: {e}"))
}

/// Is the Secret Service reachable? Used to decide whether to use this backend.
pub fn is_available() -> bool {
    connect().is_ok()
}

/// Store (or overwrite) a secret keyed by key_id.
pub fn store(key_id: &str, secret: &[u8]) -> Result<(), String> {
    let ss = connect()?;
    let collection = ss
        .get_default_collection()
        .map_err(|e| format!("Failed to open default keyring collection: {e}"))?;

    if collection.is_locked().unwrap_or(true) {
        collection
            .unlock()
            .map_err(|e| format!("Failed to unlock keyring: {e}"))?;
    }

    let label = format!("Varlock Encryption Key ({key_id})");
    collection
        .create_item(&label, attrs(key_id), secret, true, CONTENT_TYPE)
        .map_err(|e| format!("Failed to store secret in keyring: {e}"))?;
    Ok(())
}

/// Retrieve the secret for key_id.
pub fn retrieve(key_id: &str) -> Result<Vec<u8>, String> {
    let ss = connect()?;
    let results = ss
        .search_items(attrs(key_id))
        .map_err(|e| format!("Failed to search keyring: {e}"))?;

    let item = results
        .unlocked
        .first()
        .or_else(|| results.locked.first())
        .ok_or_else(|| format!("Key not found in keyring: {key_id}"))?;

    if item.is_locked().unwrap_or(true) {
        item.unlock()
            .map_err(|e| format!("Failed to unlock keyring item: {e}"))?;
    }

    item.get_secret()
        .map_err(|e| format!("Failed to read secret from keyring: {e}"))
}

/// Delete any items matching key_id. Returns Ok(()) even if nothing was found.
pub fn delete(key_id: &str) -> Result<(), String> {
    let ss = connect()?;
    let results = ss
        .search_items(attrs(key_id))
        .map_err(|e| format!("Failed to search keyring: {e}"))?;

    for item in results.unlocked.iter().chain(results.locked.iter()) {
        item.delete()
            .map_err(|e| format!("Failed to delete keyring item: {e}"))?;
    }
    Ok(())
}
