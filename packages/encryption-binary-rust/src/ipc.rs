//! IPC server for the daemon mode.
//!
//! Protocol: Length-prefixed JSON over Unix domain socket (Linux) or named pipe (Windows).
//!
//!   [4 bytes: UInt32 LE message length]
//!   [N bytes: UTF-8 JSON]
//!
//! Request:  { "id": "...", "action": "...", "payload": { ... } }
//! Response: { "id": "...", "result": ... } or { "id": "...", "error": "..." }

use serde_json::Value;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};

const MAX_MESSAGE_SIZE: u32 = 10_000_000; // 10MB safety limit



/// Message handler callback type.
pub type MessageHandler = Box<dyn Fn(Value, Option<String>) -> Value + Send + Sync>;

/// IPC server that listens for length-prefixed JSON messages.
pub struct IpcServer {
    socket_path: String,
    running: Arc<AtomicBool>,
    message_handler: Option<Arc<MessageHandler>>,
    on_activity: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl IpcServer {
    pub fn new(socket_path: &str) -> Self {
        Self {
            socket_path: socket_path.to_string(),
            running: Arc::new(AtomicBool::new(false)),
            message_handler: None,
            on_activity: None,
        }
    }

    pub fn set_message_handler(&mut self, handler: MessageHandler) {
        self.message_handler = Some(Arc::new(handler));
    }

    pub fn set_activity_callback(&mut self, callback: impl Fn() + Send + Sync + 'static) {
        self.on_activity = Some(Arc::new(callback));
    }

    pub fn running_flag(&self) -> Arc<AtomicBool> {
        self.running.clone()
    }

    /// Start the IPC server. This blocks the calling thread.
    #[cfg(unix)]
    pub fn start(&self) -> Result<(), String> {
        // Ensure parent directory exists with restricted permissions
        if let Some(parent) = std::path::Path::new(&self.socket_path).parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create socket directory: {e}"))?;
            // Restrict directory to owner only (0700) — prevents other users
            // from listing socket files or key filenames
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                parent,
                std::fs::Permissions::from_mode(0o700),
            );
        }

        // Acquire exclusive lock before touching the socket file.
        // Prevents a TOCTOU race where a malicious process could create a fake
        // socket between our unlink() and bind(), intercepting client connections.
        let lock_path = format!("{}.lock", self.socket_path);
        let lock_fd = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .mode(0o600)
                .open(&lock_path)
                .map_err(|e| format!("Failed to create lock file: {e}"))?
        };
        use std::os::unix::io::AsRawFd;
        let lock_result = unsafe { libc::flock(lock_fd.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if lock_result != 0 {
            return Err("Another daemon instance holds the lock".into());
        }

        // Safe to remove stale socket now — we hold the lock
        let _ = std::fs::remove_file(&self.socket_path);

        let listener = UnixListener::bind(&self.socket_path)
            .map_err(|e| format!("Socket bind failed: {e}"))?;

        // Set socket permissions (owner only)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                &self.socket_path,
                std::fs::Permissions::from_mode(0o600),
            );
        }

        // Set non-blocking so we can check the running flag
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to set non-blocking: {e}"))?;

        self.running.store(true, Ordering::SeqCst);

        while self.running.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    if let Some(cb) = &self.on_activity {
                        cb();
                    }

                    let handler = self.message_handler.clone();
                    let on_activity = self.on_activity.clone();
                    let running = self.running.clone();

                    // Verify the connecting process is a trusted varlock binary
                    if !verify_unix_client(&stream) {
                        eprintln!("Rejected connection from untrusted process");
                        continue;
                    }

                    // Get peer session identity
                    let tty_id = get_peer_session_id(&stream);

                    std::thread::spawn(move || {
                        handle_client(stream, handler, on_activity, running, tty_id);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // No pending connection — sleep briefly and retry
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(e) => {
                    if self.running.load(Ordering::SeqCst) {
                        eprintln!("Accept error: {e}");
                    }
                    break;
                }
            }
        }

        // Cleanup socket and lock
        let _ = std::fs::remove_file(&self.socket_path);
        let _ = std::fs::remove_file(format!("{}.lock", self.socket_path));
        Ok(())
    }

    /// Start the IPC server on Windows using named pipes.
    ///
    /// Named pipes work with Node.js `net.connect()` out of the box —
    /// the TS daemon client's `socket.connect(pipePath)` just works.
    #[cfg(windows)]
    pub fn start(&self) -> Result<(), String> {
        use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows::Win32::System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe,
            PIPE_TYPE_BYTE, PIPE_READMODE_BYTE, PIPE_WAIT,
        };
        use windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
        use windows::core::HSTRING;

        self.running.store(true, Ordering::SeqCst);

        let pipe_name = HSTRING::from(&self.socket_path);

        // Build a security descriptor that restricts pipe access to the current user only.
        // This prevents other users/processes from connecting to the daemon pipe.
        let sa = create_current_user_security_attributes()
            .map_err(|e| format!("Failed to create pipe security attributes: {e}"))?;

        while self.running.load(Ordering::SeqCst) {
            // Create a new named pipe instance for each client
            let pipe_handle = unsafe {
                CreateNamedPipeW(
                    &pipe_name,
                    PIPE_ACCESS_DUPLEX,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                    10,          // max instances
                    65536,       // out buffer
                    65536,       // in buffer
                    0,           // default timeout
                    Some(&sa),   // restrict to current user
                )
            };

            if pipe_handle == INVALID_HANDLE_VALUE {
                if !self.running.load(Ordering::SeqCst) {
                    break;
                }
                return Err("CreateNamedPipe failed".into());
            }

            // Wait for a client to connect (blocking)
            let connected = unsafe { ConnectNamedPipe(pipe_handle, None) };
            if connected.is_err() {
                // ERROR_PIPE_CONNECTED means client connected between Create and Connect — OK
                // Any other error: close and retry
                let last_err = unsafe { windows::Win32::Foundation::GetLastError() };
                if last_err != windows::Win32::Foundation::ERROR_PIPE_CONNECTED {
                    unsafe { let _ = CloseHandle(pipe_handle); }
                    if !self.running.load(Ordering::SeqCst) {
                        break;
                    }
                    continue;
                }
            }

            if let Some(cb) = &self.on_activity {
                cb();
            }

            let handler = self.message_handler.clone();
            let on_activity = self.on_activity.clone();
            let running = self.running.clone();
            let tty_id: Option<String> = None;

            // HANDLE is !Send, but it's safe to use from another thread
            // since we transfer exclusive ownership. Pass as raw pointer.
            let raw_handle = pipe_handle.0 as usize; // usize is Send
            std::thread::spawn(move || {
                use windows::Win32::Foundation::HANDLE;
                let pipe = HANDLE(raw_handle as *mut _);

                // Verify the connecting process is a trusted varlock binary
                if !verify_client_process(pipe) {
                    eprintln!("Rejected connection from untrusted process");
                    unsafe {
                        let _ = DisconnectNamedPipe(pipe);
                        let _ = CloseHandle(pipe);
                    }
                    return;
                }

                handle_windows_client(pipe, handler, on_activity, running, tty_id);
                unsafe {
                    let _ = DisconnectNamedPipe(pipe);
                    let _ = CloseHandle(pipe);
                }
            });
        }

        Ok(())
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

impl Drop for IpcServer {
    fn drop(&mut self) {
        self.stop();
        let _ = std::fs::remove_file(&self.socket_path);
        let _ = std::fs::remove_file(format!("{}.lock", self.socket_path));
    }
}

// ── Client handling ──────────────────────────────────────────────

#[cfg(unix)]
fn handle_client(
    mut stream: UnixStream,
    handler: Option<Arc<MessageHandler>>,
    on_activity: Option<Arc<dyn Fn() + Send + Sync>>,
    running: Arc<AtomicBool>,
    tty_id: Option<String>,
) {
    // Set blocking for reads
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(300)));

    while running.load(Ordering::SeqCst) {
        // Read 4-byte length prefix (little-endian)
        let mut len_buf = [0u8; 4];
        match stream.read_exact(&mut len_buf) {
            Ok(()) => {}
            Err(_) => break, // Connection closed or error
        }

        let msg_len = u32::from_le_bytes(len_buf);
        if msg_len == 0 || msg_len > MAX_MESSAGE_SIZE {
            break;
        }

        // Read message body
        let mut msg_buf = vec![0u8; msg_len as usize];
        match stream.read_exact(&mut msg_buf) {
            Ok(()) => {}
            Err(_) => break,
        }

        // Parse JSON
        let message: Value = match serde_json::from_slice(&msg_buf) {
            Ok(v) => v,
            Err(_) => {
                let _ = send_response(&mut stream, None, &serde_json::json!({"error": "Invalid JSON"}));
                continue;
            }
        };

        if let Some(cb) = &on_activity {
            cb();
        }

        // Handle message
        let id = message.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());

        let response = if let Some(ref handler) = handler {
            handler(message, tty_id.clone())
        } else {
            serde_json::json!({"error": "No handler"})
        };

        if send_response(&mut stream, id.as_deref(), &response).is_err() {
            break;
        }
    }
}

fn send_response(stream: &mut impl Write, id: Option<&str>, response: &Value) -> Result<(), String> {
    let mut full_response = response.clone();
    if let (Some(id), Some(obj)) = (id, full_response.as_object_mut()) {
        obj.insert("id".to_string(), Value::String(id.to_string()));
    }

    let json_bytes = serde_json::to_vec(&full_response)
        .map_err(|e| format!("Serialization failed: {e}"))?;

    let len = (json_bytes.len() as u32).to_le_bytes();
    stream.write_all(&len).map_err(|e| format!("Write failed: {e}"))?;
    stream.write_all(&json_bytes).map_err(|e| format!("Write failed: {e}"))?;
    stream.flush().map_err(|e| format!("Flush failed: {e}"))?;

    Ok(())
}

// ── Unix client process verification ─────────────────────────────

/// Verify that the connecting client process is a trusted varlock binary.
/// Uses peer credentials to get the client PID, then reads /proc/<pid>/exe.
#[cfg(target_os = "linux")]
fn verify_unix_client(stream: &UnixStream) -> bool {
    use nix::sys::socket::{getsockopt, sockopt::PeerCredentials};
    use std::os::fd::AsFd;

    let creds = match getsockopt(&stream.as_fd(), PeerCredentials) {
        Ok(c) => c,
        Err(_) => return false,
    };

    let pid = creds.pid();
    if pid <= 0 {
        return false;
    }

    // Read the executable path via /proc/<pid>/exe symlink
    let exe_path = match std::fs::read_link(format!("/proc/{pid}/exe")) {
        Ok(p) => p,
        Err(_) => return false,
    };

    let exe_name = exe_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");

    let allowed = [
        "varlock-local-encrypt",
        "varlock",
        "node",
        "bun",
    ];

    let is_trusted = allowed.iter().any(|name| exe_name == *name);
    if !is_trusted {
        eprintln!(
            "Untrusted client process: PID={pid}, exe={}",
            exe_path.display()
        );
    }
    is_trusted
}

/// macOS: no /proc filesystem, skip process verification for now.
/// The Unix socket 0600 permissions still restrict to the owning user.
#[cfg(all(unix, not(target_os = "linux")))]
fn verify_unix_client(_stream: &UnixStream) -> bool {
    true
}

// ── Peer session identity (Linux) ───────────────────────────────

#[cfg(target_os = "linux")]
fn get_peer_session_id(stream: &UnixStream) -> Option<String> {
    use nix::sys::socket::{getsockopt, sockopt::PeerCredentials};
    use std::os::fd::AsFd;

    let creds = getsockopt(&stream.as_fd(), PeerCredentials).ok()?;
    let pid = creds.pid();

    if pid <= 0 {
        return None;
    }

    // Prefer TTY-based identity, fall back to process tree
    get_tty_session_id(pid as u32)
        .or_else(|| get_ptree_session_id(pid as u32))
}

/// TTY-based session identity: tty device + session leader start time.
#[cfg(target_os = "linux")]
fn get_tty_session_id(pid: u32) -> Option<String> {
    let fields = parse_proc_stat(pid)?;

    // After the closing paren: state(0) ppid(1) pgrp(2) session(3) tty_nr(4)
    let tty_nr: u32 = fields.get(4)?.parse().ok()?;
    if tty_nr == 0 {
        return None; // No controlling tty
    }

    // Get the session leader PID (field 3 after comm)
    let session_pid: u32 = fields.get(3)?.parse().ok()?;

    // Get session leader start time for uniqueness
    let start_time = get_process_start_time(session_pid).unwrap_or(0);

    // Convert tty_nr to a name (major:minor)
    let major = (tty_nr >> 8) & 0xff;
    let minor = (tty_nr & 0xff) | ((tty_nr >> 12) & 0xfff00);
    let tty_name = format!("tty{major}:{minor}");

    Some(format!("tty:{tty_name}:{start_time}"))
}

/// Process-tree-based session identity for non-TTY processes.
/// Mirrors the macOS Swift daemon logic: walks the ancestry chain up to PID 1,
/// then uses the grandchild of the root as a stable scope key.
#[cfg(target_os = "linux")]
fn get_ptree_session_id(pid: u32) -> Option<String> {
    let mut chain: Vec<u32> = vec![pid];
    let mut current = pid;

    for _ in 0..64 {
        let ppid = get_parent_pid(current)?;
        if ppid <= 1 {
            break;
        }
        chain.push(ppid);
        current = ppid;
    }

    // Need at least 4 levels for a meaningful intermediate ancestor
    if chain.len() < 4 {
        return None;
    }

    let scope_pid = chain[chain.len() - 3];
    let start_time = get_process_start_time(scope_pid).unwrap_or(0);
    Some(format!("ptree:{scope_pid}:{start_time}"))
}

/// Parse /proc/<pid>/stat and return the fields after the comm closing paren.
#[cfg(target_os = "linux")]
fn parse_proc_stat(pid: u32) -> Option<Vec<String>> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_comm = stat.rfind(')')? + 2;
    Some(stat[after_comm..].split_whitespace().map(|s| s.to_string()).collect())
}

/// Get the PPID for a given process from /proc.
#[cfg(target_os = "linux")]
fn get_parent_pid(pid: u32) -> Option<u32> {
    let fields = parse_proc_stat(pid)?;
    // After comm: state(0) ppid(1)
    fields.get(1)?.parse().ok()
}

#[cfg(target_os = "linux")]
fn get_process_start_time(pid: u32) -> Option<u64> {
    let fields = parse_proc_stat(pid)?;
    // Field 19 after comm is starttime (in clock ticks since boot)
    fields.get(19)?.parse().ok()
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn get_peer_session_id(_stream: &UnixStream) -> Option<String> {
    None
}

// ── Windows pipe security ───────────────────────────────────────

/// Create a SECURITY_ATTRIBUTES that restricts access to the current user only.
/// This prevents other users from connecting to the daemon's named pipe.
#[cfg(windows)]
fn create_current_user_security_attributes() -> Result<windows::Win32::Security::SECURITY_ATTRIBUTES, String> {
    use windows::Win32::Security::{
        SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, PSECURITY_DESCRIPTOR,
        InitializeSecurityDescriptor, SetSecurityDescriptorDacl,
    };
    use windows::Win32::Security::Authorization::{
        SetEntriesInAclW, EXPLICIT_ACCESS_W, SET_ACCESS,
        TRUSTEE_W, TRUSTEE_IS_SID, TRUSTEE_TYPE,
        MULTIPLE_TRUSTEE_OPERATION,
    };
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, TOKEN_USER, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows::Win32::Foundation::GENERIC_ALL;

    unsafe {
        // Get current process token
        let mut token = windows::Win32::Foundation::HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| format!("OpenProcessToken failed: {e}"))?;

        // Get token user (contains the SID)
        let mut token_info_len = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut token_info_len);
        let mut token_info = vec![0u8; token_info_len as usize];
        GetTokenInformation(
            token,
            TokenUser,
            Some(token_info.as_mut_ptr() as *mut _),
            token_info_len,
            &mut token_info_len,
        ).map_err(|e| format!("GetTokenInformation failed: {e}"))?;

        let token_user = &*(token_info.as_ptr() as *const TOKEN_USER);
        let user_sid = token_user.User.Sid;

        // Build an ACL with a single entry: GENERIC_ALL for the current user
        let mut ea = EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL.0,
            grfAccessMode: SET_ACCESS,
            grfInheritance: windows::Win32::Security::ACE_FLAGS(0), // NO_INHERITANCE
            Trustee: TRUSTEE_W {
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_TYPE(0), // TRUSTEE_IS_UNKNOWN
                ptstrName: windows::core::PWSTR(user_sid.0 as *mut u16),
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: MULTIPLE_TRUSTEE_OPERATION(0),
            },
        };

        let mut acl = std::ptr::null_mut();
        let err = SetEntriesInAclW(Some(&[ea]), None, &mut acl);
        if err.0 != 0 {
            return Err(format!("SetEntriesInAclW failed: error {}", err.0));
        }

        // Create a security descriptor with this DACL
        let sd_layout = std::alloc::Layout::new::<SECURITY_DESCRIPTOR>();
        let sd_ptr = std::alloc::alloc_zeroed(sd_layout) as *mut SECURITY_DESCRIPTOR;
        if sd_ptr.is_null() {
            return Err("Failed to allocate security descriptor".into());
        }

        InitializeSecurityDescriptor(
            PSECURITY_DESCRIPTOR(sd_ptr as *mut _),
            1, // SECURITY_DESCRIPTOR_REVISION
        ).map_err(|e| format!("InitializeSecurityDescriptor failed: {e}"))?;

        SetSecurityDescriptorDacl(
            PSECURITY_DESCRIPTOR(sd_ptr as *mut _),
            true,
            Some(acl as *const _),
            false,
        ).map_err(|e| format!("SetSecurityDescriptorDacl failed: {e}"))?;

        // Note: sd_ptr and acl are intentionally leaked — they must live for the
        // lifetime of the pipe server. The OS frees them on process exit.

        Ok(SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd_ptr as *mut _,
            bInheritHandle: false.into(),
        })
    }
}

// ── Windows client process verification ─────────────────────────

/// Verify that the connecting client process is a trusted varlock binary.
/// Uses GetNamedPipeClientProcessId to get the client PID, then checks
/// that the process executable matches our own binary name.
#[cfg(windows)]
fn verify_client_process(pipe: windows::Win32::Foundation::HANDLE) -> bool {
    use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_NAME_WIN32,
    };
    use windows::Win32::Foundation::CloseHandle;

    // Get the client's PID
    let mut client_pid = 0u32;
    let ok = unsafe { GetNamedPipeClientProcessId(pipe, &mut client_pid) };
    if ok.is_err() || client_pid == 0 {
        return false;
    }

    // Open the client process to query its image name
    let process = unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, client_pid)
    };
    let process = match process {
        Ok(h) => h,
        Err(_) => return false,
    };

    // Query the full executable path
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = unsafe {
        QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len)
    };
    unsafe { let _ = CloseHandle(process); }

    if ok.is_err() || len == 0 {
        return false;
    }

    let client_path = String::from_utf16_lossy(&buf[..len as usize]);

    // Extract the filename from the full path
    let client_filename = client_path
        .rsplit('\\')
        .next()
        .unwrap_or("")
        .to_lowercase();

    // Allow connections from varlock binaries and Node.js (for native Windows daemon client)
    let allowed = [
        "varlock-local-encrypt.exe",
        "varlock.exe",
        "node.exe",   // Node.js daemon client on native Windows
        "bun.exe",    // Bun runtime on native Windows
    ];

    let is_trusted = allowed.iter().any(|name| client_filename == *name);
    if !is_trusted {
        eprintln!(
            "Untrusted client process: PID={client_pid}, path={client_path}"
        );
    }
    is_trusted
}

// ── Windows named pipe client handling ───────────────────────────

#[cfg(windows)]
fn handle_windows_client(
    pipe: windows::Win32::Foundation::HANDLE,
    handler: Option<Arc<MessageHandler>>,
    on_activity: Option<Arc<dyn Fn() + Send + Sync>>,
    running: Arc<AtomicBool>,
    tty_id: Option<String>,
) {
    use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile, FlushFileBuffers};

    while running.load(Ordering::SeqCst) {
        // Read 4-byte length prefix
        let mut len_buf = [0u8; 4];
        let mut bytes_read = 0u32;
        let ok = unsafe {
            ReadFile(pipe, Some(&mut len_buf), Some(&mut bytes_read), None)
        };
        if ok.is_err() || bytes_read != 4 {
            break;
        }

        let msg_len = u32::from_le_bytes(len_buf);
        if msg_len == 0 || msg_len > MAX_MESSAGE_SIZE {
            break;
        }

        // Read message body
        let mut msg_buf = vec![0u8; msg_len as usize];
        let mut total_read = 0u32;
        while (total_read as usize) < msg_buf.len() {
            let mut chunk_read = 0u32;
            let ok = unsafe {
                ReadFile(
                    pipe,
                    Some(&mut msg_buf[total_read as usize..]),
                    Some(&mut chunk_read),
                    None,
                )
            };
            if ok.is_err() || chunk_read == 0 {
                return;
            }
            total_read += chunk_read;
        }

        // Parse JSON
        let message: Value = match serde_json::from_slice(&msg_buf) {
            Ok(v) => v,
            Err(_) => {
                let _ = send_windows_response(pipe, None, &serde_json::json!({"error": "Invalid JSON"}));
                continue;
            }
        };

        if let Some(cb) = &on_activity {
            cb();
        }

        let id = message.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());

        // On Windows, use client-reported ttyId from the message (set by --via-daemon callers)
        let effective_tty_id = tty_id.clone().or_else(|| {
            message.get("ttyId").and_then(|v| v.as_str()).map(|s| s.to_string())
        });

        let response = if let Some(ref handler) = handler {
            handler(message, effective_tty_id)
        } else {
            serde_json::json!({"error": "No handler"})
        };

        if send_windows_response(pipe, id.as_deref(), &response).is_err() {
            break;
        }
    }
}

#[cfg(windows)]
fn send_windows_response(
    pipe: windows::Win32::Foundation::HANDLE,
    id: Option<&str>,
    response: &Value,
) -> Result<(), String> {
    use windows::Win32::Storage::FileSystem::{WriteFile, FlushFileBuffers};

    let mut full_response = response.clone();
    if let (Some(id), Some(obj)) = (id, full_response.as_object_mut()) {
        obj.insert("id".to_string(), Value::String(id.to_string()));
    }

    let json_bytes = serde_json::to_vec(&full_response)
        .map_err(|e| format!("Serialization failed: {e}"))?;

    let len = (json_bytes.len() as u32).to_le_bytes();

    let mut written = 0u32;
    unsafe {
        WriteFile(pipe, Some(&len), Some(&mut written), None)
            .map_err(|e| format!("Write failed: {e}"))?;
        WriteFile(pipe, Some(&json_bytes), Some(&mut written), None)
            .map_err(|e| format!("Write failed: {e}"))?;
        let _ = FlushFileBuffers(pipe);
    }

    Ok(())
}

// ── Tests ───────────────────────────────────────────────────────

#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests {
    use super::*;

    #[test]
    fn test_parse_proc_stat_self() {
        let fields = parse_proc_stat(std::process::id()).expect("should parse own /proc/stat");
        // Should have at least 20 fields (we read up to field 19 for starttime)
        assert!(fields.len() >= 20, "expected >=20 fields, got {}", fields.len());
        // Field 0 is state (single char like R, S, etc.)
        assert_eq!(fields[0].len(), 1);
        // Field 1 is ppid (should be > 0)
        let ppid: u32 = fields[1].parse().expect("ppid should be a number");
        assert!(ppid > 0);
    }

    #[test]
    fn test_get_parent_pid() {
        let ppid = get_parent_pid(std::process::id()).expect("should get own ppid");
        assert!(ppid > 1, "test process ppid should be > 1");
    }

    #[test]
    fn test_get_process_start_time() {
        let st = get_process_start_time(std::process::id()).expect("should get own start time");
        assert!(st > 0);
    }

    #[test]
    fn test_get_ptree_session_id_self() {
        // The test runner process should have a deep enough chain
        // (cargo test → test binary → ... → init), but the exact depth
        // depends on the environment. Just verify it returns Some or None
        // without panicking, and if Some, has the right format.
        if let Some(id) = get_ptree_session_id(std::process::id()) {
            assert!(id.starts_with("ptree:"), "expected ptree: prefix, got {id}");
            let parts: Vec<&str> = id.split(':').collect();
            assert_eq!(parts.len(), 3, "expected ptree:pid:starttime, got {id}");
            let _pid: u32 = parts[1].parse().expect("pid should be a number");
            let _st: u64 = parts[2].parse().expect("start time should be a number");
        }
    }

    #[test]
    fn test_get_tty_session_id_format() {
        // May or may not have a TTY depending on how tests are run.
        // Just verify it doesn't panic and has correct format if present.
        if let Some(id) = get_tty_session_id(std::process::id()) {
            assert!(id.starts_with("tty:"), "expected tty: prefix, got {id}");
        }
    }
}
