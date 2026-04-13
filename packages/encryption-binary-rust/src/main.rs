//! varlock-local-encrypt — Cross-platform local encryption binary for Varlock.
//!
//! Provides the same CLI interface as the Swift macOS binary:
//!   generate-key, delete-key, list-keys, key-exists, encrypt, decrypt, status, daemon
//!
//! All output is JSON. Errors return {"error": "message"}.

mod crypto;
mod daemon;
mod daemon_client;
mod ipc;
mod key_store;
mod secure_mem;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::json;

const DEFAULT_KEY_ID: &str = "varlock-default";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let command = args.get(1).map(|s| s.as_str()).unwrap_or("help");

    match command {
        "generate-key" => cmd_generate_key(&args),
        "delete-key" => cmd_delete_key(&args),
        "list-keys" => cmd_list_keys(),
        "key-exists" => cmd_key_exists(&args),
        "encrypt" => cmd_encrypt(&args),
        "decrypt" => cmd_decrypt(&args),
        "status" => cmd_status(),
        "setup" => cmd_setup(&args),
        "daemon" => cmd_daemon(&args),
        "start-daemon" => cmd_start_daemon(),
        "help" | "--help" | "-h" => cmd_help(),
        _ => json_error(&format!("Unknown command: {command}. Run with --help for usage.")),
    }
}

// ── CLI arg helpers ──────────────────────────────────────────────

fn get_arg(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

fn get_key_id(args: &[String]) -> String {
    get_arg(args, "--key-id").unwrap_or_else(|| DEFAULT_KEY_ID.to_string())
}

// ── JSON output helpers ─────────────────────────────────────────

fn json_output(value: &serde_json::Value) {
    println!("{}", serde_json::to_string(value).unwrap_or_default());
}

fn json_error(message: &str) -> ! {
    json_output(&json!({"error": message}));
    std::process::exit(1);
}

fn json_success(result: serde_json::Value) -> ! {
    let mut obj = json!({"ok": true});
    if let (Some(base), Some(extra)) = (obj.as_object_mut(), result.as_object()) {
        for (k, v) in extra {
            base.insert(k.clone(), v.clone());
        }
    }
    json_output(&obj);
    std::process::exit(0);
}

// ── Commands ────────────────────────────────────────────────────

fn cmd_generate_key(args: &[String]) {
    let key_id = get_key_id(args);

    match key_store::generate_key(&key_id) {
        Ok(public_key) => {
            let pub_bytes = BASE64.decode(&public_key).unwrap_or_default();
            json_success(json!({
                "keyId": key_id,
                "publicKey": public_key,
                "publicKeyBytes": pub_bytes.len(),
            }));
        }
        Err(e) => json_error(&e),
    }
}

fn cmd_delete_key(args: &[String]) {
    let key_id = get_key_id(args);
    let deleted = key_store::delete_key(&key_id);
    json_success(json!({
        "keyId": key_id,
        "deleted": deleted,
    }));
}

fn cmd_list_keys() {
    let keys = key_store::list_keys();
    json_success(json!({"keys": keys}));
}

fn cmd_key_exists(args: &[String]) {
    let key_id = get_key_id(args);
    let exists = key_store::key_exists(&key_id);
    json_success(json!({
        "keyId": key_id,
        "exists": exists,
    }));
}

fn cmd_encrypt(args: &[String]) {
    let key_id = get_key_id(args);

    let data_b64 = if args.contains(&"--data-stdin".to_string()) {
        let mut input = String::new();
        std::io::stdin().read_line(&mut input)
            .unwrap_or_else(|e| json_error(&format!("Failed to read stdin: {e}")));
        input.trim().to_string()
    } else {
        match get_arg(args, "--data") {
            Some(d) => d,
            None => json_error("Missing --data argument (base64-encoded plaintext)"),
        }
    };

    let plaintext = match BASE64.decode(&data_b64) {
        Ok(d) => d,
        Err(_) => json_error("Invalid base64 data"),
    };

    // Load just the public key (no private key access needed)
    let public_key = match key_store::load_public_key(&key_id) {
        Ok(pk) => pk,
        Err(e) => json_error(&e),
    };

    match crypto::encrypt(&public_key, &plaintext) {
        Ok(ciphertext) => json_success(json!({"ciphertext": ciphertext})),
        Err(e) => json_error(&e),
    }
}

fn cmd_decrypt(args: &[String]) {
    let key_id = get_key_id(args);

    // --data-stdin reads a JSON payload from stdin: {"data":"...","ttyId":"..."}
    // This prevents ciphertext and session identity from being visible in process listings.
    let (data_b64, stdin_tty_id) = if args.contains(&"--data-stdin".to_string()) {
        let mut input = String::new();
        std::io::stdin().read_line(&mut input)
            .unwrap_or_else(|e| json_error(&format!("Failed to read stdin: {e}")));
        let input = input.trim();
        // Try parsing as JSON (new format), fall back to plain string (backwards compat)
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(input) {
            let data = parsed.get("data").and_then(|v| v.as_str())
                .unwrap_or_else(|| json_error("Missing 'data' field in stdin JSON"))
                .to_string();
            let tty_id = parsed.get("ttyId").and_then(|v| v.as_str()).map(|s| s.to_string());
            (data, tty_id)
        } else {
            (input.to_string(), None)
        }
    } else {
        let data = match get_arg(args, "--data") {
            Some(d) => d,
            None => json_error("Missing --data or --data-stdin argument"),
        };
        (data, None)
    };

    // --via-daemon: route through the daemon for biometric + session caching.
    // Used by WSL2 where the TS side can't connect to Windows named pipes directly.
    if args.contains(&"--via-daemon".to_string()) {
        let tty_id = stdin_tty_id.as_deref();
        match daemon_client::decrypt_via_daemon(&data_b64, &key_id, tty_id) {
            Ok(plaintext) => json_success(json!({"plaintext": plaintext})),
            Err(e) => json_error(&e),
        }
    }

    // Direct decrypt (no biometric verification)
    // Private key is held in locked, zeroize-on-drop memory
    let (private_key_der, public_key_b64) = match key_store::load_key(&key_id) {
        Ok(k) => k,
        Err(e) => json_error(&e),
    };

    let secure_key = secure_mem::SecureBytes::new(private_key_der);
    let private_key_b64 = secure_mem::SecureString::new(BASE64.encode(secure_key.as_slice()));

    match crypto::decrypt(private_key_b64.as_str(), &public_key_b64, &data_b64) {
        Ok(plaintext_bytes) => {
            let plaintext = match String::from_utf8(plaintext_bytes) {
                Ok(s) => s,
                Err(_) => json_error("Decrypted data is not valid UTF-8"),
            };
            json_success(json!({"plaintext": plaintext}));
        }
        Err(e) => json_error(&e),
    }
}

fn cmd_status() {
    let info = key_store::get_platform_info();
    let keys = key_store::list_keys();

    #[allow(unused_mut)]
    let mut result = json!({
        "backend": info.backend,
        "hardwareBacked": info.hardware_backed,
        "biometricAvailable": info.biometric_available,
        "protection": info.protection.to_string(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "keys": keys,
    });

    // Include setup hints for optional features.
    // On Linux we only nag about TPM2 when the user isn't already getting
    // meaningful protection from the keyring — otherwise it's just noise.
    #[cfg(target_os = "linux")]
    {
        let using_keyring = matches!(
            info.protection,
            key_store::Protection::SecretService | key_store::Protection::SecretServiceTpm2
        );
        if !info.hardware_backed && !using_keyring {
            if let Some(hint) = key_store::get_tpm2_setup_hint() {
                result.as_object_mut().unwrap().insert(
                    "setupHint".to_string(),
                    serde_json::Value::String(hint),
                );
            }
        }
        if !info.biometric_available {
            if let Some(hint) = key_store::polkit::get_setup_hint() {
                result.as_object_mut().unwrap().insert(
                    "biometricSetupHint".to_string(),
                    serde_json::Value::String(hint),
                );
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if !info.biometric_available {
            if let Some(hint) = key_store::windows_hello::get_setup_hint() {
                result.as_object_mut().unwrap().insert(
                    "setupHint".to_string(),
                    serde_json::Value::String(hint),
                );
            }
        }
    }

    json_success(result);
}

fn cmd_setup(args: &[String]) {
    // Currently only --linux-biometrics (with optional --uninstall).
    // Structured as a generic `setup` verb so additional guided setup
    // operations can be added as new flags.
    #[cfg(target_os = "linux")]
    {
        if args.contains(&"--linux-biometrics".to_string()) {
            let uninstall = args.contains(&"--uninstall".to_string());
            let result = if uninstall {
                key_store::polkit::uninstall_policy()
            } else {
                key_store::polkit::install_policy()
            };
            match result {
                Ok(()) => json_success(json!({
                    "action": if uninstall { "uninstalled" } else { "installed" },
                    "policyPath": key_store::polkit::POLKIT_POLICY_PATH,
                })),
                Err(e) => json_error(&format!(
                    "{e}\nHint: re-run with sudo (e.g. `sudo varlock-local-encrypt setup --linux-biometrics`)"
                )),
            }
        } else {
            json_error("Missing setup flag. Try: --linux-biometrics [--uninstall]");
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = args;
        json_error("setup subcommand is only available on Linux");
    }
}

/// One-shot: spawn the daemon detached and exit.
/// Intended for users to run from a native Windows terminal to seed a daemon
/// that WSL2-side varlock invocations can talk to.
fn cmd_start_daemon() {
    #[cfg(target_os = "windows")]
    {
        match daemon_client::ensure_daemon_running() {
            Ok(()) => json_success(json!({"started": true})),
            Err(e) => json_error(&e),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        json_error("start-daemon is only supported on Windows");
    }
}

fn cmd_daemon(args: &[String]) {
    let socket_path = match get_arg(args, "--socket-path") {
        Some(sp) => sp,
        None => json_error("Missing --socket-path argument"),
    };

    let pid_path = get_arg(args, "--pid-path");

    if let Err(e) = daemon::run_daemon(&socket_path, pid_path.as_deref()) {
        json_error(&format!("Failed to start daemon: {e}"));
    }
}

fn cmd_help() {
    let help = r#"varlock-local-encrypt - Cross-platform local encryption for Varlock

COMMANDS:
  generate-key [--key-id <id>]    Create a new encryption key
  delete-key [--key-id <id>]      Delete an encryption key
  list-keys                       List all Varlock encryption keys
  key-exists [--key-id <id>]      Check if a key exists
  encrypt --data <base64> [--key-id <id>]   Encrypt data (one-shot)
  encrypt --data-stdin [--key-id <id>]     Encrypt (data from stdin)
  decrypt --data <base64> [--key-id <id>] [--via-daemon]         Decrypt data
  decrypt --data-stdin [--key-id <id>] [--via-daemon]           Decrypt (data from stdin)
  status                          Check platform capabilities
  start-daemon                    Spawn the daemon detached and exit
                                  (Windows-only; use from native Windows
                                  to seed a daemon for WSL2 callers)
  setup --linux-biometrics [--uninstall]
                                  Install/remove the polkit policy that
                                  enables fingerprint/face/password prompts
                                  on decrypt. Must be run with sudo.
  daemon --socket-path <path> [--pid-path <path>]   Start IPC daemon

OPTIONS:
  --key-id <id>       Key identifier (default: varlock-default)
  --data <base64>     Base64-encoded data
  --data-stdin        Read data from stdin as JSON: {"data":"...","ttyId":"..."}
  --socket-path <path>  Unix socket path for daemon mode
  --pid-path <path>   PID file path for daemon mode
  --via-daemon        Route decrypt through daemon for biometric + session caching

PLATFORM PROTECTION:
  Windows: DPAPI (user-session-scoped encryption)
  Linux:   Secret Service (GNOME Keyring / KWallet), layered with TPM2 when
           available; falls back to TPM2-only or plaintext if neither is present

All output is JSON. Errors return {"error": "message"}.
"#;
    print!("{help}");
    std::process::exit(0);
}
