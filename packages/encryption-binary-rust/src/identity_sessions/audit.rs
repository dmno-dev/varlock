//! The append-only record of what the daemon authorized.
//!
//! One line of JSON per authorization, in a file only the user can read. The
//! point is answerability: if a session key was used, there is a durable line
//! saying when, for which key, under which grant, and which process asked. A
//! decrypt whose line cannot be written is refused, so the log has no holes
//! where the interesting cases would be.
//!
//! What a record must never contain is anything worth stealing. Every field here
//! is an identifier, a count, or a description of a process; no plaintext, no
//! ciphertext, and no key material passes through this type at all.
//!
//! The format is the one `AuthorizationAudit.swift` writes, field for field, so
//! the logs from a Mac and from a Windows or Linux box read the same.

use serde_json::{json, Map, Value};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::timefmt;

pub const AUDIT_FILE_NAME: &str = "authorizations.jsonl";

/// What the daemon authorized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorizationKind {
    /// Plaintext was about to be handed back for a batch of payloads.
    Decrypt,
    /// A session took (or extended) its hold on one or more keys.
    Unlock,
    /// Someone dropped grants on purpose.
    Invalidate,
}

impl AuthorizationKind {
    pub fn wire_value(&self) -> &'static str {
        match self {
            AuthorizationKind::Decrypt => "decrypt-v2",
            AuthorizationKind::Unlock => "unlock-session",
            AuthorizationKind::Invalidate => "invalidate-session",
        }
    }
}

/// One line of the log.
#[derive(Debug, Clone)]
pub struct AuthorizationRecord {
    pub kind: AuthorizationKind,
    /// Session identity as resolved from the peer, never as claimed by it.
    pub session_id: String,
    pub key_ids: Vec<String>,
    pub identity_id: Option<String>,
    /// How many payloads this call covered. Zero for anything but a decrypt.
    pub payload_count: usize,
    /// The grant scope the call ran under, when there was one.
    pub scope: Option<String>,
    /// One line describing the process that asked, derived by the daemon.
    pub requester: Option<String>,
}

impl AuthorizationRecord {
    pub fn new(kind: AuthorizationKind, session_id: impl Into<String>, key_ids: Vec<String>) -> Self {
        Self {
            kind,
            session_id: session_id.into(),
            key_ids,
            identity_id: None,
            payload_count: 0,
            scope: None,
            requester: None,
        }
    }

    pub fn identity_id(mut self, identity_id: impl Into<String>) -> Self {
        self.identity_id = Some(identity_id.into());
        self
    }

    pub fn payload_count(mut self, count: usize) -> Self {
        self.payload_count = count;
        self
    }

    pub fn scope(mut self, scope: impl Into<String>) -> Self {
        self.scope = Some(scope.into());
        self
    }

    pub fn requester(mut self, requester: Option<String>) -> Self {
        self.requester = requester;
        self
    }

    fn to_json(&self, timestamp: &str) -> Value {
        let mut object = Map::new();
        object.insert("ts".into(), json!(timestamp));
        object.insert("event".into(), json!(self.kind.wire_value()));
        object.insert("sessionId".into(), json!(self.session_id));
        object.insert("keyIds".into(), json!(self.key_ids));
        object.insert("payloadCount".into(), json!(self.payload_count));
        if let Some(identity_id) = &self.identity_id {
            object.insert("identityId".into(), json!(identity_id));
        }
        if let Some(scope) = &self.scope {
            object.insert("scope".into(), json!(scope));
        }
        if let Some(requester) = &self.requester {
            object.insert("requester".into(), json!(requester));
        }
        Value::Object(object)
    }
}

/// The record did not make it to disk, whatever the reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditWriteError(pub String);

impl AuditWriteError {
    /// Stable code the TS client can branch on without matching message text.
    pub fn code(&self) -> &'static str {
        "AUDIT_WRITE_FAILED"
    }
}

impl std::fmt::Display for AuditWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Refusing to release secrets: the authorization could not be recorded ({})",
            self.0
        )
    }
}

/// Appends authorization records, synchronously, and proves each one landed.
///
/// Deliberately small and blocking. It runs on the path that is about to hand
/// back plaintext, so it has no queue to fall behind on, no buffer to lose on a
/// crash, and no way to report success for a line that is not on disk: every
/// append is flushed with `sync_all` and then read back off the file before the
/// caller is told it worked.
pub struct AuthorizationAuditLog {
    directory: PathBuf,
    /// Serialized so a read-back can trust the offset its own write returned.
    write_lock: Mutex<()>,
    /// Injected so tests can pin the timestamp.
    timestamp: Box<dyn Fn() -> String + Send + Sync>,
}

impl AuthorizationAuditLog {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self::with_timestamp(directory, timefmt::now_iso8601_millis)
    }

    pub fn with_timestamp(
        directory: impl Into<PathBuf>,
        timestamp: impl Fn() -> String + Send + Sync + 'static,
    ) -> Self {
        Self {
            directory: directory.into(),
            write_lock: Mutex::new(()),
            timestamp: Box::new(timestamp),
        }
    }

    #[cfg(test)]
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn file_path(&self) -> PathBuf {
        self.directory.join(AUDIT_FILE_NAME)
    }

    /// Write one record, or fail. There is no third outcome.
    pub fn append(&self, record: &AuthorizationRecord) -> Result<(), AuditWriteError> {
        let line = self.encode(record)?;

        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| AuditWriteError("the audit log lock was poisoned".into()))?;

        self.ensure_directory()?;
        let path = self.file_path();

        let mut file = open_append(&path)?;
        file.write_all(&line)
            .map_err(|e| AuditWriteError(format!("short write: {e}")))?;
        file.sync_all()
            .map_err(|e| AuditWriteError(format!("fsync failed: {e}")))?;

        let end = file
            .stream_position()
            .map_err(|e| AuditWriteError(format!("could not locate the record just written: {e}")))?;
        if end < line.len() as u64 {
            return Err(AuditWriteError("could not locate the record just written".into()));
        }
        self.verify_read_back(&path, &line, end - line.len() as u64)
    }

    // ── Private ───────────────────────────────────────────────────

    fn encode(&self, record: &AuthorizationRecord) -> Result<Vec<u8>, AuditWriteError> {
        let object = record.to_json(&(self.timestamp)());
        // serde_json orders object keys, which is what the Swift side asks for
        // explicitly with `.sortedKeys`. The two daemons therefore write the
        // same bytes for the same record.
        let mut bytes = serde_json::to_vec(&object)
            .map_err(|e| AuditWriteError(format!("record could not be serialized: {e}")))?;
        // One record per line is the whole format, so a record that somehow
        // carried a raw newline would corrupt the next one. JSON escaping already
        // rules this out; the check is here so a future field cannot break it
        // quietly.
        if bytes.contains(&b'\n') {
            return Err(AuditWriteError("record contains a line break".into()));
        }
        bytes.push(b'\n');
        Ok(bytes)
    }

    fn ensure_directory(&self) -> Result<(), AuditWriteError> {
        if self.directory.exists() {
            if !self.directory.is_dir() {
                return Err(AuditWriteError(format!(
                    "{} is not a directory",
                    self.directory.display()
                )));
            }
            return Ok(());
        }
        std::fs::create_dir_all(&self.directory).map_err(|e| {
            AuditWriteError(format!("cannot create {}: {e}", self.directory.display()))
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                &self.directory,
                std::fs::Permissions::from_mode(0o700),
            );
        }
        Ok(())
    }

    /// Read the bytes back off the file. A write that returned success but left
    /// nothing behind (a full disk that only reports at flush time, a file
    /// swapped underneath us) has to be caught here or not at all.
    fn verify_read_back(
        &self,
        path: &Path,
        expected: &[u8],
        offset: u64,
    ) -> Result<(), AuditWriteError> {
        let mut file = File::open(path)
            .map_err(|e| AuditWriteError(format!("cannot re-open {}: {e}", path.display())))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| AuditWriteError(format!("cannot seek {}: {e}", path.display())))?;
        let mut read_back = vec![0u8; expected.len()];
        file.read_exact(&mut read_back)
            .map_err(|_| AuditWriteError("the record did not read back from disk".into()))?;
        if read_back != expected {
            return Err(AuditWriteError("the record did not read back from disk".into()));
        }
        Ok(())
    }
}

fn open_append(path: &Path) -> Result<File, AuditWriteError> {
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|e| AuditWriteError(format!("cannot open {}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn log_in(dir: &TempDir) -> AuthorizationAuditLog {
        AuthorizationAuditLog::with_timestamp(dir.path().join("audit"), || {
            "2026-08-30T12:34:56.789Z".to_string()
        })
    }

    fn lines(log: &AuthorizationAuditLog) -> Vec<Value> {
        let contents = std::fs::read_to_string(log.file_path()).expect("log should exist");
        contents
            .lines()
            .map(|line| serde_json::from_str(line).expect("each line is JSON"))
            .collect()
    }

    #[test]
    fn a_decrypt_record_carries_the_agreed_fields() {
        let dir = TempDir::new();
        let log = log_in(&dir);

        log.append(
            &AuthorizationRecord::new(
                AuthorizationKind::Decrypt,
                "tty:1:2",
                vec!["varlock-default".into()],
            )
            .identity_id("default")
            .payload_count(7)
            .scope("session")
            .requester(Some("node (pid 42)".into())),
        )
        .expect("append should succeed");

        let records = lines(&log);
        assert_eq!(records.len(), 1);
        let record = records[0].as_object().unwrap();
        assert_eq!(record["ts"], json!("2026-08-30T12:34:56.789Z"));
        assert_eq!(record["event"], json!("decrypt-v2"));
        assert_eq!(record["sessionId"], json!("tty:1:2"));
        assert_eq!(record["keyIds"], json!(["varlock-default"]));
        assert_eq!(record["payloadCount"], json!(7));
        assert_eq!(record["identityId"], json!("default"));
        assert_eq!(record["scope"], json!("session"));
        assert_eq!(record["requester"], json!("node (pid 42)"));
    }

    #[test]
    fn optional_fields_are_omitted_rather_than_null() {
        let dir = TempDir::new();
        let log = log_in(&dir);
        log.append(&AuthorizationRecord::new(
            AuthorizationKind::Invalidate,
            "*",
            vec!["*".into()],
        ))
        .expect("append should succeed");

        let record = lines(&log)[0].as_object().unwrap().clone();
        let mut keys: Vec<&str> = record.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["event", "keyIds", "payloadCount", "sessionId", "ts"]);
    }

    #[test]
    fn keys_are_written_in_sorted_order() {
        let dir = TempDir::new();
        let log = log_in(&dir);
        log.append(
            &AuthorizationRecord::new(AuthorizationKind::Unlock, "s", vec!["k".into()])
                .identity_id("default")
                .scope("once")
                .requester(Some("bun".into())),
        )
        .expect("append should succeed");

        let raw = std::fs::read_to_string(log.file_path()).unwrap();
        let order: Vec<&str> = ["event", "identityId", "keyIds", "payloadCount", "requester", "scope", "sessionId", "ts"]
            .into_iter()
            .collect();
        let mut last = 0usize;
        for key in order {
            let at = raw.find(&format!("\"{key}\"")).expect("field should be present");
            assert!(at >= last, "{key} is out of order");
            last = at;
        }
    }

    #[test]
    fn appends_accumulate_one_line_each() {
        let dir = TempDir::new();
        let log = log_in(&dir);
        for index in 0..5 {
            log.append(
                &AuthorizationRecord::new(
                    AuthorizationKind::Decrypt,
                    "s",
                    vec![format!("key-{index}")],
                )
                .payload_count(index),
            )
            .expect("append should succeed");
        }
        assert_eq!(lines(&log).len(), 5);
    }

    #[test]
    fn the_directory_is_created_on_first_write() {
        let dir = TempDir::new();
        let log = log_in(&dir);
        assert!(!log.directory().exists());
        log.append(&AuthorizationRecord::new(
            AuthorizationKind::Unlock,
            "s",
            vec!["k".into()],
        ))
        .expect("append should succeed");
        assert!(log.directory().is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn the_log_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new();
        let log = log_in(&dir);
        log.append(&AuthorizationRecord::new(
            AuthorizationKind::Unlock,
            "s",
            vec!["k".into()],
        ))
        .expect("append should succeed");

        let mode = std::fs::metadata(log.file_path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "got {:o}", mode & 0o777);
        let dir_mode = std::fs::metadata(log.directory()).unwrap().permissions().mode();
        assert_eq!(dir_mode & 0o777, 0o700, "got {:o}", dir_mode & 0o777);
    }

    #[test]
    fn a_directory_path_blocked_by_a_file_fails_loudly() {
        let dir = TempDir::new();
        let blocked = dir.path().join("audit");
        std::fs::write(&blocked, b"not a directory").unwrap();

        let log = AuthorizationAuditLog::new(blocked);
        let err = log
            .append(&AuthorizationRecord::new(
                AuthorizationKind::Decrypt,
                "s",
                vec!["k".into()],
            ))
            .expect_err("a file where the directory should be must fail");
        assert_eq!(err.code(), "AUDIT_WRITE_FAILED");
        assert!(err.to_string().contains("Refusing to release secrets"));
    }

    #[test]
    fn records_never_carry_secret_material() {
        // A structural guard rather than a behavioural one: the record type has
        // no field a plaintext or a ciphertext could be put into by accident.
        let record = AuthorizationRecord::new(
            AuthorizationKind::Decrypt,
            "s",
            vec!["k".into()],
        )
        .payload_count(3);
        let json = record.to_json("2026-08-30T12:34:56.789Z");
        let serialized = serde_json::to_string(&json).unwrap();
        assert!(!serialized.contains("plaintext"));
        assert!(!serialized.contains("ciphertext"));
    }
}
