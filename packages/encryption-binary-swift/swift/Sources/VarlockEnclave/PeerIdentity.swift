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
/// The no-TTY algorithm walks the process tree to the app root (child of launchd),
/// then picks a stable scope key:
///   - Deep trees (4+ levels): grandchild of the app root (e.g. Claude in Cursor)
///   - If that process is an ephemeral shell wrapper, walk up to a longer-lived ancestor
///   - Shallow trees (2–3 levels): app root (e.g. Codex exec'ing scripts directly)
///
/// Returns nil only when no ancestor can be determined (chain shorter than 2).
func getSessionIdentifier(forPid pid: pid_t) -> String? {
    guard let info = getProcessInfo(pid: pid) else { return nil }

    // e_tdev is dev_t (Int32). NODEV is -1 in signed representation
    // (0xFFFFFFFF unsigned). Comparing Int32(-1) != UInt32.max is true in
    // Swift's BinaryInteger comparison, so we must compare in the same type.
    let ttyDev = info.kp_eproc.e_tdev
    let hasTty = ttyDev > 0

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
    // If the chain is too short (< 2 elements), we can't determine any ancestor.
    // Shallow trees (2–3 levels) scope to the app root so agents like Codex that
    // exec commands as direct/grandchildren of the app still get session reuse.
    // Deeper trees use the grandchild of the app root, unless that process is an
    // ephemeral shell wrapper (sh/bash/zsh), in which case we walk up further.

    var chain: [pid_t] = [pid]
    var current = pid
    // Walk up with a depth limit to avoid infinite loops
    for _ in 0..<64 {
        guard let ppid = getParentPid(pid: current), ppid > 1 else { break }
        chain.append(ppid)
        current = ppid
    }

    guard let scopePid = selectScopePid(from: chain) else { return nil }
    let startTime = getStartTime(pid: scopePid)

    return "ptree:\(scopePid):\(startTime)"
}

/// Shell and similar one-shot runners that should not be used as session scope keys.
private let ephemeralRunnerNames: Set<String> = [
    "sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh",
]

private func isEphemeralRunner(pid: pid_t) -> Bool {
    guard let processPath = getProcessPath(pid: pid) else { return false }
    let name = (processPath as NSString).lastPathComponent.lowercased()
    return ephemeralRunnerNames.contains(name)
}

/// Pick a stable scope PID from an ancestry chain (peer first, app root last).
private func selectScopePid(from chain: [pid_t]) -> pid_t? {
    guard chain.count >= 2 else { return nil }

    if chain.count >= 4 {
        var scopePid = chain[chain.count - 3]
        if isEphemeralRunner(pid: scopePid) {
            // Shell wrappers are one-shot; scope to a longer-lived ancestor.
            let fallback = chain[chain.count - 2]
            scopePid = isEphemeralRunner(pid: fallback) ? chain[chain.count - 1] : fallback
        }
        return scopePid
    }

    // Shallow tree: scope to the app root (direct child of launchd).
    return chain[chain.count - 1]
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
