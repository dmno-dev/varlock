import Foundation
@testable import SessionScoping

/// In-memory description of one process in a synthetic tree.
struct FakeProc {
    var pid: pid_t
    var ppid: pid_t
    /// Controlling tty device; `-1` (NODEV) means "no tty" (the GUI/agent case).
    var tty: dev_t = -1
    var startTime: Int = 0
    var path: String?
    var args: [String] = []
    var env: [String: String] = [:]
    /// Session leader pid as `getsid` would report; `0` means unknown.
    var sid: pid_t = 0
}

/// A `ProcessProvider` backed by a fixed in-memory process tree, so the scoping
/// logic can be exercised deterministically with no live processes.
final class FakeProcessProvider: ProcessProvider {
    private var procs: [pid_t: FakeProc] = [:]
    private let ttyNames: [dev_t: String]

    init(_ procs: [FakeProc], ttyNames: [dev_t: String] = [:]) {
        for p in procs { self.procs[p.pid] = p }
        self.ttyNames = ttyNames
    }

    func info(for pid: pid_t) -> ProcSnapshot? {
        guard let p = procs[pid] else { return nil }
        return ProcSnapshot(pid: p.pid, ppid: p.ppid, tty: p.tty, startTime: p.startTime)
    }

    func environment(for pid: pid_t) -> [String: String]? {
        guard let p = procs[pid] else { return nil }
        return p.env
    }

    func arguments(for pid: pid_t) -> [String]? {
        guard let p = procs[pid] else { return nil }
        return p.args
    }

    func path(for pid: pid_t) -> String? {
        return procs[pid]?.path
    }

    func ttyName(forDevice dev: dev_t) -> String? {
        return ttyNames[dev]
    }

    func sessionLeader(for pid: pid_t) -> pid_t {
        return procs[pid]?.sid ?? 0
    }
}
