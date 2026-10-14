import Foundation
import Darwin
import SessionScoping

// The session-scoping logic (TTY / process-tree identity) lives in the
// `SessionScoping` library target so it can be unit tested against synthetic
// process trees. This file keeps only the IPC-facing peer checks, which depend
// on a live socket fd and aren't meaningfully testable in isolation.

// LOCAL_PEERPID may not be exported by Swift's Darwin module
private let LOCAL_PEERPID: Int32 = 0x002

/// Get the PID of the peer connected to a Unix domain socket.
func getPeerPid(fd: Int32) -> pid_t? {
    var pid: pid_t = 0
    var pidSize = socklen_t(MemoryLayout<pid_t>.size)
    let result = getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &pidSize)
    guard result == 0, pid > 0 else { return nil }
    return pid
}

// LOCAL_PEERTOKEN (sys/un.h) returns the peer's audit token
private let LOCAL_PEERTOKEN: Int32 = 0x006

/// Get the audit token of the peer connected to a Unix domain socket.
///
/// Unlike a pid, an audit token identifies one specific process instance
/// (it carries the pid version), so a code-signing lookup by token cannot be
/// pointed at a different process that later reused the pid.
func getPeerAuditToken(fd: Int32) -> audit_token_t? {
    var token = audit_token_t()
    var size = socklen_t(MemoryLayout<audit_token_t>.size)
    let result = getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &size)
    guard result == 0, size == socklen_t(MemoryLayout<audit_token_t>.size) else { return nil }
    return token
}

/// The pid inside an audit token (what `audit_token_to_pid` returns; libbsm
/// isn't bridged to Swift).
func pidFromAuditToken(_ token: audit_token_t) -> pid_t {
    return pid_t(bitPattern: token.val.5)
}

/// Who is on the other end of an IPC connection, resolved once per connection.
struct IPCPeer {
    let pid: pid_t?
    let auditToken: audit_token_t?
    /// Biometric session scope (TTY / process tree), see SessionScoping
    let sessionId: String?
}

// MARK: - Process Verification

/// Binary names allowed to connect to the daemon IPC socket.
/// This is a defense-in-depth check — it can be bypassed by renaming a binary,
/// but it raises the bar against opportunistic attacks (rogue npm packages, etc).
private let allowedBinaryNames: Set<String> = [
    "VarlockEnclave",        // The daemon itself (self-connections via .app bundle)
    "varlock-local-encrypt", // Rust binary (not used on macOS, but for completeness)
    "varlock",               // SEA CLI binary
    "node",                  // Node.js (varlock TS client)
    "bun",                   // Bun runtime (varlock TS client)
]

/// Verify that a peer process is an allowed Varlock client.
///
/// Checks the binary name of the connecting process against an allowlist.
/// Returns the binary name on success, nil on rejection.
func verifyPeerProcess(pid: pid_t) -> String? {
    guard let processPath = getProcessPath(pid: pid) else { return nil }
    let binaryName = (processPath as NSString).lastPathComponent
    guard allowedBinaryNames.contains(binaryName) else { return nil }
    return binaryName
}
