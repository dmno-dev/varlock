//! Key storage abstraction.
//!
//! Each platform backend stores the P-256 private key in a protected manner:
//!   - Windows: DPAPI (CryptProtectData) — encrypted to the current user session
//!   - Linux: TPM2 seal/unseal via tpm2-tools — key sealed to hardware TPM chip
//!
//! All backends store the public key as plaintext (it's not secret) and the
//! private key in a platform-specific protected format. The key file format is:
//!
//!   ~/.config/varlock/local-encrypt/keys/{keyId}.json
//!   {
//!     "keyId": "varlock-default",
//!     "publicKey": "<base64 uncompressed SEC1>",
//!     "protectedPrivateKey": "<base64 platform-encrypted PKCS8>",
//!     "protection": "dpapi" | "tpm2" | "none",
//!     "createdAt": "2024-01-01T00:00:00Z"
//!   }
//!
//! The "none" protection level stores the private key as plaintext base64 —
//! equivalent to the JS file-based backend. Used as an absolute fallback.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[cfg(target_os = "linux")]
pub(crate) mod linux;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub(crate) mod windows_hello;

/// Which protection mechanism is used for the private key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Protection {
    /// Windows DPAPI — encrypted to current user session
    Dpapi,
    /// Linux TPM2 — sealed to hardware TPM chip
    Tpm2,
    /// No protection — plaintext on disk (fallback)
    None,
}

impl std::fmt::Display for Protection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Protection::Dpapi => write!(f, "dpapi"),
            Protection::Tpm2 => write!(f, "tpm2"),
            Protection::None => write!(f, "none"),
        }
    }
}

/// Stored key file format (JSON).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredKey {
    pub key_id: String,
    /// Base64 uncompressed P-256 public key (65 bytes raw)
    pub public_key: String,
    /// Base64 protected private key (protection-dependent format)
    pub protected_private_key: String,
    /// How the private key is protected
    pub protection: Protection,
    pub created_at: String,
}

/// Information about what key protection is available on this platform.
pub struct PlatformInfo {
    /// Backend name for status output
    pub backend: String,
    /// Whether keys are hardware-backed (TPM)
    pub hardware_backed: bool,
    /// Whether biometric unlock is available
    pub biometric_available: bool,
    /// What protection will be used for new keys
    pub protection: Protection,
}

// ── Path helpers ──────────────────────────────────────────────────

fn get_config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg).join("varlock");
    }

    let home = dirs_home();

    // Backwards compat: if ~/.varlock exists, use it
    let legacy = home.join(".varlock");
    if legacy.exists() {
        return legacy;
    }

    // Default: ~/.config/varlock (XDG standard)
    home.join(".config").join("varlock")
}

fn dirs_home() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("C:\\Users\\Default"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp"))
    }
}

fn get_key_store_dir() -> PathBuf {
    get_config_dir().join("local-encrypt").join("keys")
}

fn get_key_file_path(key_id: &str) -> PathBuf {
    get_key_store_dir().join(format!("{key_id}.json"))
}

// ── Platform-specific key protection ─────────────────────────────

/// Protect a private key using the best available platform mechanism.
/// Returns (protected_bytes_base64, protection_type).
fn protect_private_key(private_key_der: &[u8]) -> (String, Protection) {
    #[cfg(target_os = "windows")]
    {
        match windows::dpapi_protect(private_key_der) {
            Ok(protected) => (BASE64.encode(&protected), Protection::Dpapi),
            Err(e) => {
                eprintln!("Warning: DPAPI protection failed ({e}), falling back to plaintext");
                (BASE64.encode(private_key_der), Protection::None)
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if linux::is_tpm2_available() {
            match linux::tpm2_protect(private_key_der) {
                Ok(protected) => (BASE64.encode(&protected), Protection::Tpm2),
                Err(e) => {
                    eprintln!("Warning: TPM2 protection failed ({e}), falling back to plaintext");
                    (BASE64.encode(private_key_der), Protection::None)
                }
            }
        } else {
            // TPM2 not available — plaintext fallback
            if let Some(hint) = linux::get_tpm2_setup_hint() {
                eprintln!("Note: {hint}");
            }
            (BASE64.encode(private_key_der), Protection::None)
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        // Unsupported platform — plaintext fallback
        (BASE64.encode(private_key_der), Protection::None)
    }
}

/// Unprotect a private key, returning the raw PKCS8 DER bytes.
fn unprotect_private_key(protected_base64: &str, protection: &Protection) -> Result<Vec<u8>, String> {
    let protected_bytes = BASE64
        .decode(protected_base64)
        .map_err(|e| format!("Invalid base64: {e}"))?;

    match protection {
        Protection::None => Ok(protected_bytes),

        #[cfg(target_os = "windows")]
        Protection::Dpapi => windows::dpapi_unprotect(&protected_bytes),

        #[cfg(target_os = "linux")]
        Protection::Tpm2 => linux::tpm2_unprotect(&protected_bytes),

        #[allow(unreachable_patterns)]
        _ => Err(format!("Protection type '{protection}' not supported on this platform")),
    }
}

// ── Public API ───────────────────────────────────────────────────

/// Detect the platform capabilities and return status info.
pub fn get_platform_info() -> PlatformInfo {
    #[cfg(target_os = "windows")]
    {
        let hello_available = windows_hello::is_hello_available();
        PlatformInfo {
            backend: if hello_available { "windows-hello" } else { "windows-dpapi" }.into(),
            hardware_backed: false, // DPAPI is software-based; TPM NCrypt is TODO
            biometric_available: hello_available,
            protection: Protection::Dpapi,
        }
    }

    #[cfg(target_os = "linux")]
    {
        let tpm2_available = linux::is_tpm2_available();
        PlatformInfo {
            backend: if tpm2_available { "linux-tpm2" } else { "linux-file" }.into(),
            hardware_backed: tpm2_available,
            biometric_available: false, // fprintd integration is TODO
            protection: if tpm2_available { Protection::Tpm2 } else { Protection::None },
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        PlatformInfo {
            backend: "file".into(),
            hardware_backed: false,
            biometric_available: false,
            protection: Protection::None,
        }
    }
}

/// Get a setup hint for TPM2 if it could be available but isn't configured.
#[cfg(target_os = "linux")]
pub fn get_tpm2_setup_hint() -> Option<String> {
    linux::get_tpm2_setup_hint()
}

/// Check if a key exists.
pub fn key_exists(key_id: &str) -> bool {
    get_key_file_path(key_id).exists()
}

/// List all key IDs.
pub fn list_keys() -> Vec<String> {
    let dir = get_key_store_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return vec![],
    };

    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".json").map(|s| s.to_string())
        })
        .collect()
}

/// Generate a new key pair and store it with platform-specific protection.
/// Returns the base64 public key.
pub fn generate_key(key_id: &str) -> Result<String, String> {
    let key_pair = crate::crypto::generate_key_pair()?;

    // Decode the private key to protect it
    let private_key_der = BASE64
        .decode(&key_pair.private_key)
        .map_err(|e| format!("Failed to decode private key: {e}"))?;

    let (protected, protection) = protect_private_key(&private_key_der);

    let stored = StoredKey {
        key_id: key_id.to_string(),
        public_key: key_pair.public_key.clone(),
        protected_private_key: protected,
        protection,
        created_at: now_iso8601(),
    };

    // Write to disk
    let dir = get_key_store_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create key store: {e}"))?;

    let path = get_key_file_path(key_id);
    let json = serde_json::to_string_pretty(&stored)
        .map_err(|e| format!("Failed to serialize key: {e}"))?;

    // Write with restricted permissions
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true).mode(0o600);
        use std::io::Write;
        let mut file = opts.open(&path).map_err(|e| format!("Failed to write key file: {e}"))?;
        file.write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write key file: {e}"))?;
    }
    #[cfg(not(unix))]
    {
        fs::write(&path, &json).map_err(|e| format!("Failed to write key file: {e}"))?;
    }

    Ok(key_pair.public_key)
}

/// Delete a key.
pub fn delete_key(key_id: &str) -> bool {
    let path = get_key_file_path(key_id);
    fs::remove_file(path).is_ok()
}

/// Load a stored key and return (private_key_der, public_key_base64).
pub fn load_key(key_id: &str) -> Result<(Vec<u8>, String), String> {
    let path = get_key_file_path(key_id);
    let data = fs::read_to_string(&path).map_err(|_| format!("Key not found: {key_id}"))?;
    let stored: StoredKey =
        serde_json::from_str(&data).map_err(|e| format!("Corrupted key file: {e}"))?;

    let private_key_der = unprotect_private_key(&stored.protected_private_key, &stored.protection)?;
    Ok((private_key_der, stored.public_key))
}

/// Load just the public key (no protection needed).
pub fn load_public_key(key_id: &str) -> Result<String, String> {
    let path = get_key_file_path(key_id);
    let data = fs::read_to_string(&path).map_err(|_| format!("Key not found: {key_id}"))?;
    let stored: StoredKey =
        serde_json::from_str(&data).map_err(|e| format!("Corrupted key file: {e}"))?;
    Ok(stored.public_key)
}

fn now_iso8601() -> String {
    // Simple ISO 8601 without external crate
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    // Approximate UTC — good enough for metadata
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Calculate year/month/day from days since epoch (simplified)
    let mut y = 1970i64;
    let mut remaining_days = days as i64;
    loop {
        let days_in_year = if is_leap_year(y) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        y += 1;
    }
    let mut m = 1u32;
    let days_in_months = if is_leap_year(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    for dim in days_in_months {
        if remaining_days < dim {
            break;
        }
        remaining_days -= dim;
        m += 1;
    }
    let d = remaining_days + 1;

    format!("{y:04}-{m:02}-{d:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
