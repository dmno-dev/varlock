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
        // Clean up stale socket
        let _ = std::fs::remove_file(&self.socket_path);

        // Ensure parent directory exists
        if let Some(parent) = std::path::Path::new(&self.socket_path).parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create socket directory: {e}"))?;
        }

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

                    // Get peer TTY identity
                    let tty_id = get_peer_tty_id(&stream);

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

        // Cleanup
        let _ = std::fs::remove_file(&self.socket_path);
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

// ── Peer TTY identity (Linux) ────────────────────────────────────

#[cfg(target_os = "linux")]
fn get_peer_tty_id(stream: &UnixStream) -> Option<String> {
    use nix::sys::socket::{getsockopt, sockopt::PeerCredentials};
    use std::os::fd::AsFd;

    let creds = getsockopt(&stream.as_fd(), PeerCredentials).ok()?;
    let pid = creds.pid();

    if pid <= 0 {
        return None;
    }

    // Read the process's controlling terminal from /proc
    get_tty_for_pid(pid as u32)
}

#[cfg(target_os = "linux")]
fn get_tty_for_pid(pid: u32) -> Option<String> {
    // Read /proc/<pid>/stat to get the tty_nr field (field 7, 0-indexed 6)
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;

    // The stat line format is: pid (comm) state ppid pgrp session tty_nr ...
    // comm can contain spaces and parens, so find the last ')' first
    let after_comm = stat.rfind(')')? + 2;
    let fields: Vec<&str> = stat[after_comm..].split_whitespace().collect();

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

    Some(format!("{tty_name}:{start_time}"))
}

#[cfg(target_os = "linux")]
fn get_process_start_time(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_comm = stat.rfind(')')? + 2;
    let fields: Vec<&str> = stat[after_comm..].split_whitespace().collect();
    // Field 19 after comm is starttime (in clock ticks since boot)
    fields.get(19)?.parse().ok()
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn get_peer_tty_id(_stream: &UnixStream) -> Option<String> {
    None
}

// ── Windows pipe security ───────────────────────────────────────

/// Create a SECURITY_ATTRIBUTES that restricts access to the current user only.
/// This prevents other users from connecting to the daemon's named pipe.
#[cfg(windows)]
fn create_current_user_security_attributes() -> Result<windows::Win32::Security::SECURITY_ATTRIBUTES, String> {
    use windows::Win32::Security::{
        SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR,
        InitializeSecurityDescriptor, SetSecurityDescriptorDacl,
        SECURITY_DESCRIPTOR_REVISION,
    };
    use windows::Win32::Security::Authorization::{
        SetEntriesInAclW, EXPLICIT_ACCESS_W, SET_ACCESS,
        TRUSTEE_W, TRUSTEE_IS_SID, TRUSTEE_TYPE,
        NO_INHERITANCE, TRUSTEE_FORM,
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
            grfInheritance: NO_INHERITANCE,
            Trustee: TRUSTEE_W {
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_TYPE(0), // TRUSTEE_IS_UNKNOWN
                ptstrName: windows::core::PWSTR(user_sid.0 as *mut u16),
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: TRUSTEE_FORM(0),
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
            sd_ptr as *mut _,
            SECURITY_DESCRIPTOR_REVISION,
        ).map_err(|e| format!("InitializeSecurityDescriptor failed: {e}"))?;

        SetSecurityDescriptorDacl(
            sd_ptr as *mut _,
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
