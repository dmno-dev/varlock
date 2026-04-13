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
/// `tty_id` is forwarded to the daemon for per-terminal session scoping.
#[cfg(target_os = "windows")]
pub fn decrypt_via_daemon(ciphertext: &str, key_id: &str, tty_id: Option<&str>) -> Result<String, String> {
    // Try connecting to existing daemon first
    match try_daemon_decrypt(ciphertext, key_id, tty_id) {
        Ok(result) => return Ok(result),
        Err(_) => {
            // Daemon not running, spawn one
        }
    }

    // When this .exe is invoked via WSL2 interop, we cannot spawn a working
    // daemon: the child inherits WSL's interop session and the resulting
    // UserConsentVerifier (Windows Hello) prompt never renders, hanging
    // forever. Detect that case via env vars inherited from the WSL parent
    // and return a clear error instead of attempting the doomed spawn.
    if is_invoked_from_wsl() {
        let exe_path = std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "<varlock-local-encrypt.exe>".to_string());
        return Err(format!(
            "Windows Hello daemon is not running, and it cannot be started from inside WSL2 \
             (no access to the interactive Windows desktop session).\n\n\
             To start the daemon, open a native Windows PowerShell and run:\n\n  \
             Start-Process -WindowStyle Hidden \"{exe_path}\" start-daemon\n\n\
             Then retry from WSL2. The daemon stays alive for 24h of inactivity, so this \
             is a one-time step per session."
        ));
    }

    spawn_daemon()?;

    // Retry after spawn
    try_daemon_decrypt(ciphertext, key_id, tty_id)
}

/// Detect whether this .exe was launched via WSL2 interop.
/// WSL forwards env vars like WSL_DISTRO_NAME and WSL_INTEROP into Windows
/// children it spawns through interop.
#[cfg(target_os = "windows")]
fn is_invoked_from_wsl() -> bool {
    std::env::var_os("WSL_DISTRO_NAME").is_some()
        || std::env::var_os("WSL_INTEROP").is_some()
}

/// Try to connect to the daemon and send a decrypt request.
#[cfg(target_os = "windows")]
fn try_daemon_decrypt(ciphertext: &str, key_id: &str, tty_id: Option<&str>) -> Result<String, String> {
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

    // Build request — include ttyId for per-terminal session scoping
    let mut request = json!({
        "id": "via-daemon-1",
        "action": "decrypt",
        "payload": {
            "ciphertext": ciphertext,
            "keyId": key_id,
        },
    });
    if let Some(tty) = tty_id {
        request.as_object_mut().unwrap().insert("ttyId".to_string(), json!(tty));
    }

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

/// Public entry point for the `start-daemon` subcommand.
/// Returns Ok if a daemon is already running OR if we successfully spawn one.
#[cfg(target_os = "windows")]
pub fn ensure_daemon_running() -> Result<(), String> {
    if pipe_exists() {
        return Ok(());
    }
    spawn_daemon()
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

    // Kill any stale/unresponsive daemon before spawning a new one.
    //
    // We only reach spawn_daemon() after try_daemon_decrypt() failed to talk
    // to the pipe, so any process referenced by the pid file is unresponsive
    // (e.g. a previous WSL2-context daemon hung inside the Hello prompt).
    // Before killing, verify the PID actually points to varlock-local-encrypt.exe
    // — Windows may have recycled the PID for an unrelated process.
    if let Ok(pid_str) = std::fs::read_to_string(&pid_path) {
        if let Ok(pid) = pid_str.trim().parse::<u32>() {
            if pid_is_our_daemon(pid) {
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/PID", &pid.to_string()])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .status();
            }
        }
        let _ = std::fs::remove_file(&pid_path);
    }

    // Spawn the daemon via `cmd.exe /c start` rather than CreateProcess directly.
    //
    // Why: when this .exe is launched by WSL2 interop, it runs in WSL's interop
    // session, which lacks the interactive window-station access that
    // UserConsentVerifier (Windows Hello) needs. A direct CreateProcess child
    // inherits that broken session and the Hello prompt hangs forever.
    // Routing through `cmd /c start` re-dispatches the launch through the shell,
    // which lands the child in the user's interactive desktop session.
    //
    // `start "" /B`: empty title (required positional), /B = no new console window.
    // CREATE_NO_WINDOW on the cmd.exe shim itself keeps it invisible.
    let exe_str = exe_path.to_string_lossy().to_string();
    let pid_str = pid_path.to_string_lossy().to_string();
    let _child = Command::new("cmd.exe")
        .args([
            "/c",
            "start",
            "",
            "/B",
            &exe_str,
            "daemon",
            "--socket-path",
            PIPE_NAME,
            "--pid-path",
            &pid_str,
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // CREATE_NO_WINDOW only — gives cmd.exe a hidden console that
        // `start /B` can inherit, keeping the daemon invisible.
        // Do NOT add DETACHED_PROCESS: with no console at all, `start /B`
        // falls back to allocating a visible console for the child.
        .creation_flags(0x08000000)
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

/// Verify the given PID is a running varlock-local-encrypt.exe process,
/// not an unrelated process that happened to inherit a recycled PID.
#[cfg(target_os = "windows")]
fn pid_is_our_daemon(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let process = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(h) => h,
        Err(_) => return false, // process gone, or no permission — don't kill
    };

    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    };
    unsafe { let _ = CloseHandle(process); }

    if ok.is_err() || len == 0 {
        return false;
    }

    let path = String::from_utf16_lossy(&buf[..len as usize]);
    let filename = path.rsplit('\\').next().unwrap_or("").to_lowercase();
    filename == "varlock-local-encrypt.exe"
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
pub fn decrypt_via_daemon(_ciphertext: &str, _key_id: &str, _tty_id: Option<&str>) -> Result<String, String> {
    Err("--via-daemon is only supported on Windows".into())
}
