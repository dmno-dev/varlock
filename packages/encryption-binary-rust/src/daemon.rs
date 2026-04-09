//! Daemon mode — long-lived process with IPC server, session management, and auto-shutdown.
//!
//! Matches the Swift daemon's behavior:
//!   - Accepts connections over Unix socket (Linux) or named pipe (Windows)
//!   - Handles: decrypt, encrypt, ping, invalidate-session
//!   - On Windows with Hello: requires biometric before first decrypt per session
//!   - No prompt-secret (no GUI on Linux — handled by terminal prompt in TS)
//!   - Auto-shutdown after 30 minutes of inactivity
//!   - Session invalidation on SIGTERM/SIGINT

use crate::crypto;
use crate::ipc::{IpcServer, MessageHandler};
use crate::key_store;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DEFAULT_KEY_ID: &str = "varlock-default";
const DAEMON_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(30 * 60); // 30 minutes
const SESSION_TIMEOUT: Duration = Duration::from_secs(5 * 60); // 5 minutes per session

/// Per-TTY session state.
struct SessionManager {
    /// Map of TTY IDs to their session creation time.
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

    fn is_session_warm(&self, tty_id: &Option<String>) -> bool {
        let key = tty_id.as_deref().unwrap_or("__no_tty__");
        match self.active_sessions.get(key) {
            Some(created_at) => created_at.elapsed() < SESSION_TIMEOUT,
            None => false,
        }
    }

    fn mark_session_warm(&mut self, tty_id: &Option<String>) {
        let key = tty_id.as_deref().unwrap_or("__no_tty__").to_string();
        self.active_sessions.insert(key, Instant::now());
    }

    fn invalidate_all(&mut self) {
        self.active_sessions.clear();
    }

    #[allow(dead_code)]
    fn has_any_sessions(&self) -> bool {
        self.active_sessions.values().any(|t| t.elapsed() < SESSION_TIMEOUT)
    }

    fn is_timed_out(&self) -> bool {
        self.last_activity.elapsed() > DAEMON_INACTIVITY_TIMEOUT
    }

    /// Whether the next decrypt should require biometric verification.
    fn needs_biometric(&self, tty_id: &Option<String>) -> bool {
        self.biometric_available && !self.is_session_warm(tty_id)
    }
}

/// Run the daemon.
pub fn run_daemon(socket_path: &str, pid_path: Option<&str>) -> Result<(), String> {
    // Write PID file
    if let Some(pid_path) = pid_path {
        if let Some(parent) = std::path::Path::new(pid_path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(pid_path, std::process::id().to_string())
            .map_err(|e| format!("Failed to write PID file: {e}"))?;
    }

    let session_manager = Arc::new(Mutex::new(SessionManager::new()));
    let mut server = IpcServer::new(socket_path);

    // Activity callback
    let sm_activity = session_manager.clone();
    server.set_activity_callback(move || {
        if let Ok(mut sm) = sm_activity.lock() {
            sm.note_activity();
        }
    });

    // Message handler
    let sm_handler = session_manager.clone();
    let handler: MessageHandler = Box::new(move |message: Value, tty_id: Option<String>| {
        let action = message
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match action {
            "decrypt" => handle_decrypt(&message, &tty_id, &sm_handler),
            "encrypt" => handle_encrypt(&message),
            "ping" => handle_ping(&tty_id, &sm_handler),
            "invalidate-session" => handle_invalidate(&sm_handler),
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

    // Inactivity timeout checker + session expiry cleanup
    let sm_timeout = session_manager.clone();
    let running_timeout = running.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(60));
            if !running_timeout.load(Ordering::SeqCst) {
                break;
            }
            if let Ok(mut sm) = sm_timeout.lock() {
                // Clean up expired sessions
                sm.active_sessions.retain(|_, created_at| {
                    created_at.elapsed() < SESSION_TIMEOUT
                });

                if sm.is_timed_out() {
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
    });
    println!("{}", ready);
    use std::io::Write;
    let _ = std::io::stdout().flush();

    // Start server (blocks)
    let result = server.start();

    // Cleanup
    if let Some(pp) = &pid_path_owned {
        let _ = std::fs::remove_file(pp);
    }

    result
}

// ── Message handlers ─────────────────────────────────────────────

fn handle_decrypt(
    message: &Value,
    tty_id: &Option<String>,
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
    let needs_bio = sm.lock().map(|s| s.needs_biometric(tty_id)).unwrap_or(false);

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
            let private_key_b64 = base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                secure_key.as_slice(),
            );

            let result = match crypto::decrypt(&private_key_b64, &public_key_b64, ciphertext_b64) {
                Ok(plaintext_bytes) => {
                    match String::from_utf8(plaintext_bytes) {
                        Ok(plaintext) => {
                            // Mark session as warm
                            if let Ok(mut session) = sm.lock() {
                                session.mark_session_warm(tty_id);
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

fn handle_ping(tty_id: &Option<String>, sm: &Arc<Mutex<SessionManager>>) -> Value {
    let session_warm = sm
        .lock()
        .map(|s| s.is_session_warm(tty_id))
        .unwrap_or(false);

    json!({
        "result": {
            "pong": true,
            "sessionWarm": session_warm,
            "ttyId": tty_id.as_deref().unwrap_or(""),
        }
    })
}

fn handle_invalidate(sm: &Arc<Mutex<SessionManager>>) -> Value {
    if let Ok(mut session) = sm.lock() {
        session.invalidate_all();
    }
    json!({"result": "all sessions invalidated"})
}

// ── Biometric verification ───────────────────────────────────────

/// Verify user presence using platform-specific biometric.
/// Returns Ok(true) if verified, Ok(false) if cancelled.
fn verify_user_presence() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        crate::key_store::windows_hello::verify_user("Varlock needs to decrypt your secrets")
    }

    #[cfg(not(target_os = "windows"))]
    {
        // No biometric on Linux — sessions are always warm
        Ok(true)
    }
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
