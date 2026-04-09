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
        "daemon" => cmd_daemon(&args),
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

    let data_b64 = match get_arg(args, "--data") {
        Some(d) => d,
        None => json_error("Missing --data argument (base64-encoded plaintext)"),
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

    let data_b64 = match get_arg(args, "--data") {
        Some(d) => d,
        None => json_error("Missing --data argument (base64-encoded ciphertext)"),
    };

    // --via-daemon: route through the daemon for biometric + session caching.
    // Used by WSL2 where the TS side can't connect to Windows named pipes directly.
    if args.contains(&"--via-daemon".to_string()) {
        match daemon_client::decrypt_via_daemon(&data_b64, &key_id) {
            Ok(plaintext) => json_success(json!({"plaintext": plaintext})),
            Err(e) => json_error(&e),
        }
    }

    // Direct decrypt (no biometric verification)
    let (private_key_der, public_key_b64) = match key_store::load_key(&key_id) {
        Ok(k) => k,
        Err(e) => json_error(&e),
    };

    let private_key_b64 = BASE64.encode(&private_key_der);

    match crypto::decrypt(&private_key_b64, &public_key_b64, &data_b64) {
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

    // Include setup hints for optional features
    #[cfg(target_os = "linux")]
    {
        if !info.hardware_backed {
            if let Some(hint) = key_store::get_tpm2_setup_hint() {
                result.as_object_mut().unwrap().insert(
                    "setupHint".to_string(),
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
  decrypt --data <base64> [--key-id <id>] [--via-daemon]   Decrypt data
  status                          Check platform capabilities
  daemon --socket-path <path> [--pid-path <path>]   Start IPC daemon

OPTIONS:
  --key-id <id>       Key identifier (default: varlock-default)
  --data <base64>     Base64-encoded data
  --socket-path <path>  Unix socket path for daemon mode
  --pid-path <path>   PID file path for daemon mode
  --via-daemon        Route decrypt through daemon for biometric + session caching

PLATFORM PROTECTION:
  Windows: DPAPI (user-session-scoped encryption)
  Linux:   Kernel keyring (key held in kernel memory)

All output is JSON. Errors return {"error": "message"}.
"#;
    print!("{help}");
    std::process::exit(0);
}
