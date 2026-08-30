//! Holds identity keys on behalf of unlocked sessions.
//!
//! The shape mirrors `IdentitySessionManager.swift`: at unlock the identity
//! private key is unwrapped once through the device (custody) key, and then held
//! until the session's grant ends. Each later decrypt uses the held key for a
//! batch and charges the grant. Ending a session erases the key.
//!
//! Where this differs from the Swift daemon, on purpose:
//!
//!   - macOS re-wraps the identity key under a per-session Secure Enclave key
//!     and holds only that blob, so the enclave is what makes a held key
//!     unreadable after the session ends. Neither Windows' NCrypt nor Linux's
//!     TPM2 gives a cheap equivalent (a per-session TPM key would put a TPM
//!     round trip on every decrypt and needs its own eviction story), so the
//!     hold here is guarded memory instead: a fixed, locked, dump-excluded
//!     buffer that is zeroized when the session ends. See
//!     [`crate::secure_mem::GuardedBuffer`]. A TPM-resident session key is the
//!     later step, not this one.
//!   - there is no approval panel, so an unlock can never answer
//!     `APPROVAL_DENIED` or `NO_UI`. Windows Hello (or polkit/PAM on Linux) is
//!     the only thing the user sees, and only for keys whose custody asks for
//!     it. Approval surfaces for these platforms arrive later.
//!
//! Nothing here is persisted. A daemon restart loses every session on purpose:
//! a held key that survived a restart would be a key nobody was present for.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::crypto;
use crate::secure_mem::GuardedBuffer;

use super::audit::{
    AuditWriteError, AuthorizationAuditLog, AuthorizationKind, AuthorizationRecord,
};
use super::grants::{
    SessionGrantError, SessionGrantInfo, SessionGrantRef, SessionGrantScope, SessionGrantTable,
    MAX_GRANT_MS,
};
use super::identity_store::{IdentityStoreError, SessionPaths};
use super::lock_policy::{
    resolve_lock_policy, warn_on_stderr, LockPolicySource, SessionLockEvent, SessionLockPolicy,
};

/// How the daemon satisfied user presence for an unlock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockPolicy {
    /// Windows Hello, or polkit/PAM on Linux.
    Biometrics,
    /// The custody key carries no presence requirement, so there was nothing to
    /// prompt for.
    NoPresenceRequired,
}

impl UnlockPolicy {
    pub fn wire_value(&self) -> &'static str {
        match self {
            UnlockPolicy::Biometrics => "biometrics",
            UnlockPolicy::NoPresenceRequired => "no-presence-required",
        }
    }
}

/// Everything that goes wrong on the identity session path.
#[derive(Debug)]
pub enum SessionError {
    NoSessionIdentity,
    PresenceFailed(String),
    SessionKeyMissing,
    NotUtf8,
    Grant(SessionGrantError),
    Identity(IdentityStoreError),
    Audit(AuditWriteError),
    /// A crypto or key-import failure, which carries no stable code: there is
    /// nothing a client can usefully do about it but show the message.
    Crypto(String),
}

impl SessionError {
    /// Stable code the TS client can branch on without matching message text.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            SessionError::NoSessionIdentity => Some("NO_SESSION_IDENTITY"),
            SessionError::PresenceFailed(_) => Some("BIOMETRIC_FAILED"),
            SessionError::SessionKeyMissing => Some("SESSION_KEY_MISSING"),
            SessionError::NotUtf8 => Some("NOT_UTF8"),
            SessionError::Grant(err) => Some(err.code()),
            SessionError::Identity(err) => Some(err.code()),
            SessionError::Audit(err) => Some(err.code()),
            SessionError::Crypto(_) => None,
        }
    }
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::NoSessionIdentity => write!(
                f,
                "Cannot scope an unlock session for this process; no session identity could be determined"
            ),
            SessionError::PresenceFailed(message) => {
                write!(f, "User verification failed: {message}")
            }
            SessionError::SessionKeyMissing => write!(
                f,
                "The unlock session is no longer held by the daemon; unlock again"
            ),
            SessionError::NotUtf8 => write!(f, "Decrypted data is not valid UTF-8"),
            SessionError::Grant(err) => write!(f, "{err}"),
            SessionError::Identity(err) => write!(f, "{err}"),
            SessionError::Audit(err) => write!(f, "{err}"),
            SessionError::Crypto(message) => write!(f, "{message}"),
        }
    }
}

impl From<SessionGrantError> for SessionError {
    fn from(err: SessionGrantError) -> Self {
        SessionError::Grant(err)
    }
}

impl From<IdentityStoreError> for SessionError {
    fn from(err: IdentityStoreError) -> Self {
        SessionError::Identity(err)
    }
}

impl From<AuditWriteError> for SessionError {
    fn from(err: AuditWriteError) -> Self {
        SessionError::Audit(err)
    }
}

/// The device key half: unwrapping an identity key, and whatever gate that key
/// carries.
///
/// A trait so the platform backends (NCrypt/DPAPI, TPM2/Secret Service) stay out
/// of the lifetime rules, and so every rule in this file can be tested on any OS
/// with no TPM, no keyring, and nobody's fingerprint.
pub trait CustodyBackend: Send + Sync {
    /// Unwrap the identity private key from its wrap blob, returning the raw
    /// 32-byte P-256 scalar in guarded memory.
    ///
    /// Called only after [`CustodyBackend::verify_presence`] has passed for keys
    /// that ask for it.
    fn unwrap_identity_scalar(
        &self,
        key_id: &str,
        wrap: &[u8],
    ) -> Result<GuardedBuffer, SessionError>;

    /// Whether using this key should cost a user-presence check.
    ///
    /// False for a key created with `--no-auth` (CI), and false on a machine
    /// with no presence mechanism at all: there is nothing to ask, and failing
    /// the unlock instead would just make the feature unavailable.
    fn requires_presence(&self, key_id: &str) -> bool;

    /// Run the platform's presence check. `Ok(false)` means the user declined.
    fn verify_presence(&self, reason: &str) -> Result<bool, String>;
}

/// One unlock request, as the daemon resolved it.
pub struct UnlockRequest<'a> {
    /// Resolved from the peer, never taken from the message.
    pub session_id: Option<&'a str>,
    pub key_ids: Vec<String>,
    pub identity_id: String,
    pub scope: SessionGrantScope,
    pub duration_ms: Option<i64>,
    pub lock_on_override: Option<&'a str>,
    /// One line describing the connecting process, for the log.
    pub requester: Option<String>,
}

#[derive(Debug)]
pub struct UnlockOutcome {
    pub grants: Vec<SessionGrantInfo>,
    pub policy: UnlockPolicy,
    pub lock_on: SessionLockPolicy,
    pub lock_on_source: LockPolicySource,
    /// Whether the user was actually asked. False when every key was already
    /// covered by a live grant, or when no key in the batch is presence gated.
    pub prompted: bool,
}

/// What the daemon holds for one unlocked session.
///
/// Keyed by identity id and device key id, the same split the grants use, so a
/// session that opened two keys can lose one without losing the other.
#[derive(Default)]
struct SessionMaterial {
    /// "<identityId>\0<keyId>" -> the identity private scalar, in guarded memory
    scalars: HashMap<String, GuardedBuffer>,
}

struct Inner {
    grants: SessionGrantTable,
    material: HashMap<String, SessionMaterial>,
}

pub struct IdentitySessionManager {
    inner: Mutex<Inner>,
    paths: SessionPaths,
    audit: AuthorizationAuditLog,
    custody: Box<dyn CustodyBackend>,
}

impl IdentitySessionManager {
    pub fn new(paths: SessionPaths, custody: Box<dyn CustodyBackend>) -> Self {
        let audit = AuthorizationAuditLog::new(paths.audit_dir());
        Self::with_audit(paths, custody, audit)
    }

    pub fn with_audit(
        paths: SessionPaths,
        custody: Box<dyn CustodyBackend>,
        audit: AuthorizationAuditLog,
    ) -> Self {
        Self {
            inner: Mutex::new(Inner {
                grants: SessionGrantTable::new(),
                material: HashMap::new(),
            }),
            paths,
            audit,
            custody,
        }
    }

    /// Swap in a grant table over a test clock. Only used by the tests, which
    /// need to move time without sleeping for twelve hours.
    #[cfg(test)]
    pub fn set_grant_table(&self, table: SessionGrantTable) {
        let mut inner = self.lock();
        inner.grants = table;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A poisoned lock means a panic happened while holding session state.
        // Recovering the guard is the right call: the alternative is a daemon
        // that answers nothing and never releases the keys it is holding.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // ── Unlock ────────────────────────────────────────────────────

    /// Open (or extend) a session: one presence check, however many keys.
    pub fn unlock(&self, request: UnlockRequest<'_>) -> Result<UnlockOutcome, SessionError> {
        let session_id = non_empty(request.session_id).ok_or(SessionError::NoSessionIdentity)?;
        let identity = self.paths.read_identity(&request.identity_id)?;

        // What this unlock asked for, else the machine config, else the default.
        // Read fresh so editing the config file needs no daemon restart.
        let lock_policy = resolve_lock_policy(
            request.lock_on_override,
            self.paths.read_machine_config().as_deref(),
            &mut warn_on_stderr,
        );

        // Fail before prompting if none of the requested keys can open this identity.
        let usable: Vec<String> = request
            .key_ids
            .iter()
            .filter(|key_id| identity.wrap_for(key_id).is_some())
            .cloned()
            .collect();
        if usable.is_empty() {
            return Err(IdentityStoreError::NoWrapForKey {
                identity_id: request.identity_id.clone(),
                key_id: request.key_ids.first().cloned().unwrap_or_else(|| "unknown".into()),
            }
            .into());
        }

        // Which keys this request still needs opened, and which are already
        // covered by a grant at least as strong as the one being asked for.
        let (to_open, carried) = {
            let mut inner = self.lock();
            split_by_coverage(
                &mut inner.grants,
                session_id,
                &usable,
                request.scope,
                request.duration_ms,
            )
        };

        if to_open.is_empty() {
            // Everything asked for is already covered by a live grant. Asking
            // again would be a check that changes nothing, so we hand back what
            // the session already holds.
            let lock_on = carried.first().map(|grant| grant.lock_on).unwrap_or(lock_policy.policy);
            return Ok(UnlockOutcome {
                grants: carried,
                policy: UnlockPolicy::NoPresenceRequired,
                lock_on,
                lock_on_source: lock_policy.source,
                prompted: false,
            });
        }

        // One presence check for the whole batch, before any unwrapping, so a
        // caller cannot turn one approval into a stream of silent unwraps.
        let needs_presence = to_open.iter().any(|key_id| self.custody.requires_presence(key_id));
        if needs_presence {
            let reason = unlock_reason(&request.identity_id, &to_open, request.requester.as_deref());
            match self.custody.verify_presence(&reason) {
                Ok(true) => {}
                Ok(false) => {
                    return Err(SessionError::PresenceFailed(
                        "the request was cancelled".into(),
                    ))
                }
                Err(message) => return Err(SessionError::PresenceFailed(message)),
            }
        }

        let mut granted = carried;
        let mut opened: Vec<String> = Vec::new();

        for key_id in &to_open {
            let Some(wrap_base64) = identity.wrap_for(key_id) else { continue };
            let wrap = decode_base64(wrap_base64)
                .ok_or_else(|| IdentityStoreError::Malformed(identity.id.clone()))?;

            let scalar = self.custody.unwrap_identity_scalar(key_id, &wrap)?;

            // The unwrapped key has to be the identity this file describes. A
            // wrap that opens but yields a different key means the file has been
            // spliced together from two identities, and every value decrypted
            // under it afterwards would silently fail or, worse, be attributed to
            // the wrong identity in the log.
            verify_identity_key(&identity, &scalar)?;

            let mut inner = self.lock();
            inner
                .material
                .entry(session_id.to_string())
                .or_default()
                .scalars
                .insert(material_key(&request.identity_id, key_id), scalar);

            granted.push(inner.grants.grant(
                &SessionGrantRef::new(session_id, key_id.clone()),
                &request.identity_id,
                request.scope,
                request.duration_ms,
                lock_policy.policy,
            ));
            opened.push(key_id.clone());
        }

        // A session the daemon holds with no record of who opened it is the hole
        // this log exists to close, so an unlock that cannot be recorded gives
        // its keys straight back.
        let mut sorted_keys = opened.clone();
        sorted_keys.sort();
        let record = AuthorizationRecord::new(AuthorizationKind::Unlock, session_id, sorted_keys)
            .identity_id(request.identity_id.clone())
            .scope(request.scope.wire_value())
            .requester(request.requester.clone());
        if let Err(err) = self.audit.append(&record) {
            let mut inner = self.lock();
            for key_id in &opened {
                inner.grants.invalidate(Some(session_id), Some(key_id));
            }
            reconcile_locked(&mut inner);
            return Err(err.into());
        }

        {
            let mut inner = self.lock();
            reconcile_locked(&mut inner);
        }

        Ok(UnlockOutcome {
            grants: granted,
            policy: if needs_presence {
                UnlockPolicy::Biometrics
            } else {
                UnlockPolicy::NoPresenceRequired
            },
            lock_on: lock_policy.policy,
            lock_on_source: lock_policy.source,
            prompted: needs_presence,
        })
    }

    // ── Decrypt ───────────────────────────────────────────────────

    /// Decrypt a batch of v2 payloads under a live grant. No prompt, no key on
    /// the wire.
    ///
    /// The batch is one grant use: a `once` grant covers this call and is then
    /// spent, however many payloads it carried.
    ///
    /// Nothing is decrypted until the authorization is on disk. If the record
    /// cannot be written the call is refused, which does spend a `once` grant on
    /// a batch that returned nothing. That is the safe direction to fail in: the
    /// alternative is handing back secrets with no record that it happened.
    pub fn decrypt_v2(
        &self,
        session_id: Option<&str>,
        key_id: &str,
        identity_id: &str,
        payloads: &[Vec<u8>],
        requester: Option<String>,
    ) -> Result<(Vec<String>, SessionGrantInfo), SessionError> {
        let session_id = non_empty(session_id).ok_or(SessionError::NoSessionIdentity)?;
        let grant_ref = SessionGrantRef::new(session_id, key_id);

        let mut inner = self.lock();

        let (served, change) = match inner.grants.consume(&grant_ref) {
            Ok(result) => result,
            Err(err) => {
                reconcile_locked(&mut inner);
                return Err(err.into());
            }
        };

        let record = AuthorizationRecord::new(
            AuthorizationKind::Decrypt,
            session_id,
            vec![key_id.to_string()],
        )
        .identity_id(identity_id)
        .payload_count(payloads.len())
        .scope(served.scope.wire_value())
        .requester(requester);
        self.audit.append(&record)?;

        // Import the held scalar and let the borrow end here, so an erase can
        // take the lock mutably below.
        let held_key = material_key(identity_id, key_id);
        let identity_key = match inner
            .material
            .get(session_id)
            .and_then(|held| held.scalars.get(&held_key))
        {
            Some(scalar) => {
                crypto::secret_key_from_scalar(scalar.as_slice()).map_err(SessionError::Crypto)
            }
            None => Err(SessionError::SessionKeyMissing),
        };
        let identity_key = match identity_key {
            Ok(key) => key,
            Err(err) => {
                reconcile_locked(&mut inner);
                return Err(err);
            }
        };

        let mut plaintexts = Vec::with_capacity(payloads.len());
        for payload in payloads {
            let decrypted =
                crypto::decrypt_payload(&identity_key, payload, &[crypto::IDENTITY_PAYLOAD_VERSION])
                    .map_err(SessionError::Crypto)?;
            let text = String::from_utf8(decrypted).map_err(|_| SessionError::NotUtf8)?;
            plaintexts.push(text);
        }

        if !change.closed_sessions.is_empty() {
            reconcile_locked(&mut inner);
        }
        Ok((plaintexts, served))
    }

    // ── Listing and invalidation ──────────────────────────────────

    pub fn list_grants(&self) -> Vec<SessionGrantInfo> {
        let mut inner = self.lock();
        reconcile_locked(&mut inner);
        inner.grants.list()
    }

    /// Drop grants and erase any session left holding nothing.
    ///
    /// Passing neither target drops everything, which is what the argument-less
    /// `invalidate-session` has always done.
    pub fn invalidate(
        &self,
        session_id: Option<&str>,
        key_id: Option<&str>,
        requester: Option<String>,
    ) -> usize {
        let mut inner = self.lock();
        let change = inner.grants.invalidate(session_id, key_id);
        reconcile_locked(&mut inner);
        drop(inner);

        // Recorded best effort, unlike the two paths above. Refusing to erase
        // key material because a log line would not write is the wrong way
        // round: the erase is the safe outcome, and blocking it to protect the
        // record would leave the daemon holding keys it was told to drop.
        if change.dropped > 0 {
            let record = AuthorizationRecord::new(
                AuthorizationKind::Invalidate,
                session_id.unwrap_or("*"),
                vec![key_id.unwrap_or("*").to_string()],
            )
            .requester(requester);
            if let Err(err) = self.audit.append(&record) {
                eprintln!("varlock: could not record an invalidation: {err}");
            }
        }
        change.dropped
    }

    /// Handle a system lock event, erasing only the sessions whose own policy
    /// says this event ends them.
    ///
    /// Separate from [`IdentitySessionManager::invalidate`], which is the
    /// explicit lock and always erases everything.
    pub fn handle_lock_event(&self, event: SessionLockEvent) -> usize {
        let mut inner = self.lock();
        let change = inner.grants.invalidate_on_lock_event(event);
        reconcile_locked(&mut inner);
        change.dropped
    }

    /// The lock policy a live session resolved to.
    ///
    /// Not on the wire: `list-sessions` already reports each grant's `lockOn`.
    /// This is how the tests check the resolution without going through JSON.
    #[cfg(test)]
    pub fn lock_policy(&self, session_id: &str) -> Option<SessionLockPolicy> {
        let mut inner = self.lock();
        inner.grants.lock_policy(session_id)
    }

    /// Whether the daemon is holding anything. Gates the idle auto-quit: session
    /// state is memory-only, so quitting would silently cost someone an unlock.
    pub fn has_live_sessions(&self) -> bool {
        let mut inner = self.lock();
        reconcile_locked(&mut inner);
        inner.grants.has_live_sessions()
    }

    /// Sweep expired grants and erase what they were holding.
    ///
    /// Called on a timer so a hard-cap expiry erases key material even on a
    /// daemon nobody is talking to.
    pub fn reconcile(&self) {
        let mut inner = self.lock();
        reconcile_locked(&mut inner);
    }

    /// How many sessions the daemon is holding key material for. Used by the
    /// tests to prove an erase actually erased.
    #[cfg(test)]
    pub fn held_session_count(&self) -> usize {
        self.lock().material.len()
    }
}

/// Check that an unwrapped scalar really is the identity's private key.
fn verify_identity_key(
    identity: &super::identity_store::StoredIdentity,
    scalar: &GuardedBuffer,
) -> Result<(), SessionError> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

    let key = crypto::secret_key_from_scalar(scalar.as_slice()).map_err(SessionError::Crypto)?;
    let expected = BASE64
        .decode(&identity.public_key_base64)
        .map_err(|_| IdentityStoreError::Malformed(identity.id.clone()))?;

    if crypto::public_key_bytes(&key) != expected {
        return Err(SessionError::Crypto(format!(
            "The key unwrapped for identity \"{}\" is not the one its file describes",
            identity.id
        )));
    }
    Ok(())
}

/// Erase material for every session the grant table no longer considers live.
fn reconcile_locked(inner: &mut Inner) {
    inner.grants.prune_expired();
    let live: std::collections::HashSet<String> =
        inner.grants.live_session_ids().into_iter().collect();
    // Removing the entry drops its GuardedBuffers, which zeroizes them.
    inner.material.retain(|session_id, _| live.contains(session_id));
}

/// Split the requested keys into the ones that still need opening and the live
/// grants that already cover the request.
fn split_by_coverage(
    grants: &mut SessionGrantTable,
    session_id: &str,
    key_ids: &[String],
    requested_scope: SessionGrantScope,
    requested_duration_ms: Option<i64>,
) -> (Vec<String>, Vec<SessionGrantInfo>) {
    let mut to_open = Vec::new();
    let mut carried = Vec::new();

    for key_id in key_ids {
        let live = grants.live_grant(&SessionGrantRef::new(session_id, key_id.clone()));
        match live {
            Some(grant)
                if covers(&grant, requested_scope, requested_duration_ms) =>
            {
                carried.push(grant)
            }
            _ => to_open.push(key_id.clone()),
        }
    }

    (to_open, carried)
}

/// Whether a live grant is already at least as strong as what was asked for.
///
/// The rules are deliberately blunt, so the answer never depends on clock drift
/// or on comparing two windows measured from different starting points:
///
///   - a `session` grant covers anything, since it is the longest thing on offer
///   - a `duration` grant covers a `once` request, and covers another `duration`
///     request only if the window already granted reaches past the new one
///   - a `once` grant covers only another `once` request
///
/// Anything else counts as an upgrade and is worth asking about again.
fn covers(
    live: &SessionGrantInfo,
    requested_scope: SessionGrantScope,
    requested_duration_ms: Option<i64>,
) -> bool {
    if live.remaining_ms <= 0 {
        return false;
    }
    match live.scope {
        SessionGrantScope::Session => true,
        SessionGrantScope::Duration => match requested_scope {
            SessionGrantScope::Once => true,
            SessionGrantScope::Duration => {
                let window = requested_duration_ms.unwrap_or(MAX_GRANT_MS).min(MAX_GRANT_MS);
                live.remaining_ms >= window
            }
            SessionGrantScope::Session => false,
        },
        SessionGrantScope::Once => requested_scope == SessionGrantScope::Once,
    }
}

/// Plain, informative copy for the platform's presence prompt.
fn unlock_reason(identity_id: &str, key_ids: &[String], requester: Option<&str>) -> String {
    let mut sorted = key_ids.to_vec();
    sorted.sort();
    let key_list = sorted.join(", ");

    let mut reason = if identity_id == super::identity_store::DEFAULT_IDENTITY_ID {
        format!("unlock varlock encryption key {key_list}")
    } else {
        format!("unlock varlock identity \"{identity_id}\" with key {key_list}")
    };
    if let Some(requester) = requester.filter(|line| !line.is_empty()) {
        let trimmed: String = requester.chars().take(80).collect();
        reason.push_str(&format!(", {trimmed}"));
    }
    reason
}

fn material_key(identity_id: &str, key_id: &str) -> String {
    format!("{identity_id}\u{0}{key_id}")
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    BASE64.decode(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_sessions::clock::ClockReading;
    use crate::test_support::TempDir;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
    use std::sync::Arc;
    use zeroize::Zeroize;

    /// A device key that lives entirely in the test: it wraps and unwraps with
    /// the same software ECIES the real backends use, and can be told to demand
    /// presence or to refuse it.
    struct FakeCustody {
        device_key: crypto::KeyPair,
        requires_presence: bool,
        presence_answer: Result<bool, String>,
        presence_calls: Arc<AtomicUsize>,
        unwrap_calls: Arc<AtomicUsize>,
    }

    impl FakeCustody {
        fn new() -> Self {
            Self {
                device_key: crypto::generate_key_pair().unwrap(),
                requires_presence: true,
                presence_answer: Ok(true),
                presence_calls: Arc::new(AtomicUsize::new(0)),
                unwrap_calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        /// A wrap blob of the given identity scalar, as the TS side would write.
        fn wrap(&self, identity_pkcs8_der: &[u8]) -> String {
            let device_pub = BASE64.decode(&self.device_key.public_key).unwrap();
            let payload = crypto::encrypt_to_public_key(
                &device_pub,
                identity_pkcs8_der,
                crypto::DEVICE_PAYLOAD_VERSION,
            )
            .unwrap();
            BASE64.encode(&payload)
        }
    }

    impl CustodyBackend for FakeCustody {
        fn unwrap_identity_scalar(
            &self,
            _key_id: &str,
            wrap: &[u8],
        ) -> Result<GuardedBuffer, SessionError> {
            self.unwrap_calls.fetch_add(1, Ordering::SeqCst);
            let der = BASE64.decode(&self.device_key.private_key).unwrap();
            let secret = crypto::secret_key_from_pkcs8(&der).unwrap();
            let mut identity_der =
                crypto::decrypt_payload(&secret, wrap, &[crypto::DEVICE_PAYLOAD_VERSION])
                    .map_err(SessionError::Crypto)?;
            let scalar = crate::key_store::scalar::pkcs8_to_raw_scalar(&identity_der)
                .ok_or_else(|| SessionError::Crypto("not a P-256 PKCS8 key".into()))?;
            identity_der.zeroize();
            Ok(GuardedBuffer::from_slice(&scalar))
        }

        fn requires_presence(&self, _key_id: &str) -> bool {
            self.requires_presence
        }

        fn verify_presence(&self, _reason: &str) -> Result<bool, String> {
            self.presence_calls.fetch_add(1, Ordering::SeqCst);
            self.presence_answer.clone()
        }
    }

    struct Fixture {
        _dir: TempDir,
        manager: IdentitySessionManager,
        paths: SessionPaths,
        identity_plaintext_payload: Vec<u8>,
        presence_calls: Arc<AtomicUsize>,
        unwrap_calls: Arc<AtomicUsize>,
        clock: TestClock,
    }

    #[derive(Clone)]
    struct TestClock {
        wall: Arc<AtomicI64>,
        monotonic: Arc<AtomicI64>,
    }

    impl TestClock {
        fn start() -> Self {
            Self {
                wall: Arc::new(AtomicI64::new(1_700_000_000_000)),
                monotonic: Arc::new(AtomicI64::new(5_000)),
            }
        }
        fn reading(&self) -> ClockReading {
            ClockReading {
                wall: self.wall.load(Ordering::SeqCst),
                monotonic: self.monotonic.load(Ordering::SeqCst),
            }
        }
        fn advance(&self, ms: i64) {
            self.wall.fetch_add(ms, Ordering::SeqCst);
            self.monotonic.fetch_add(ms, Ordering::SeqCst);
        }
    }

    const SECRET: &str = "sk-live-do-not-log-this-🔐";

    fn build(configure: impl FnOnce(&mut FakeCustody)) -> Fixture {
        let dir = TempDir::new();
        let paths = SessionPaths::with_user_dir(dir.path());

        let mut custody = FakeCustody::new();
        configure(&mut custody);
        let presence_calls = custody.presence_calls.clone();
        let unwrap_calls = custody.unwrap_calls.clone();

        // An identity key, wrapped to the fake device key, exactly as the TS
        // side writes it.
        let identity_key = crypto::generate_key_pair().unwrap();
        let identity_der = BASE64.decode(&identity_key.private_key).unwrap();
        let wrap = custody.wrap(&identity_der);

        std::fs::create_dir_all(paths.identity_file("default").parent().unwrap()).unwrap();
        std::fs::write(
            paths.identity_file("default"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "id": "default",
                "publicKey": identity_key.public_key,
                "wraps": { "varlock-default": wrap, "second-key": custody.wrap(&identity_der) },
                "createdAt": "2026-01-01T00:00:00.000Z",
            }))
            .unwrap(),
        )
        .unwrap();

        // A value encrypted to that identity, which is what a decrypt serves.
        let identity_pub = BASE64.decode(&identity_key.public_key).unwrap();
        let identity_plaintext_payload = crypto::encrypt_to_public_key(
            &identity_pub,
            SECRET.as_bytes(),
            crypto::IDENTITY_PAYLOAD_VERSION,
        )
        .unwrap();

        let manager = IdentitySessionManager::new(paths.clone(), Box::new(custody));
        let clock = TestClock::start();
        let clock_for_table = clock.clone();
        manager.set_grant_table(SessionGrantTable::with_clock(move || {
            clock_for_table.reading()
        }));

        Fixture {
            _dir: dir,
            manager,
            paths,
            identity_plaintext_payload,
            presence_calls,
            unwrap_calls,
            clock,
        }
    }

    fn unlock_request<'a>(scope: SessionGrantScope) -> UnlockRequest<'a> {
        UnlockRequest {
            session_id: Some("tty:1:2"),
            key_ids: vec!["varlock-default".into()],
            identity_id: "default".into(),
            scope,
            duration_ms: None,
            lock_on_override: None,
            requester: Some("cargo test (pid 1)".into()),
        }
    }

    fn audit_lines(fixture: &Fixture) -> Vec<serde_json::Value> {
        let path = fixture.paths.audit_dir().join("authorizations.jsonl");
        let Ok(contents) = std::fs::read_to_string(path) else { return Vec::new() };
        contents
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    // ── Unlock ───────────────────────────────────────────────────

    #[test]
    fn an_unlock_opens_a_grant_and_costs_one_presence_check() {
        let fixture = build(|_| {});
        let outcome = fixture
            .manager
            .unlock(unlock_request(SessionGrantScope::Session))
            .expect("unlock should succeed");

        assert_eq!(outcome.grants.len(), 1);
        assert_eq!(outcome.policy, UnlockPolicy::Biometrics);
        assert_eq!(outcome.lock_on, SessionLockPolicy::Sleep);
        assert_eq!(outcome.lock_on_source, LockPolicySource::BuiltInDefault);
        assert!(outcome.prompted);
        assert_eq!(fixture.presence_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn one_unlock_covers_several_keys_with_a_single_check() {
        let fixture = build(|_| {});
        let mut request = unlock_request(SessionGrantScope::Session);
        request.key_ids = vec!["varlock-default".into(), "second-key".into()];

        let outcome = fixture.manager.unlock(request).expect("unlock should succeed");
        assert_eq!(outcome.grants.len(), 2);
        assert_eq!(fixture.presence_calls.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.unwrap_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_second_unlock_of_a_covered_key_asks_nothing() {
        let fixture = build(|_| {});
        fixture.manager.unlock(unlock_request(SessionGrantScope::Session)).unwrap();

        let outcome = fixture
            .manager
            .unlock(unlock_request(SessionGrantScope::Session))
            .expect("second unlock should succeed");
        assert!(!outcome.prompted);
        assert_eq!(outcome.grants.len(), 1);
        assert_eq!(fixture.presence_calls.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.unwrap_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn asking_for_a_stronger_scope_than_is_held_asks_again() {
        let fixture = build(|_| {});
        let mut once = unlock_request(SessionGrantScope::Once);
        once.scope = SessionGrantScope::Once;
        fixture.manager.unlock(once).unwrap();

        let outcome = fixture
            .manager
            .unlock(unlock_request(SessionGrantScope::Session))
            .expect("upgrade should succeed");
        assert!(outcome.prompted);
        assert_eq!(fixture.presence_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_key_with_no_presence_gate_unlocks_silently() {
        let fixture = build(|custody| custody.requires_presence = false);
        let outcome = fixture
            .manager
            .unlock(unlock_request(SessionGrantScope::Session))
            .expect("unlock should succeed");
        assert!(!outcome.prompted);
        assert_eq!(outcome.policy, UnlockPolicy::NoPresenceRequired);
        assert_eq!(fixture.presence_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_declined_presence_check_opens_nothing() {
        let fixture = build(|custody| custody.presence_answer = Ok(false));
        let err = fixture
            .manager
            .unlock(unlock_request(SessionGrantScope::Session))
            .expect_err("a declined check must not unlock");
        assert_eq!(err.code(), Some("BIOMETRIC_FAILED"));
        assert_eq!(fixture.unwrap_calls.load(Ordering::SeqCst), 0);
        assert!(!fixture.manager.has_live_sessions());
        assert!(audit_lines(&fixture).is_empty());
    }

    #[test]
    fn a_failed_presence_check_reports_the_platform_message() {
        let fixture = build(|custody| {
            custody.presence_answer = Err("Windows Hello device busy".into())
        });
        let err = fixture
            .manager
            .unlock(unlock_request(SessionGrantScope::Session))
            .unwrap_err();
        assert_eq!(err.code(), Some("BIOMETRIC_FAILED"));
        assert!(err.to_string().contains("device busy"));
    }

    #[test]
    fn an_unlock_with_no_session_identity_is_refused() {
        let fixture = build(|_| {});
        let mut request = unlock_request(SessionGrantScope::Session);
        request.session_id = None;
        assert_eq!(
            fixture.manager.unlock(request).unwrap_err().code(),
            Some("NO_SESSION_IDENTITY")
        );

        let mut request = unlock_request(SessionGrantScope::Session);
        request.session_id = Some("");
        assert_eq!(
            fixture.manager.unlock(request).unwrap_err().code(),
            Some("NO_SESSION_IDENTITY")
        );
    }

    #[test]
    fn a_key_the_identity_has_no_wrap_for_fails_before_prompting() {
        let fixture = build(|_| {});
        let mut request = unlock_request(SessionGrantScope::Session);
        request.key_ids = vec!["a-key-from-another-machine".into()];

        let err = fixture.manager.unlock(request).unwrap_err();
        assert_eq!(err.code(), Some("IDENTITY_NO_WRAP_FOR_KEY"));
        assert_eq!(fixture.presence_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn an_unknown_identity_is_reported_as_not_found() {
        let fixture = build(|_| {});
        let mut request = unlock_request(SessionGrantScope::Session);
        request.identity_id = "work".into();
        assert_eq!(
            fixture.manager.unlock(request).unwrap_err().code(),
            Some("IDENTITY_NOT_FOUND")
        );
    }

    #[test]
    fn the_machine_config_sets_the_lock_policy_and_is_read_fresh() {
        let fixture = build(|_| {});
        std::fs::write(
            fixture.paths.machine_config_file(),
            br#"{"sessions":{"lockOn":"none"}}"#,
        )
        .unwrap();

        let outcome = fixture
            .manager
            .unlock(unlock_request(SessionGrantScope::Session))
            .unwrap();
        assert_eq!(outcome.lock_on, SessionLockPolicy::None);
        assert_eq!(outcome.lock_on_source, LockPolicySource::MachineConfig);
    }

    #[test]
    fn an_unlock_override_beats_the_machine_config() {
        let fixture = build(|_| {});
        std::fs::write(
            fixture.paths.machine_config_file(),
            br#"{"sessions":{"lockOn":"none"}}"#,
        )
        .unwrap();

        let mut request = unlock_request(SessionGrantScope::Session);
        request.lock_on_override = Some("screenLock");
        let outcome = fixture.manager.unlock(request).unwrap();
        assert_eq!(outcome.lock_on, SessionLockPolicy::ScreenLock);
        assert_eq!(outcome.lock_on_source, LockPolicySource::SessionOverride);
    }

    // ── Decrypt ──────────────────────────────────────────────────

    #[test]
    fn a_decrypt_under_a_live_grant_returns_the_plaintext() {
        let fixture = build(|_| {});
        fixture.manager.unlock(unlock_request(SessionGrantScope::Session)).unwrap();

        let (plaintexts, grant) = fixture
            .manager
            .decrypt_v2(
                Some("tty:1:2"),
                "varlock-default",
                "default",
                std::slice::from_ref(&fixture.identity_plaintext_payload),
                Some("cargo test".into()),
            )
            .expect("decrypt should succeed");

        assert_eq!(plaintexts, vec![SECRET.to_string()]);
        assert_eq!(grant.use_count, 1);
    }

    #[test]
    fn a_batch_is_one_grant_use_however_many_payloads() {
        let fixture = build(|_| {});
        fixture.manager.unlock(unlock_request(SessionGrantScope::Once)).unwrap();

        let batch = vec![
            fixture.identity_plaintext_payload.clone(),
            fixture.identity_plaintext_payload.clone(),
            fixture.identity_plaintext_payload.clone(),
        ];
        let (plaintexts, grant) = fixture
            .manager
            .decrypt_v2(Some("tty:1:2"), "varlock-default", "default", &batch, None)
            .expect("decrypt should succeed");
        assert_eq!(plaintexts.len(), 3);
        assert_eq!(grant.use_count, 1);

        // and the once grant is now spent
        let err = fixture
            .manager
            .decrypt_v2(Some("tty:1:2"), "varlock-default", "default", &batch, None)
            .unwrap_err();
        assert_eq!(err.code(), Some("NO_SESSION_GRANT"));
    }

    #[test]
    fn a_decrypt_without_an_unlock_is_refused() {
        let fixture = build(|_| {});
        let err = fixture
            .manager
            .decrypt_v2(
                Some("tty:1:2"),
                "varlock-default",
                "default",
                std::slice::from_ref(&fixture.identity_plaintext_payload),
                None,
            )
            .unwrap_err();
        assert_eq!(err.code(), Some("NO_SESSION_GRANT"));
        assert_eq!(fixture.presence_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn another_session_cannot_use_this_sessions_grant() {
        let fixture = build(|_| {});
        fixture.manager.unlock(unlock_request(SessionGrantScope::Session)).unwrap();

        let err = fixture
            .manager
            .decrypt_v2(
                Some("tty:9:9"),
                "varlock-default",
                "default",
                std::slice::from_ref(&fixture.identity_plaintext_payload),
                None,
            )
            .unwrap_err();
        assert_eq!(err.code(), Some("NO_SESSION_GRANT"));
    }

    #[test]
    fn an_expired_grant_says_so_rather_than_claiming_it_never_existed() {
        let fixture = build(|_| {});
        fixture
            .manager
            .unlock(UnlockRequest {
                duration_ms: Some(1_000),
                ..unlock_request(SessionGrantScope::Duration)
            })
            .unwrap();

        fixture.clock.advance(2_000);
        let err = fixture
            .manager
            .decrypt_v2(
                Some("tty:1:2"),
                "varlock-default",
                "default",
                std::slice::from_ref(&fixture.identity_plaintext_payload),
                None,
            )
            .unwrap_err();
        assert_eq!(err.code(), Some("SESSION_GRANT_EXPIRED"));
        assert_eq!(fixture.manager.held_session_count(), 0, "key material should be gone");
    }

    #[test]
    fn a_decrypt_never_prompts() {
        let fixture = build(|_| {});
        fixture.manager.unlock(unlock_request(SessionGrantScope::Session)).unwrap();
        let before = fixture.presence_calls.load(Ordering::SeqCst);

        for _ in 0..5 {
            fixture
                .manager
                .decrypt_v2(
                    Some("tty:1:2"),
                    "varlock-default",
                    "default",
                    std::slice::from_ref(&fixture.identity_plaintext_payload),
                    None,
                )
                .unwrap();
        }
        assert_eq!(fixture.presence_calls.load(Ordering::SeqCst), before);
    }

    // ── Invalidation and lock events ─────────────────────────────

    #[test]
    fn invalidating_erases_the_held_key() {
        let fixture = build(|_| {});
        fixture.manager.unlock(unlock_request(SessionGrantScope::Session)).unwrap();
        assert_eq!(fixture.manager.held_session_count(), 1);

        assert_eq!(fixture.manager.invalidate(None, None, None), 1);
        assert_eq!(fixture.manager.held_session_count(), 0);
        assert!(!fixture.manager.has_live_sessions());
    }

    #[test]
    fn a_lock_event_only_ends_the_sessions_that_asked_for_it() {
        let fixture = build(|_| {});
        let mut request = unlock_request(SessionGrantScope::Session);
        request.lock_on_override = Some("none");
        fixture.manager.unlock(request).unwrap();

        assert_eq!(fixture.manager.handle_lock_event(SessionLockEvent::Sleep), 0);
        assert!(fixture.manager.has_live_sessions());
        assert_eq!(fixture.manager.lock_policy("tty:1:2"), Some(SessionLockPolicy::None));

        // and an explicit lock always erases, whatever the policy says
        assert_eq!(fixture.manager.invalidate(None, None, None), 1);
        assert!(!fixture.manager.has_live_sessions());
    }

    #[test]
    fn sleep_ends_a_default_session() {
        let fixture = build(|_| {});
        fixture.manager.unlock(unlock_request(SessionGrantScope::Session)).unwrap();
        assert_eq!(fixture.manager.handle_lock_event(SessionLockEvent::ScreenLock), 0);
        assert_eq!(fixture.manager.handle_lock_event(SessionLockEvent::Sleep), 1);
        assert_eq!(fixture.manager.held_session_count(), 0);
    }

    // ── The death invariant ──────────────────────────────────────

    #[test]
    fn a_daemon_restart_loses_every_grant() {
        let dir = TempDir::new();
        let paths = SessionPaths::with_user_dir(dir.path());

        // Build the identity and its wrap once, then run two managers over the
        // same user directory: the second one stands in for a restarted daemon.
        let custody = FakeCustody::new();
        let identity_key = crypto::generate_key_pair().unwrap();
        let identity_der = BASE64.decode(&identity_key.private_key).unwrap();
        std::fs::create_dir_all(paths.identity_file("default").parent().unwrap()).unwrap();
        std::fs::write(
            paths.identity_file("default"),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "id": "default",
                "publicKey": identity_key.public_key,
                "wraps": { "varlock-default": custody.wrap(&identity_der) },
                "createdAt": "2026-01-01T00:00:00.000Z",
            }))
            .unwrap(),
        )
        .unwrap();
        let device_key = crypto::KeyPair {
            public_key: custody.device_key.public_key.clone(),
            private_key: custody.device_key.private_key.clone(),
        };

        let first = IdentitySessionManager::new(paths.clone(), Box::new(custody));
        first.unlock(unlock_request(SessionGrantScope::Session)).unwrap();
        assert!(first.has_live_sessions());

        // The daemon goes away.
        drop(first);

        let second_custody = FakeCustody {
            device_key,
            requires_presence: true,
            presence_answer: Ok(true),
            presence_calls: Arc::new(AtomicUsize::new(0)),
            unwrap_calls: Arc::new(AtomicUsize::new(0)),
        };
        let second = IdentitySessionManager::new(paths.clone(), Box::new(second_custody));

        assert!(!second.has_live_sessions(), "a restart must not inherit grants");
        assert!(second.list_grants().is_empty());
        let err = second
            .decrypt_v2(Some("tty:1:2"), "varlock-default", "default", &[vec![0u8; 100]], None)
            .unwrap_err();
        assert_eq!(err.code(), Some("NO_SESSION_GRANT"));
    }

    #[test]
    fn nothing_about_a_session_is_written_to_disk() {
        let fixture = build(|_| {});
        fixture.manager.unlock(unlock_request(SessionGrantScope::Session)).unwrap();
        fixture
            .manager
            .decrypt_v2(
                Some("tty:1:2"),
                "varlock-default",
                "default",
                std::slice::from_ref(&fixture.identity_plaintext_payload),
                None,
            )
            .unwrap();

        // Everything under the user dir has to be one of the files that were
        // already there, plus the append-only log. A new file would mean session
        // state outliving the process.
        let mut found: Vec<String> = Vec::new();
        collect_files(fixture.paths.user_dir(), fixture.paths.user_dir(), &mut found);
        found.sort();
        assert_eq!(
            found,
            vec![
                "audit/authorizations.jsonl".to_string(),
                "identities/default.json".to_string(),
            ]
        );

        // and the log itself carries no secret material
        let log = std::fs::read_to_string(
            fixture.paths.audit_dir().join("authorizations.jsonl"),
        )
        .unwrap();
        assert!(!log.contains(SECRET));
    }

    fn collect_files(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_files(root, &path, out);
            } else if let Ok(relative) = path.strip_prefix(root) {
                out.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }

    // ── Audit before release ─────────────────────────────────────

    #[test]
    fn every_authorization_is_recorded() {
        let fixture = build(|_| {});
        fixture.manager.unlock(unlock_request(SessionGrantScope::Session)).unwrap();
        fixture
            .manager
            .decrypt_v2(
                Some("tty:1:2"),
                "varlock-default",
                "default",
                &[
                    fixture.identity_plaintext_payload.clone(),
                    fixture.identity_plaintext_payload.clone(),
                ],
                Some("node (pid 7)".into()),
            )
            .unwrap();
        fixture.manager.invalidate(None, None, Some("node (pid 7)".into()));

        let records = audit_lines(&fixture);
        let events: Vec<&str> = records
            .iter()
            .map(|record| record["event"].as_str().unwrap())
            .collect();
        assert_eq!(events, vec!["unlock-session", "decrypt-v2", "invalidate-session"]);

        assert_eq!(records[1]["payloadCount"], serde_json::json!(2));
        assert_eq!(records[1]["scope"], serde_json::json!("session"));
        assert_eq!(records[1]["requester"], serde_json::json!("node (pid 7)"));
        assert_eq!(records[1]["sessionId"], serde_json::json!("tty:1:2"));
    }

    #[test]
    fn a_decrypt_is_refused_when_its_authorization_cannot_be_recorded() {
        let fixture = build(|_| {});
        fixture.manager.unlock(unlock_request(SessionGrantScope::Session)).unwrap();

        // Make the log unwritable by putting a file where its directory is. The
        // unlock has already created the directory, so remove it first.
        let audit_dir = fixture.paths.audit_dir();
        std::fs::remove_dir_all(&audit_dir).unwrap();
        std::fs::write(&audit_dir, b"not a directory").unwrap();

        let err = fixture
            .manager
            .decrypt_v2(
                Some("tty:1:2"),
                "varlock-default",
                "default",
                std::slice::from_ref(&fixture.identity_plaintext_payload),
                None,
            )
            .expect_err("a decrypt with no record must not return plaintext");
        assert_eq!(err.code(), Some("AUDIT_WRITE_FAILED"));
        assert!(err.to_string().contains("Refusing to release secrets"));
    }

    #[test]
    fn an_unlock_that_cannot_be_recorded_hands_its_keys_back() {
        let dir = TempDir::new();
        let paths = SessionPaths::with_user_dir(dir.path());

        let custody = FakeCustody::new();
        let identity_key = crypto::generate_key_pair().unwrap();
        let identity_der = BASE64.decode(&identity_key.private_key).unwrap();
        std::fs::create_dir_all(paths.identity_file("default").parent().unwrap()).unwrap();
        std::fs::write(
            paths.identity_file("default"),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "id": "default",
                "publicKey": identity_key.public_key,
                "wraps": { "varlock-default": custody.wrap(&identity_der) },
                "createdAt": "2026-01-01T00:00:00.000Z",
            }))
            .unwrap(),
        )
        .unwrap();

        // A file where the audit directory belongs, from the very start.
        std::fs::write(paths.audit_dir(), b"not a directory").unwrap();

        let manager = IdentitySessionManager::new(paths, Box::new(custody));
        let err = manager
            .unlock(unlock_request(SessionGrantScope::Session))
            .expect_err("an unrecordable unlock must not stand");
        assert_eq!(err.code(), Some("AUDIT_WRITE_FAILED"));
        assert!(!manager.has_live_sessions());
        assert_eq!(manager.held_session_count(), 0, "the key must not still be held");
    }

    // ── Coverage rules ───────────────────────────────────────────

    #[test]
    fn coverage_rules_match_the_swift_planner() {
        let info = |scope, remaining_ms| SessionGrantInfo {
            session_id: "s".into(),
            key_id: "k".into(),
            identity_id: "default".into(),
            scope,
            granted_at: 0,
            expires_at: 0,
            remaining_ms,
            last_used_at: None,
            session_unlocked_at: 0,
            session_expires_at: 0,
            session_remaining_ms: remaining_ms,
            lock_on: SessionLockPolicy::Sleep,
            use_count: 0,
        };

        // a session grant covers everything
        for scope in [
            SessionGrantScope::Once,
            SessionGrantScope::Session,
            SessionGrantScope::Duration,
        ] {
            assert!(covers(&info(SessionGrantScope::Session, 1_000), scope, Some(500)));
        }

        // a once grant covers only another once request
        assert!(covers(&info(SessionGrantScope::Once, 1_000), SessionGrantScope::Once, None));
        assert!(!covers(&info(SessionGrantScope::Once, 1_000), SessionGrantScope::Session, None));
        assert!(!covers(
            &info(SessionGrantScope::Once, 1_000),
            SessionGrantScope::Duration,
            Some(10)
        ));

        // a duration grant covers a once request, and a shorter duration request
        assert!(covers(&info(SessionGrantScope::Duration, 1_000), SessionGrantScope::Once, None));
        assert!(covers(
            &info(SessionGrantScope::Duration, 1_000),
            SessionGrantScope::Duration,
            Some(900)
        ));
        assert!(!covers(
            &info(SessionGrantScope::Duration, 1_000),
            SessionGrantScope::Duration,
            Some(1_100)
        ));
        assert!(!covers(
            &info(SessionGrantScope::Duration, 1_000),
            SessionGrantScope::Session,
            None
        ));

        // and nothing with no time left covers anything
        assert!(!covers(&info(SessionGrantScope::Session, 0), SessionGrantScope::Once, None));
    }

    #[test]
    fn the_prompt_reason_names_the_keys_and_the_requester() {
        let reason = unlock_reason(
            "default",
            &["b-key".into(), "a-key".into()],
            Some("node (pid 7)"),
        );
        assert_eq!(
            reason,
            "unlock varlock encryption key a-key, b-key, node (pid 7)"
        );

        let named = unlock_reason("work", &["k".into()], None);
        assert_eq!(named, "unlock varlock identity \"work\" with key k");
    }
}
