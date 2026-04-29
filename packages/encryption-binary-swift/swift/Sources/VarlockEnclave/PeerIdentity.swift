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

/// Get a stable TTY identifier for a process.
///
/// Combines the TTY device name with the session leader's start time.
/// The session leader is the shell process that owns the TTY (its PID equals
/// the session ID). Using its start time prevents TTY device reuse attacks
/// (where a new terminal is allocated the same /dev/ttysNNN after the old one closed).
///
/// Returns nil if the process has no controlling TTY (detached, CI, etc).
func getTtyIdentifier(forPid pid: pid_t) -> String? {
    guard let info = getProcessInfo(pid: pid) else { return nil }

    let ttyDev = info.kp_eproc.e_tdev
    // NODEV (0xFFFFFFFF) or 0 means no controlling tty
    guard ttyDev != UInt32.max, ttyDev != 0 else { return nil }

    // Convert device number to name (e.g., "ttys003")
    guard let namePtr = devname(dev_t(ttyDev), S_IFCHR) else { return nil }
    let ttyName = String(cString: namePtr)

    // Get the session leader's start time for uniqueness.
    // getsid() returns the session leader PID (the shell that owns the TTY),
    // which is stable across all processes launched from the same terminal.
    // (e_tpgid is the *foreground process group*, which changes on every command.)
    let sessionLeaderPid = getsid(pid)
    var startTimestamp: Int = 0

    if sessionLeaderPid > 0, let leaderInfo = getProcessInfo(pid: sessionLeaderPid) {
        startTimestamp = Int(leaderInfo.kp_proc.p_starttime.tv_sec)
    }

    // If we couldn't get the session leader start time, fall back to the
    // connecting process's own start time (less ideal but still unique per session)
    if startTimestamp == 0 {
        startTimestamp = Int(info.kp_proc.p_starttime.tv_sec)
    }

    return "\(ttyName):\(startTimestamp)"
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
