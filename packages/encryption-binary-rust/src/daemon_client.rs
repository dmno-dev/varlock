//! Daemon client for one-shot commands that need biometric verification.
//!
//! When called with `--via-daemon`, the decrypt command uses this client to
//! route the request through a running daemon process (which handles biometric
//! session caching). If no daemon is running, one is auto-spawned.
//!
//! This is used by WSL2 where the TS side can't connect to Windows named pipes
//! directly — instead it calls the .exe one-shot and the .exe talks to its own
//! daemon via named pipe.

#[cfg(target_os = "windows")]
use serde_json::{json, Value};

#[cfg(target_os = "windows")]
const PIPE_NAME: &str = r"\\.\pipe\varlock-local-encrypt";

#[cfg(target_os = "windows")]
const MAX_SPAWN_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// Send a decrypt request through the daemon, auto-spawning if needed.
/// Returns the decrypted plaintext.
#[cfg(target_os = "windows")]
pub fn decrypt_via_daemon(ciphertext: &str, key_id: &str) -> Result<String, String> {
    // Try connecting to existing daemon first
    match try_daemon_decrypt(ciphertext, key_id) {
        Ok(result) => return Ok(result),
        Err(_) => {
            // Daemon not running, spawn one
        }
    }

    spawn_daemon()?;

    // Retry after spawn
    try_daemon_decrypt(ciphertext, key_id)
}

/// Try to connect to the daemon and send a decrypt request.
#[cfg(target_os = "windows")]
fn try_daemon_decrypt(ciphertext: &str, key_id: &str) -> Result<String, String> {
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FlushFileBuffers,
        FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_NONE,
        OPEN_EXISTING,
    };
    use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows::core::HSTRING;

    let pipe_name = HSTRING::from(PIPE_NAME);

    let pipe = unsafe {
        CreateFileW(
            &pipe_name,
            (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
            FILE_SHARE_NONE,
            None,
            OPEN_EXISTING,
            windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    }.map_err(|e| format!("Failed to connect to daemon pipe: {e}"))?;

    if pipe == INVALID_HANDLE_VALUE {
        return Err("Failed to open daemon pipe".into());
    }

    // Build request
    let request = json!({
        "id": "via-daemon-1",
        "action": "decrypt",
        "payload": {
            "ciphertext": ciphertext,
            "keyId": key_id,
        },
    });

    let request_bytes = serde_json::to_vec(&request)
        .map_err(|e| format!("Serialization failed: {e}"))?;

    // Write length-prefixed request
    let len_bytes = (request_bytes.len() as u32).to_le_bytes();
    let mut written = 0u32;

    unsafe {
        WriteFile(pipe, Some(&len_bytes), Some(&mut written), None)
            .map_err(|e| format!("Write failed: {e}"))?;
        WriteFile(pipe, Some(&request_bytes), Some(&mut written), None)
            .map_err(|e| format!("Write failed: {e}"))?;
        let _ = FlushFileBuffers(pipe);
    }

    // Read length-prefixed response
    let mut resp_len_buf = [0u8; 4];
    let mut bytes_read = 0u32;
    unsafe {
        ReadFile(pipe, Some(&mut resp_len_buf), Some(&mut bytes_read), None)
            .map_err(|e| format!("Read response length failed: {e}"))?;
    }
    if bytes_read != 4 {
        unsafe { let _ = CloseHandle(pipe); }
        return Err("Incomplete response length".into());
    }

    let resp_len = u32::from_le_bytes(resp_len_buf) as usize;
    if resp_len == 0 || resp_len > 10_000_000 {
        unsafe { let _ = CloseHandle(pipe); }
        return Err(format!("Invalid response length: {resp_len}"));
    }

    let mut resp_buf = vec![0u8; resp_len];
    let mut total_read = 0usize;
    while total_read < resp_len {
        let mut chunk_read = 0u32;
        unsafe {
            ReadFile(
                pipe,
                Some(&mut resp_buf[total_read..]),
                Some(&mut chunk_read),
                None,
            ).map_err(|e| format!("Read response body failed: {e}"))?;
        }
        if chunk_read == 0 {
            break;
        }
        total_read += chunk_read as usize;
    }

    unsafe { let _ = CloseHandle(pipe); }

    // Parse response
    let response: Value = serde_json::from_slice(&resp_buf[..total_read])
        .map_err(|e| format!("Invalid response JSON: {e}"))?;

    if let Some(error) = response.get("error").and_then(|v| v.as_str()) {
        return Err(error.to_string());
    }

    response
        .get("result")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Unexpected daemon response format".to_string())
}

/// Spawn a daemon process and wait for it to be ready.
#[cfg(target_os = "windows")]
fn spawn_daemon() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Failed to get current exe path: {e}"))?;

    // Derive PID path from config dir
    let config_dir = crate::key_store::get_config_dir();
    let pid_path = config_dir.join("local-encrypt").join("daemon.pid");

    // Ensure directory exists
    if let Some(parent) = pid_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Spawn self in daemon mode, detached
    let _child = Command::new(&exe_path)
        .args([
            "daemon",
            "--socket-path",
            PIPE_NAME,
            "--pid-path",
            &pid_path.to_string_lossy(),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // CREATE_NEW_PROCESS_GROUP detaches the child on Windows
        .creation_flags(0x00000200) // CREATE_NEW_PROCESS_GROUP
        .spawn()
        .map_err(|e| format!("Failed to spawn daemon: {e}"))?;

    // Wait for daemon to become ready (poll pipe availability)
    let start = std::time::Instant::now();
    while start.elapsed() < MAX_SPAWN_WAIT {
        std::thread::sleep(std::time::Duration::from_millis(50));
        if pipe_exists() {
            return Ok(());
        }
    }

    Err("Daemon failed to start within timeout".into())
}

/// Check if the daemon's named pipe exists (daemon is listening).
#[cfg(target_os = "windows")]
fn pipe_exists() -> bool {
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
        FILE_SHARE_NONE, OPEN_EXISTING,
    };
    use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows::core::HSTRING;

    let pipe_name = HSTRING::from(PIPE_NAME);
    let result = unsafe {
        CreateFileW(
            &pipe_name,
            (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
            FILE_SHARE_NONE,
            None,
            OPEN_EXISTING,
            windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    };

    match result {
        Ok(handle) => {
            if handle != INVALID_HANDLE_VALUE {
                unsafe { let _ = CloseHandle(handle); }
                true
            } else {
                false
            }
        }
        Err(_) => false,
    }
}

// ── Stub for non-Windows platforms ──────────────────────────────

#[cfg(not(target_os = "windows"))]
pub fn decrypt_via_daemon(_ciphertext: &str, _key_id: &str) -> Result<String, String> {
    Err("--via-daemon is only supported on Windows".into())
}
