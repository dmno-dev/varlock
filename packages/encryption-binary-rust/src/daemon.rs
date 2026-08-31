//! Daemon mode — long-lived process with IPC server, session management, and auto-shutdown.
//!
//! Speaks the same protocol as the Swift macOS daemon:
//!   - Accepts connections over Unix socket (Linux) or named pipe (Windows)
//!   - Device actions: decrypt, encrypt, ping, invalidate-session
//!   - Identity session actions: unlock-session, decrypt-v2, list-sessions, and
//!     the per-session form of invalidate-session
//!   - On Windows with Hello: requires a presence check before an unlock
//!   - No prompt-secret (no GUI on Linux — handled by terminal prompt in TS)
//!   - Auto-shutdown after inactivity, unless a session is being held
//!   - Session invalidation on SIGTERM/SIGINT
//!
//! What is deliberately absent, compared with the macOS daemon: there is no
//! approval panel and no `request-approval`. Neither platform has a trusted
//! display for the daemon to draw on yet, so approval surfaces (phone, terminal)
//! arrive later. See [`DAEMON_PROTOCOL_VERSION`].

use crate::crypto;
use crate::identity_sessions::custody::KeyStoreCustody;
use crate::identity_sessions::grants::{SessionGrantScope, MAX_GRANT_MS};
use crate::identity_sessions::identity_store::{SessionPaths, DEFAULT_IDENTITY_ID};
use crate::identity_sessions::lock_events;
use crate::identity_sessions::lock_policy::SessionLockEvent;
use crate::identity_sessions::manager::{
    IdentitySessionManager, SessionError, UnlockRequest,
};
use crate::ipc::{IpcServer, MessageHandler, PeerContext};
use crate::key_store;
use crate::secure_mem;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DEFAULT_KEY_ID: &str = "varlock-default";

/// IPC protocol version reported by `ping`.
///
/// 1 (reported as absent) is the original action set. 2 adds the identity
/// session ops: unlock-session, decrypt-v2, list-sessions, and the per-session
/// form of invalidate-session. 3 is what the macOS daemon reports once it draws
/// an approval panel.
///
/// This daemon reports 3 because it speaks every op a client dispatches on, and
/// a client that saw 2 here would hold back features that do work. The panel
/// half of 3 has no counterpart on these platforms: `unlock-session` never
/// answers `APPROVAL_DENIED` or `NO_UI`, and `request-approval` is not
/// implemented. Neither is something a client has to do anything about, since
/// both are outcomes it already has to handle from a daemon that never prompts.
const DAEMON_PROTOCOL_VERSION: u32 = 3;

// On Windows the daemon can't be re-spawned from a WSL2-invoked .exe (no access
// to the interactive desktop session), so a short timeout would force the user
// back to a native Windows terminal. Keep it alive for a full day there.
#[cfg(target_os = "windows")]
const DAEMON_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60); // 24 hours
#[cfg(not(target_os = "windows"))]
const DAEMON_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(30 * 60); // 30 minutes
const SESSION_TIMEOUT: Duration = Duration::from_secs(5 * 60); // 5 minutes per session

/// How often expired grants are swept, so a hard-cap expiry erases key material
/// even on a daemon nobody is talking to.
const PRUNE_INTERVAL: Duration = Duration::from_secs(60);

/// Per-TTY session state for the pre-identity device decrypt path.
struct SessionManager {
    /// Map of session keys to their session creation time.
    /// Sessions expire after SESSION_TIMEOUT.
    active_sessions: std::collections::HashMap<String, Instant>,
    /// Last IPC activity timestamp for daemon timeout.
    last_activity: Instant,
    /// Whether biometric verification is available on this platform.
    biometric_available: bool,
}

impl SessionManager {
    fn new() -> Self {
        let info = key_store::get_platform_info();
        Self {
            active_sessions: std::collections::HashMap::new(),
            last_activity: Instant::now(),
            biometric_available: info.biometric_available,
        }
    }

    fn note_activity(&mut self) {
        self.last_activity = Instant::now();
    }

    fn is_session_warm(&self, session_key: &Option<String>) -> bool {
        let key = session_key.as_deref().unwrap_or("__no_tty__");
        match self.active_sessions.get(key) {
            Some(created_at) => created_at.elapsed() < SESSION_TIMEOUT,
            None => false,
        }
    }

    fn mark_session_warm(&mut self, session_key: &Option<String>) {
        let key = session_key.as_deref().unwrap_or("__no_tty__").to_string();
        self.active_sessions.insert(key, Instant::now());
    }

    fn invalidate_all(&mut self) {
        self.active_sessions.clear();
    }

    fn is_timed_out(&self) -> bool {
        self.last_activity.elapsed() > DAEMON_INACTIVITY_TIMEOUT
    }

    /// Whether the next decrypt should require biometric verification.
    fn needs_biometric(&self, session_key: &Option<String>) -> bool {
        self.biometric_available && !self.is_session_warm(session_key)
    }
}

/// Run the daemon.
pub fn run_daemon(socket_path: &str, pid_path: Option<&str>) -> Result<(), String> {
    // Before anything can be held: no core dumps, and (on Linux) no ptrace from
    // a sibling process. Done first so it also covers a key held for a moment
    // by the pre-identity decrypt path.
    secure_mem::harden_process();

    // Write PID file
    if let Some(pid_path) = pid_path {
        if let Some(parent) = std::path::Path::new(pid_path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(pid_path, std::process::id().to_string())
            .map_err(|e| format!("Failed to write PID file: {e}"))?;
    }

    let session_manager = Arc::new(Mutex::new(SessionManager::new()));
    let identity_sessions = Arc::new(IdentitySessionManager::new(
        SessionPaths::from_user_config_dir(),
        Box::new(KeyStoreCustody::new()),
    ));
    let mut server = IpcServer::new(socket_path);

    // Sleep and screen lock are judged per session: each one is erased only if
    // its own resolved lockOn policy says that event ends it.
    let identity_for_events = identity_sessions.clone();
    let lock_sources = lock_events::start(Arc::new(move |event: SessionLockEvent| {
        let dropped = identity_for_events.handle_lock_event(event);
        if dropped > 0 {
            eprintln!(
                "varlock: {dropped} unlock session(s) ended by {}",
                event.wire_value()
            );
        }
    }));

    // Activity callback
    let sm_activity = session_manager.clone();
    server.set_activity_callback(move || {
        if let Ok(mut sm) = sm_activity.lock() {
            sm.note_activity();
        }
    });

    // Message handler
    let sm_handler = session_manager.clone();
    let identity_handler = identity_sessions.clone();
    let handler: MessageHandler = Box::new(move |message: Value, peer: PeerContext| {
        let action = message
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match action {
            "decrypt" => handle_decrypt(&message, &peer, &sm_handler),
            "encrypt" => handle_encrypt(&message),
            "ping" => handle_ping(&peer, &sm_handler),
            "invalidate-session" => {
                handle_invalidate(&message, &peer, &sm_handler, &identity_handler)
            }
            "unlock-session" => handle_unlock_session(&message, &peer, &identity_handler),
            "decrypt-v2" => handle_decrypt_v2(&message, &peer, &identity_handler),
            "list-sessions" => handle_list_sessions(&identity_handler),
            _ => json!({"error": format!("Unknown action: {action}")}),
        }
    });
    server.set_message_handler(handler);

    let running = server.running_flag();

    // Signal handling
    let pid_path_owned = pid_path.map(|s| s.to_string());

    #[cfg(unix)]
    {
        let _ = ctrlc_handler(running.clone());
    }

    // Inactivity timeout checker, session expiry cleanup, and the grant sweep
    let sm_timeout = session_manager.clone();
    let identity_timeout = identity_sessions.clone();
    let running_timeout = running.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(PRUNE_INTERVAL);
            if !running_timeout.load(Ordering::SeqCst) {
                break;
            }

            // Sweep expired grants first, so a hard-cap expiry erases the key it
            // was covering even if nothing is talking to the daemon.
            identity_timeout.reconcile();
            let holding_keys = identity_timeout.has_live_sessions();

            if let Ok(mut sm) = sm_timeout.lock() {
                // Clean up expired sessions
                sm.active_sessions.retain(|_, created_at| {
                    created_at.elapsed() < SESSION_TIMEOUT
                });

                // Never idle-quit while an identity key is being held for
                // someone: session state is memory-only, so quitting would
                // silently cost them their unlock.
                if sm.is_timed_out() && !holding_keys {
                    running_timeout.store(false, Ordering::SeqCst);
                    break;
                }
            }
        }
    });

    // Print ready message (matches Swift daemon format)
    let ready = json!({
        "ready": true,
        "pid": std::process::id(),
        "socketPath": socket_path,
        "protocolVersion": DAEMON_PROTOCOL_VERSION,
        // Which system events can end a session on this machine. Empty means a
        // session runs to its TTL or an explicit lock, and nothing else.
        "lockTriggers": lock_sources.wired(),
    });
    println!("{}", ready);
    use std::io::Write;
    let _ = std::io::stdout().flush();

    // Start server (blocks)
    let result = server.start();

    // Whatever stopped the daemon, nothing may outlive it: drop every grant and
    // erase the keys they covered before the process goes away.
    identity_sessions.invalidate(None, None, Some("daemon shutdown".into()));

    // Cleanup
    if let Some(pp) = &pid_path_owned {
        let _ = std::fs::remove_file(pp);
    }

    result
}

// ── Message handlers ─────────────────────────────────────────────

fn handle_decrypt(
    message: &Value,
    peer: &PeerContext,
    sm: &Arc<Mutex<SessionManager>>,
) -> Value {
    let payload = match message.get("payload") {
        Some(p) => p,
        None => return json!({"error": "Missing payload"}),
    };

    let ciphertext_b64 = match payload.get("ciphertext").and_then(|v| v.as_str()) {
        Some(ct) => ct,
        None => return json!({"error": "Missing or invalid ciphertext in payload"}),
    };

    let key_id = payload
        .get("keyId")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_KEY_ID);

    // Check if biometric verification is needed
    let session_key = peer.legacy_session_key();
    let needs_bio = sm.lock().map(|s| s.needs_biometric(&session_key)).unwrap_or(false);

    if needs_bio {
        match verify_user_presence() {
            Ok(true) => {} // Verified — proceed
            Ok(false) => return json!({"error": "User verification cancelled"}),
            Err(e) => return json!({"error": format!("Biometric verification failed: {e}")}),
        }
    }

    // Load key and decrypt — private key is held in locked, zeroize-on-drop memory
    match key_store::load_key(key_id) {
        Ok((private_key_der, public_key_b64)) => {
            let secure_key = crate::secure_mem::SecureBytes::new(private_key_der);
            let private_key_b64 = crate::secure_mem::SecureString::new(
                BASE64.encode(secure_key.as_slice()),
            );

            let result = match crypto::decrypt(private_key_b64.as_str(), &public_key_b64, ciphertext_b64) {
                Ok(plaintext_bytes) => {
                    match String::from_utf8(plaintext_bytes) {
                        Ok(plaintext) => {
                            // Mark session as warm
                            if let Ok(mut session) = sm.lock() {
                                session.mark_session_warm(&session_key);
                            }
                            json!({"result": plaintext})
                        }
                        Err(_) => json!({"error": "Decrypted data is not valid UTF-8"}),
                    }
                }
                Err(e) => json!({"error": e}),
            };
            drop(secure_key); // explicit drop zeroizes + unlocks
            result
        }
        Err(e) => json!({"error": e}),
    }
}

fn handle_encrypt(message: &Value) -> Value {
    let payload = match message.get("payload") {
        Some(p) => p,
        None => return json!({"error": "Missing payload"}),
    };

    let plaintext = match payload.get("plaintext").and_then(|v| v.as_str()) {
        Some(pt) => pt,
        None => return json!({"error": "Missing plaintext in payload"}),
    };

    // Encrypting to an identity public key needs no key of ours and no unlock:
    // the caller supplies the recipient. This is the shape a capture path wants,
    // where the daemon must hand back ciphertext and nothing else.
    if let Some(identity_public_key) = payload.get("identityPublicKey").and_then(|v| v.as_str()) {
        let recipient = match BASE64.decode(identity_public_key) {
            Ok(bytes) => bytes,
            Err(_) => return json!({"error": "Invalid base64 identityPublicKey"}),
        };
        return match crypto::encrypt_to_public_key(
            &recipient,
            plaintext.as_bytes(),
            crypto::IDENTITY_PAYLOAD_VERSION,
        ) {
            Ok(payload) => json!({"result": BASE64.encode(&payload)}),
            Err(e) => json!({"error": e}),
        };
    }

    let key_id = payload
        .get("keyId")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_KEY_ID);

    match key_store::load_public_key(key_id) {
        Ok(public_key_b64) => match crypto::encrypt(&public_key_b64, plaintext.as_bytes()) {
            Ok(ciphertext) => json!({"result": ciphertext}),
            Err(e) => json!({"error": e}),
        },
        Err(e) => json!({"error": e}),
    }
}

fn handle_ping(peer: &PeerContext, sm: &Arc<Mutex<SessionManager>>) -> Value {
    let session_key = peer.legacy_session_key();
    let session_warm = sm
        .lock()
        .map(|s| s.is_session_warm(&session_key))
        .unwrap_or(false);

    json!({
        "result": {
            "pong": true,
            "sessionWarm": session_warm,
            // The session this daemon resolved for the caller, from the caller's
            // own process. Absent when the platform could not work one out.
            "sessionId": peer.session_id,
            // Kept for the older clients that read it.
            "ttyId": session_key.unwrap_or_default(),
            // Absent means 1 (a daemon predating identity sessions), so a client
            // can tell a stale daemon from one that speaks these ops.
            "protocolVersion": DAEMON_PROTOCOL_VERSION,
        }
    })
}

fn handle_invalidate(
    message: &Value,
    peer: &PeerContext,
    sm: &Arc<Mutex<SessionManager>>,
    identity: &Arc<IdentitySessionManager>,
) -> Value {
    let payload = message.get("payload");
    let target_session_id = payload
        .and_then(|p| p.get("sessionId"))
        .and_then(|v| v.as_str());
    let target_key_id = payload.and_then(|p| p.get("keyId")).and_then(|v| v.as_str());

    // No arguments keeps the original meaning: drop everything, including the
    // cached device-decrypt sessions.
    if target_session_id.is_none() && target_key_id.is_none() {
        if let Ok(mut session) = sm.lock() {
            session.invalidate_all();
        }
    }

    let invalidated = identity.invalidate(target_session_id, target_key_id, peer.requester.clone());
    json!({"result": {"invalidated": invalidated}})
}

// ── Identity session handlers ────────────────────────────────────

fn handle_unlock_session(
    message: &Value,
    peer: &PeerContext,
    identity: &Arc<IdentitySessionManager>,
) -> Value {
    // A malformed message is refused rather than guessed at, the same way
    // decrypt-v2 refuses one. Guessing here would mean unlocking a key the
    // caller never named.
    let Some(payload) = message.get("payload") else {
        return json!({"error": "Missing payload"});
    };

    let identity_id = payload
        .get("identityId")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_IDENTITY_ID)
        .to_string();

    let scope = SessionGrantScope::from_wire_value(payload.get("scope").and_then(|v| v.as_str()))
        .unwrap_or(SessionGrantScope::Session);

    // Accept one key or several: one unlock, one check, however many keys.
    // Deliberately no default: naming no key is refused, not guessed at.
    let mut key_ids: Vec<String> = payload
        .get("keyIds")
        .and_then(|v| v.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    if let Some(single) = payload.get("keyId").and_then(|v| v.as_str()) {
        if !single.trim().is_empty() {
            key_ids.push(single.to_string());
        }
    }
    key_ids.sort();
    key_ids.dedup();

    let duration_ms = payload
        .get("durationMs")
        .and_then(|v| v.as_i64())
        .map(|ms| ms.clamp(0, MAX_GRANT_MS));

    let lock_on_override = payload.get("lockOn").and_then(|v| v.as_str());

    // A caller may name the session it believes it is in, but that never
    // overrides the identity resolved from the peer process itself.
    let request = UnlockRequest {
        session_id: peer.session_id.as_deref(),
        key_ids,
        identity_id,
        scope,
        duration_ms,
        lock_on_override,
        requester: peer.requester.clone(),
    };

    match identity.unlock(request) {
        Ok(outcome) => json!({
            "result": {
                "sessionId": peer.session_id,
                "policy": outcome.policy.wire_value(),
                "lockOn": outcome.lock_on.wire_value(),
                "lockOnSource": outcome.lock_on_source.wire_value(),
                "prompted": outcome.prompted,
                "grants": outcome.grants.iter().map(|g| g.to_json()).collect::<Vec<_>>(),
            }
        }),
        Err(err) => session_error_response(&err),
    }
}

fn handle_decrypt_v2(
    message: &Value,
    peer: &PeerContext,
    identity: &Arc<IdentitySessionManager>,
) -> Value {
    let Some(payload) = message.get("payload") else {
        return json!({"error": "Missing payload"});
    };

    let key_id = payload
        .get("keyId")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_KEY_ID);
    let identity_id = payload
        .get("identityId")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_IDENTITY_ID);

    // Batch form is the normal one (a whole env file resolves at once); the
    // single-ciphertext form is accepted for one-off callers.
    let mut ciphertexts: Vec<&str> = payload
        .get("ciphertexts")
        .and_then(|v| v.as_array())
        .map(|values| values.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    if let Some(single) = payload.get("ciphertext").and_then(|v| v.as_str()) {
        ciphertexts.push(single);
    }
    if ciphertexts.is_empty() {
        return json!({"error": "Missing ciphertext in payload"});
    }

    let mut payloads = Vec::with_capacity(ciphertexts.len());
    for ciphertext in &ciphertexts {
        match BASE64.decode(ciphertext) {
            Ok(bytes) => payloads.push(bytes),
            Err(_) => return json!({"error": "Invalid base64 in ciphertext payload"}),
        }
    }

    match identity.decrypt_v2(
        peer.session_id.as_deref(),
        key_id,
        identity_id,
        &payloads,
        peer.requester.clone(),
    ) {
        Ok((plaintexts, grant)) => json!({
            "result": {
                "plaintexts": plaintexts,
                "grant": grant.to_json(),
            }
        }),
        Err(err) => session_error_response(&err),
    }
}

fn handle_list_sessions(identity: &Arc<IdentitySessionManager>) -> Value {
    let sessions: Vec<Value> = identity.list_grants().iter().map(|g| g.to_json()).collect();
    json!({"result": {"sessions": sessions}})
}

/// Attach the stable error code, where there is one, alongside the message. The
/// TS client branches on the code and shows the message.
fn session_error_response(error: &SessionError) -> Value {
    let mut response = json!({"error": error.to_string()});
    if let (Some(code), Some(object)) = (error.code(), response.as_object_mut()) {
        object.insert("errorCode".into(), json!(code));
    }
    response
}

// ── Biometric verification ───────────────────────────────────────

/// Verify user presence using platform-specific biometric.
/// Returns Ok(true) if verified, Ok(false) if cancelled.
fn verify_user_presence() -> Result<bool, String> {
    crate::identity_sessions::custody::verify_user_presence(
        "Varlock needs to decrypt your secrets",
    )
}

// ── Signal handling ──────────────────────────────────────────────

#[cfg(unix)]
fn ctrlc_handler(running: Arc<AtomicBool>) -> Result<(), String> {
    unsafe {
        libc::signal(libc::SIGTERM, signal_handler as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, signal_handler as *const () as libc::sighandler_t);
    }

    RUNNING_FLAG
        .lock()
        .map_err(|e| format!("Failed to set signal handler: {e}"))?
        .replace(running);

    Ok(())
}

#[cfg(unix)]
static RUNNING_FLAG: std::sync::Mutex<Option<Arc<AtomicBool>>> = std::sync::Mutex::new(None);

#[cfg(unix)]
extern "C" fn signal_handler(_sig: libc::c_int) {
    if let Ok(guard) = RUNNING_FLAG.lock() {
        if let Some(ref running) = *guard {
            running.store(false, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_sessions::audit::AuditWriteError;
    use crate::identity_sessions::grants::{SessionGrantError, SessionGrantRef};

    fn peer(session_id: Option<&str>) -> PeerContext {
        PeerContext {
            session_id: session_id.map(|s| s.to_string()),
            requester: Some("cargo test (pid 42)".into()),
            claimed_session_id: Some("tty:a-session-the-caller-named".into()),
        }
    }

    fn manager() -> Arc<IdentitySessionManager> {
        // A manager pointed at a directory that holds no identity: enough to
        // exercise message parsing and the refusal paths without a key store.
        Arc::new(IdentitySessionManager::new(
            SessionPaths::with_user_dir(std::env::temp_dir().join("varlock-no-such-dir")),
            Box::new(KeyStoreCustody::new()),
        ))
    }

    #[test]
    fn decrypt_v2_refuses_a_session_with_no_grant() {
        let message = json!({
            "action": "decrypt-v2",
            "payload": { "keyId": "varlock-default", "ciphertexts": [BASE64.encode([0u8; 100])] },
        });
        let response = handle_decrypt_v2(&message, &peer(Some("tty:1:2")), &manager());
        assert_eq!(response["errorCode"], json!("NO_SESSION_GRANT"));
        assert!(response.get("result").is_none());
    }

    #[test]
    fn decrypt_v2_refuses_when_the_peer_has_no_session_identity() {
        // The caller named a session in the message. It must not be used.
        let message = json!({
            "action": "decrypt-v2",
            "payload": { "ciphertexts": [BASE64.encode([0u8; 100])] },
        });
        let response = handle_decrypt_v2(&message, &peer(None), &manager());
        assert_eq!(response["errorCode"], json!("NO_SESSION_IDENTITY"));
    }

    #[test]
    fn unlock_refuses_when_the_peer_has_no_session_identity() {
        let message = json!({"action": "unlock-session", "payload": {"scope": "session"}});
        let response = handle_unlock_session(&message, &peer(None), &manager());
        assert_eq!(response["errorCode"], json!("NO_SESSION_IDENTITY"));
    }

    #[test]
    fn unlock_refuses_a_message_with_no_payload() {
        let message = json!({"action": "unlock-session"});
        let response = handle_unlock_session(&message, &peer(Some("tty:1:2")), &manager());
        assert_eq!(response["error"], json!("Missing payload"));
        assert!(response.get("result").is_none());
    }

    #[test]
    fn unlock_refuses_when_no_key_is_named() {
        // No key id means the caller asked for nothing. It must not be handed a
        // grant for some default key it never mentioned.
        for payload in [
            json!({"scope": "session"}),
            json!({"scope": "session", "keyIds": []}),
            json!({"scope": "session", "keyIds": ["", "   "]}),
            json!({"scope": "session", "keyId": ""}),
            json!({"scope": "session", "keyIds": [42, true]}),
        ] {
            let message = json!({"action": "unlock-session", "payload": payload});
            let response = handle_unlock_session(&message, &peer(Some("tty:1:2")), &manager());
            assert_eq!(
                response["errorCode"],
                json!("NO_KEYS_REQUESTED"),
                "payload {message} should have been refused"
            );
            assert!(response.get("result").is_none());
        }
    }

    #[test]
    fn decrypt_v2_needs_at_least_one_ciphertext() {
        let message = json!({"action": "decrypt-v2", "payload": {"keyId": "k"}});
        let response = handle_decrypt_v2(&message, &peer(Some("tty:1:2")), &manager());
        assert_eq!(response["error"], json!("Missing ciphertext in payload"));
    }

    #[test]
    fn decrypt_v2_rejects_a_payload_that_is_not_base64() {
        let message = json!({
            "action": "decrypt-v2",
            "payload": {"keyId": "k", "ciphertexts": ["not base64 !!"]},
        });
        let response = handle_decrypt_v2(&message, &peer(Some("tty:1:2")), &manager());
        assert_eq!(response["error"], json!("Invalid base64 in ciphertext payload"));
    }

    #[test]
    fn decrypt_v2_accepts_the_single_ciphertext_form() {
        // Reaching NO_SESSION_GRANT means the single-ciphertext field was read;
        // an unparsed payload would have failed earlier with "Missing ciphertext".
        let message = json!({
            "action": "decrypt-v2",
            "payload": {"keyId": "k", "ciphertext": BASE64.encode([0u8; 100])},
        });
        let response = handle_decrypt_v2(&message, &peer(Some("tty:1:2")), &manager());
        assert_eq!(response["errorCode"], json!("NO_SESSION_GRANT"));
    }

    #[test]
    fn an_unknown_identity_is_reported_with_its_code() {
        let message = json!({
            "action": "unlock-session",
            "payload": {"identityId": "work", "keyIds": ["varlock-default"]},
        });
        let response = handle_unlock_session(&message, &peer(Some("tty:1:2")), &manager());
        assert_eq!(response["errorCode"], json!("IDENTITY_NOT_FOUND"));
    }

    #[test]
    fn list_sessions_answers_with_an_empty_list_rather_than_an_error() {
        let response = handle_list_sessions(&manager());
        assert_eq!(response["result"]["sessions"], json!([]));
    }

    #[test]
    fn invalidating_nothing_reports_zero() {
        let session_manager = Arc::new(Mutex::new(SessionManager::new()));
        let message = json!({"action": "invalidate-session"});
        let response = handle_invalidate(
            &message,
            &peer(Some("tty:1:2")),
            &session_manager,
            &manager(),
        );
        assert_eq!(response["result"]["invalidated"], json!(0));
    }

    #[test]
    fn ping_reports_the_protocol_version_and_the_derived_session() {
        let session_manager = Arc::new(Mutex::new(SessionManager::new()));
        let response = handle_ping(&peer(Some("tty:1:2")), &session_manager);
        assert_eq!(response["result"]["protocolVersion"], json!(3));
        assert_eq!(response["result"]["pong"], json!(true));
        assert_eq!(response["result"]["sessionId"], json!("tty:1:2"));
    }

    #[test]
    fn ping_reports_no_session_id_when_the_peer_could_not_be_scoped() {
        let session_manager = Arc::new(Mutex::new(SessionManager::new()));
        let response = handle_ping(&peer(None), &session_manager);
        assert_eq!(response["result"]["sessionId"], Value::Null);
        // and the legacy field still carries the claimed value, as it always has
        assert_eq!(
            response["result"]["ttyId"],
            json!("tty:a-session-the-caller-named")
        );
    }

    #[test]
    fn encrypting_to_an_identity_public_key_needs_no_stored_key() {
        let recipient = crypto::generate_key_pair().unwrap();
        let message = json!({
            "action": "encrypt",
            "payload": {
                "plaintext": "a value to capture",
                "identityPublicKey": recipient.public_key,
            },
        });
        let response = handle_encrypt(&message);
        let ciphertext = response["result"].as_str().expect("should encrypt");
        let payload = BASE64.decode(ciphertext).unwrap();
        assert_eq!(payload.first(), Some(&crypto::IDENTITY_PAYLOAD_VERSION));

        let secret = crypto::secret_key_from_pkcs8(
            &BASE64.decode(&recipient.private_key).unwrap(),
        )
        .unwrap();
        let plaintext =
            crypto::decrypt_payload(&secret, &payload, &[crypto::IDENTITY_PAYLOAD_VERSION])
                .unwrap();
        assert_eq!(String::from_utf8(plaintext).unwrap(), "a value to capture");
    }

    #[test]
    fn every_session_error_that_carries_a_code_reports_it() {
        let cases: Vec<(SessionError, &str)> = vec![
            (SessionError::NoSessionIdentity, "NO_SESSION_IDENTITY"),
            (SessionError::SessionKeyMissing, "SESSION_KEY_MISSING"),
            (SessionError::NotUtf8, "NOT_UTF8"),
            (SessionError::PresenceFailed("x".into()), "BIOMETRIC_FAILED"),
            (
                SessionError::Grant(SessionGrantError::Expired(SessionGrantRef::new("s", "k"))),
                "SESSION_GRANT_EXPIRED",
            ),
            (
                SessionError::Audit(AuditWriteError("disk full".into())),
                "AUDIT_WRITE_FAILED",
            ),
        ];
        for (error, expected) in cases {
            let response = session_error_response(&error);
            assert_eq!(response["errorCode"], json!(expected));
            assert!(response["error"].as_str().is_some_and(|m| !m.is_empty()));
        }

        // and a crypto failure carries a message with no code to branch on
        let response = session_error_response(&SessionError::Crypto("bad key".into()));
        assert!(response.get("errorCode").is_none());
        assert_eq!(response["error"], json!("bad key"));
    }

    #[test]
    fn an_unknown_action_is_named_in_the_error() {
        // The dispatch arm is a one-liner, so this pins the message shape the
        // clients match on rather than the routing.
        let action = "request-approval";
        let response = json!({"error": format!("Unknown action: {action}")});
        assert_eq!(response["error"], json!("Unknown action: request-approval"));
    }
}
