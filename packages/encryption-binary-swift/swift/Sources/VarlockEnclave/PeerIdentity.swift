import Foundation
import Darwin

// LOCAL_PEERPID may not be exported by Swift's Darwin module
private let LOCAL_PEERPID: Int32 = 0x002

// proc_pidpath is in libproc.h which isn't auto-bridged to Swift
@_silgen_name("proc_pidpath")
private func proc_pidpath(_ pid: Int32, _ buffer: UnsafeMutablePointer<CChar>, _ buffersize: UInt32) -> Int32

private let PROC_PIDPATHINFO_MAXSIZE: UInt32 = 4096

/// Get the PID of the peer connected to a Unix domain socket.
func getPeerPid(fd: Int32) -> pid_t? {
    var pid: pid_t = 0
    var pidSize = socklen_t(MemoryLayout<pid_t>.size)
    let result = getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &pidSize)
    guard result == 0, pid > 0 else { return nil }
    return pid
}

/// Get process info via sysctl KERN_PROC.
private func getProcessInfo(pid: pid_t) -> kinfo_proc? {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.size

    let result = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
    guard result == 0 else { return nil }
    return info
}

/// Get the PPID for a given process.
private func getParentPid(pid: pid_t) -> pid_t? {
    guard let info = getProcessInfo(pid: pid) else { return nil }
    let ppid = info.kp_eproc.e_ppid
    return ppid > 0 ? ppid : nil
}

/// Get the start time (seconds since epoch) for a given process.
private func getStartTime(pid: pid_t) -> Int {
    guard let info = getProcessInfo(pid: pid) else { return 0 }
    return Int(info.kp_proc.p_starttime.tv_sec)
}

/// Get a stable session identifier for a process.
///
/// Prefers the controlling TTY (combined with the session leader's start time
/// to prevent TTY device reuse attacks). When no TTY is available (e.g.,
/// processes spawned by VSCode/Cursor extensions, background agents, etc.),
/// walks up the process tree to find a stable ancestor for session scoping.
///
/// The no-TTY algorithm finds the "app root" (ancestor whose PPID is 1/launchd),
/// then uses the grandchild of that app root in the peer's ancestry chain.
/// This scopes sessions narrowly — e.g., for Cursor, each Claude Code instance
/// gets its own session, while a malicious extension in the same window cannot
/// piggyback. If the tree is too shallow (peer is a direct child or grandchild
/// of the app root), returns nil (no caching, fresh auth each time).
///
/// Returns nil if no stable identity can be determined.
func getSessionIdentifier(forPid pid: pid_t) -> String? {
    guard let info = getProcessInfo(pid: pid) else { return nil }

    let ttyDev = info.kp_eproc.e_tdev
    let hasTty = ttyDev != UInt32.max && ttyDev != 0

    if hasTty {
        // TTY-based identity: device name + session leader start time
        guard let namePtr = devname(dev_t(ttyDev), S_IFCHR) else { return nil }
        let ttyName = String(cString: namePtr)

        let sessionLeaderPid = getsid(pid)
        var startTimestamp: Int = 0
        if sessionLeaderPid > 0, let leaderInfo = getProcessInfo(pid: sessionLeaderPid) {
            startTimestamp = Int(leaderInfo.kp_proc.p_starttime.tv_sec)
        }
        if startTimestamp == 0 {
            startTimestamp = Int(info.kp_proc.p_starttime.tv_sec)
        }

        return "tty:\(ttyName):\(startTimestamp)"
    }

    // No TTY — walk up the process tree to find a scoping ancestor.
    //
    // Build the ancestry chain from the peer up to (but not including) PID 1.
    // Example chain for Claude in Cursor:
    //   [node/bun, zsh, claude, extension-host, Cursor]
    //   indices: 0     1     2       3              4
    //
    // The last element is the "app root" (PPID=1).
    // We use the element at index (count - 3) — the grandchild of the app root.
    // This gives us per-tool scoping (e.g., the Claude binary), which is narrow
    // enough that other extensions can't piggyback, but stable across multiple
    // commands spawned by that tool.
    //
    // If the chain is too short (< 4 elements), we can't determine a stable
    // intermediate ancestor, so we return nil (no caching).

    var chain: [pid_t] = [pid]
    var current = pid
    // Walk up with a depth limit to avoid infinite loops
    for _ in 0..<64 {
        guard let ppid = getParentPid(pid: current), ppid > 1 else { break }
        chain.append(ppid)
        current = ppid
    }

    // Need at least 4 levels: peer → intermediate → scope-target → app-child → app-root
    // so that scope-target is a meaningful intermediate process
    guard chain.count >= 4 else { return nil }

    // The grandchild of the app root: 2 levels below the last element
    let scopePid = chain[chain.count - 3]
    let startTime = getStartTime(pid: scopePid)

    return "ptree:\(scopePid):\(startTime)"
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

/// Get the file path of the executable for a given PID.
func getProcessPath(pid: pid_t) -> String? {
    let buffer = UnsafeMutablePointer<CChar>.allocate(capacity: Int(PROC_PIDPATHINFO_MAXSIZE))
    defer { buffer.deallocate() }
    let result = proc_pidpath(pid, buffer, PROC_PIDPATHINFO_MAXSIZE)
    guard result > 0 else { return nil }
    return String(cString: buffer)
}

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
