import Foundation
import Darwin

// proc_pidpath is in libproc.h which isn't auto-bridged to Swift
@_silgen_name("proc_pidpath")
private func proc_pidpath(_ pid: Int32, _ buffer: UnsafeMutablePointer<CChar>, _ buffersize: UInt32) -> Int32

private let PROC_PIDPATHINFO_MAXSIZE: UInt32 = 4096

/// A snapshot of the OS-level facts the session scoper needs about one process.
///
/// Decoupling these facts behind a value type (instead of reading `kinfo_proc`
/// inline) is what lets `SessionScoper` run against synthetic process trees in
/// unit tests — see `FakeProcessProvider` in the test target.
public struct ProcSnapshot {
    public let pid: pid_t
    public let ppid: pid_t
    /// Controlling tty device (`e_tdev`). `<= 0` means none (NODEV == -1).
    public let tty: dev_t
    /// Process start time, seconds since epoch (`p_starttime.tv_sec`).
    public let startTime: Int

    public init(pid: pid_t, ppid: pid_t, tty: dev_t, startTime: Int) {
        self.pid = pid
        self.ppid = ppid
        self.tty = tty
        self.startTime = startTime
    }
}

/// Abstraction over live process inspection so the scoping logic can be unit
/// tested deterministically with synthetic process trees. The live
/// implementation reads real kernel state via sysctl / getsid / devname.
public protocol ProcessProvider {
    func info(for pid: pid_t) -> ProcSnapshot?
    func environment(for pid: pid_t) -> [String: String]?
    func arguments(for pid: pid_t) -> [String]?
    func path(for pid: pid_t) -> String?
    func ttyName(forDevice dev: dev_t) -> String?
    func sessionLeader(for pid: pid_t) -> pid_t
}

/// The production `ProcessProvider`, backed by `sysctl(KERN_PROC*)`,
/// `getsid`, `devname`, and `proc_pidpath`.
public final class LiveProcessProvider: ProcessProvider {
    public init() {}

    private func kinfo(_ pid: pid_t) -> kinfo_proc? {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.size
        let result = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
        guard result == 0 else { return nil }
        return info
    }

    public func info(for pid: pid_t) -> ProcSnapshot? {
        guard let ki = kinfo(pid) else { return nil }
        return ProcSnapshot(
            pid: pid,
            ppid: ki.kp_eproc.e_ppid,
            tty: ki.kp_eproc.e_tdev,
            startTime: Int(ki.kp_proc.p_starttime.tv_sec)
        )
    }

    public func sessionLeader(for pid: pid_t) -> pid_t {
        return getsid(pid)
    }

    public func ttyName(forDevice dev: dev_t) -> String? {
        guard let namePtr = devname(dev, S_IFCHR) else { return nil }
        return String(cString: namePtr)
    }

    public func path(for pid: pid_t) -> String? {
        let buffer = UnsafeMutablePointer<CChar>.allocate(capacity: Int(PROC_PIDPATHINFO_MAXSIZE))
        defer { buffer.deallocate() }
        let result = proc_pidpath(pid, buffer, PROC_PIDPATHINFO_MAXSIZE)
        guard result > 0 else { return nil }
        return String(cString: buffer)
    }

    public func arguments(for pid: pid_t) -> [String]? {
        var argMax: Int32 = 0
        var argMaxSize = MemoryLayout<Int32>.size
        var argMaxMib: [Int32] = [CTL_KERN, KERN_ARGMAX]
        guard sysctl(&argMaxMib, UInt32(argMaxMib.count), &argMax, &argMaxSize, nil, 0) == 0, argMax > 0 else {
            return nil
        }

        var buffer = [CChar](repeating: 0, count: Int(argMax))
        var size = buffer.count
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        guard sysctl(&mib, UInt32(mib.count), &buffer, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else {
            return nil
        }

        let argc = buffer.withUnsafeBytes { rawBuffer -> Int32 in
            rawBuffer.load(as: Int32.self)
        }
        guard argc > 0 else { return [] }

        var offset = MemoryLayout<Int32>.size

        // Skip executable path.
        while offset < size, buffer[offset] != 0 { offset += 1 }
        while offset < size, buffer[offset] == 0 { offset += 1 }

        var args: [String] = []
        for _ in 0..<argc {
            guard offset < size else { break }
            let start = offset
            while offset < size, buffer[offset] != 0 { offset += 1 }
            if offset > start {
                buffer.withUnsafeBufferPointer { ptr in
                    if let base = ptr.baseAddress {
                        args.append(String(cString: base.advanced(by: start)))
                    }
                }
            }
            while offset < size, buffer[offset] == 0 { offset += 1 }
        }

        return args
    }

    public func environment(for pid: pid_t) -> [String: String]? {
        var argMax: Int32 = 0
        var argMaxSize = MemoryLayout<Int32>.size
        var argMaxMib: [Int32] = [CTL_KERN, KERN_ARGMAX]
        guard sysctl(&argMaxMib, UInt32(argMaxMib.count), &argMax, &argMaxSize, nil, 0) == 0, argMax > 0 else {
            return nil
        }

        var buffer = [CChar](repeating: 0, count: Int(argMax))
        var size = buffer.count
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        guard sysctl(&mib, UInt32(mib.count), &buffer, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else {
            return nil
        }

        let argc = buffer.withUnsafeBytes { rawBuffer -> Int32 in
            rawBuffer.load(as: Int32.self)
        }
        guard argc >= 0 else { return nil }

        var offset = MemoryLayout<Int32>.size

        // Skip executable path.
        while offset < size, buffer[offset] != 0 { offset += 1 }
        while offset < size, buffer[offset] == 0 { offset += 1 }

        // Skip argv entries.
        for _ in 0..<argc {
            guard offset < size else { break }
            while offset < size, buffer[offset] != 0 { offset += 1 }
            while offset < size, buffer[offset] == 0 { offset += 1 }
        }

        var env: [String: String] = [:]

        while offset < size {
            while offset < size, buffer[offset] == 0 { offset += 1 }
            guard offset < size else { break }

            let start = offset
            while offset < size, buffer[offset] != 0 { offset += 1 }
            guard offset > start else { continue }

            buffer.withUnsafeBufferPointer { ptr in
                guard let base = ptr.baseAddress else { return }
                let entry = String(cString: base.advanced(by: start))
                guard let eq = entry.firstIndex(of: "=") else { return }
                let key = String(entry[..<eq])
                let value = String(entry[entry.index(after: eq)...])
                env[key] = value
            }
        }

        return env
    }
}

/// File path of a pid's executable. Used by IPC peer verification.
public func getProcessPath(pid: pid_t) -> String? {
    return LiveProcessProvider().path(for: pid)
}
