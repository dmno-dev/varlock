//! Reads the identity files the TypeScript side writes.
//!
//! An identity is a software P-256 key pair whose private key is never stored in
//! the clear: it is ECIES-wrapped to one or more device keys, so unwrapping it
//! goes through whatever gate the device backend applies. The file format is
//! owned by `packages/varlock/src/lib/local-encrypt/identity.ts`:
//!
//! ```json
//! { "version": 1, "id": "default", "publicKey": "...", "wraps": { "<deviceKeyId>": "<ciphertext>" }, "createdAt": "..." }
//! ```
//!
//! Only ciphertext and public keys live here, so ordinary `String` handling is
//! fine. The unwrapped private key never passes through this module.

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const IDENTITY_FILE_VERSION: i64 = 1;
pub const DEFAULT_IDENTITY_ID: &str = "default";

/// Where the user-level state this daemon reads and writes lives.
///
/// Held as a value rather than read from a global so the tests can point a
/// manager at a temp directory without touching the developer's real one.
#[derive(Debug, Clone)]
pub struct SessionPaths {
    user_dir: PathBuf,
}

impl SessionPaths {
    /// The real locations, matching `getUserVarlockDir()` in the TS library and
    /// `IdentityStore.userVarlockDir` on the Swift side.
    pub fn from_user_config_dir() -> Self {
        Self { user_dir: crate::key_store::get_config_dir() }
    }

    /// Point the daemon's state at somewhere else. Only the tests do this: the
    /// real locations are fixed, and a daemon that could be told where to keep
    /// its audit log would be a daemon whose log could be redirected to
    /// /dev/null.
    #[cfg(test)]
    pub fn with_user_dir(user_dir: impl Into<PathBuf>) -> Self {
        Self { user_dir: user_dir.into() }
    }

    #[cfg(test)]
    pub fn user_dir(&self) -> &Path {
        &self.user_dir
    }

    pub fn identity_file(&self, identity_id: &str) -> PathBuf {
        self.user_dir.join("identities").join(format!("{identity_id}.json"))
    }

    /// The user-level config file varlock already keeps (telemetry settings live
    /// here too). Machine-wide, never project-level: a project must not be able
    /// to weaken how long this machine holds keys.
    pub fn machine_config_file(&self) -> PathBuf {
        self.user_dir.join("config.json")
    }

    /// Where the append-only authorization log lives. Under the user varlock dir
    /// so it inherits that directory's owner-only access.
    pub fn audit_dir(&self) -> PathBuf {
        self.user_dir.join("audit")
    }

    /// Read the config file's contents, or `None` when there is nothing to read.
    ///
    /// Read fresh at each unlock rather than cached or watched, so editing the
    /// file takes effect on the next unlock with no daemon restart.
    pub fn read_machine_config(&self) -> Option<Vec<u8>> {
        std::fs::read(self.machine_config_file()).ok()
    }

    pub fn read_identity(&self, identity_id: &str) -> Result<StoredIdentity, IdentityStoreError> {
        StoredIdentity::read(&self.identity_file(identity_id), identity_id)
    }
}

/// One identity, as it sits on disk.
#[derive(Debug, Clone)]
pub struct StoredIdentity {
    pub id: String,
    /// base64 uncompressed P-256 public key, as written by the TS side
    pub public_key_base64: String,
    /// device key id -> wrapped identity private key (base64 v1 payload)
    ///
    /// A `BTreeMap` so iteration order is the key id order rather than a hash
    /// order, which keeps "try the wraps in turn" reproducible.
    pub wraps: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityStoreError {
    NotFound(String),
    Malformed(String),
    UnsupportedVersion(i64),
    NoWrapForKey { identity_id: String, key_id: String },
}

impl IdentityStoreError {
    /// Stable code the TS client can branch on without matching message text.
    pub fn code(&self) -> &'static str {
        match self {
            IdentityStoreError::NotFound(_) => "IDENTITY_NOT_FOUND",
            IdentityStoreError::Malformed(_) => "IDENTITY_MALFORMED",
            IdentityStoreError::UnsupportedVersion(_) => "IDENTITY_VERSION_UNSUPPORTED",
            IdentityStoreError::NoWrapForKey { .. } => "IDENTITY_NO_WRAP_FOR_KEY",
        }
    }
}

impl std::fmt::Display for IdentityStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IdentityStoreError::NotFound(id) => {
                write!(f, "No local identity \"{id}\" found on this machine")
            }
            IdentityStoreError::Malformed(id) => {
                write!(f, "Invalid identity file format for identity: {id}")
            }
            IdentityStoreError::UnsupportedVersion(version) => {
                write!(f, "unsupported identity file version {version}; upgrade varlock")
            }
            IdentityStoreError::NoWrapForKey { identity_id, key_id } => write!(
                f,
                "Identity \"{identity_id}\" has no wrap for key \"{key_id}\" on this machine"
            ),
        }
    }
}

impl StoredIdentity {
    pub fn read(path: &Path, identity_id: &str) -> Result<Self, IdentityStoreError> {
        let Ok(data) = std::fs::read(path) else {
            return Err(IdentityStoreError::NotFound(identity_id.to_string()));
        };
        Self::parse(&data, identity_id)
    }

    pub fn parse(data: &[u8], identity_id: &str) -> Result<Self, IdentityStoreError> {
        let Ok(json) = serde_json::from_slice::<Value>(data) else {
            return Err(IdentityStoreError::Malformed(identity_id.to_string()));
        };
        let Some(version) = json.get("version").and_then(Value::as_i64) else {
            return Err(IdentityStoreError::Malformed(identity_id.to_string()));
        };
        if version != IDENTITY_FILE_VERSION {
            return Err(IdentityStoreError::UnsupportedVersion(version));
        }

        let public_key = json
            .get("publicKey")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty());
        let wraps_object = json.get("wraps").and_then(Value::as_object);
        let (Some(public_key), Some(wraps_object)) = (public_key, wraps_object) else {
            return Err(IdentityStoreError::Malformed(identity_id.to_string()));
        };

        let mut wraps = BTreeMap::new();
        for (key_id, wrap) in wraps_object {
            // A non-string wrap is a malformed file, not a wrap to skip: the
            // Swift side's `[String: String]` cast fails the whole read, and the
            // two must agree on which files are readable.
            let Some(wrap) = wrap.as_str() else {
                return Err(IdentityStoreError::Malformed(identity_id.to_string()));
            };
            wraps.insert(key_id.clone(), wrap.to_string());
        }

        Ok(Self {
            id: json
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(identity_id)
                .to_string(),
            public_key_base64: public_key.to_string(),
            wraps,
        })
    }

    pub fn wrap_for(&self, key_id: &str) -> Option<&str> {
        self.wraps.get(key_id).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    const VALID: &str = r#"{
      "version": 1,
      "id": "default",
      "publicKey": "BASE64PUBLICKEY",
      "wraps": { "varlock-default": "WRAPPED", "other-key": "WRAPPED2" },
      "createdAt": "2026-01-01T00:00:00.000Z"
    }"#;

    #[test]
    fn reads_the_typescript_file_format() {
        let identity = StoredIdentity::parse(VALID.as_bytes(), "default").expect("should parse");
        assert_eq!(identity.id, "default");
        assert_eq!(identity.public_key_base64, "BASE64PUBLICKEY");
        assert_eq!(identity.wrap_for("varlock-default"), Some("WRAPPED"));
        assert_eq!(identity.wrap_for("missing"), None);
    }

    #[test]
    fn wraps_iterate_in_key_id_order() {
        let identity = StoredIdentity::parse(VALID.as_bytes(), "default").unwrap();
        let ids: Vec<&str> = identity.wraps.keys().map(String::as_str).collect();
        assert_eq!(ids, vec!["other-key", "varlock-default"]);
    }

    #[test]
    fn a_missing_file_is_not_found() {
        let dir = TempDir::new();
        let paths = SessionPaths::with_user_dir(dir.path());
        let err = paths.read_identity("default").unwrap_err();
        assert_eq!(err.code(), "IDENTITY_NOT_FOUND");
    }

    #[test]
    fn a_future_version_asks_for_an_upgrade() {
        let err = StoredIdentity::parse(br#"{"version":2,"publicKey":"x","wraps":{}}"#, "default")
            .unwrap_err();
        assert_eq!(err.code(), "IDENTITY_VERSION_UNSUPPORTED");
        assert!(err.to_string().contains("upgrade varlock"));
    }

    #[test]
    fn missing_required_fields_are_malformed() {
        for body in [
            r#"{"version":1,"wraps":{}}"#,
            r#"{"version":1,"publicKey":"","wraps":{}}"#,
            r#"{"version":1,"publicKey":"x"}"#,
            r#"{"publicKey":"x","wraps":{}}"#,
            "not json at all",
        ] {
            let err = StoredIdentity::parse(body.as_bytes(), "default").unwrap_err();
            assert_eq!(err.code(), "IDENTITY_MALFORMED", "for {body}");
        }
    }

    #[test]
    fn a_non_string_wrap_is_malformed() {
        let err = StoredIdentity::parse(
            br#"{"version":1,"publicKey":"x","wraps":{"k":123}}"#,
            "default",
        )
        .unwrap_err();
        assert_eq!(err.code(), "IDENTITY_MALFORMED");
    }

    #[test]
    fn paths_sit_where_both_other_implementations_look() {
        let paths = SessionPaths::with_user_dir("/home/someone/.config/varlock");
        assert!(paths
            .identity_file("default")
            .ends_with("identities/default.json"));
        assert!(paths.machine_config_file().ends_with("config.json"));
        assert!(paths.audit_dir().ends_with("audit"));
    }

    #[test]
    fn a_missing_config_file_reads_as_nothing() {
        let dir = TempDir::new();
        let paths = SessionPaths::with_user_dir(dir.path());
        assert_eq!(paths.read_machine_config(), None);

        std::fs::write(paths.machine_config_file(), br#"{"sessions":{"lockOn":"none"}}"#).unwrap();
        assert!(paths.read_machine_config().is_some());
    }

    #[test]
    fn an_identity_read_off_disk_round_trips() {
        let dir = TempDir::new();
        let paths = SessionPaths::with_user_dir(dir.path());
        std::fs::create_dir_all(paths.identity_file("default").parent().unwrap()).unwrap();
        std::fs::write(paths.identity_file("default"), VALID).unwrap();

        let identity = paths.read_identity("default").expect("should read");
        assert_eq!(identity.wraps.len(), 2);
    }
}
