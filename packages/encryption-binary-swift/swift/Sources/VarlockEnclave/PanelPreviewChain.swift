import Foundation
import Darwin
import SessionScoping

/// A process tree written down in the preview payload instead of read off the
/// machine.
///
/// The panel's job is to describe situations that are awkward to be in on
/// purpose: varlock running as JavaScript under bun, an agent with nobody
/// watching it, an agent working in a different project from the one being
/// unlocked. Checking how those look should not require arranging one, so
/// `panel-preview` accepts the tree as data and runs the SAME
/// `ExecutionChainBuilder` over it. Nothing here is a second rendering path;
/// only the source of the facts changes.
///
/// Preview only. Neither the daemon nor any unlock ever constructs one of these.
enum PanelPreviewChain {
    /// Build a chain from a `processes` array, or nil when the payload has none.
    ///
    /// ```json
    /// "processes": [
    ///   { "pid": 100, "ppid": 1, "path": "/Applications/iTerm.app/Contents/MacOS/iTerm2" },
    ///   { "pid": 300, "ppid": 200, "path": "/Users/me/.bun/bin/bun",
    ///     "args": ["bun", "/p/node_modules/.bin/varlock", "load"],
    ///     "signed": true, "hardened": true }
    /// ],
    /// "peerPid": 300
    /// ```
    static func chain(from payload: [String: Any]) -> ExecutionChain? {
        guard let raw = payload["processes"] as? [[String: Any]], !raw.isEmpty else { return nil }
        let processes = raw.compactMap(ScriptedProcess.init)
        guard !processes.isEmpty else { return nil }
        let peer = (payload["peerPid"] as? NSNumber)?.int32Value ?? processes.last?.pid ?? 0
        let session = payload["agentSession"] as? [String: Any]
        return ExecutionChainBuilder(
            provider: ScriptedProcessProvider(processes: processes),
            posture: ScriptedPostureProbe(processes: processes),
            sessionMetadata: ScriptedMetadataReader(record: session)
        ).build(forPid: peer)
    }
}

/// One process as the payload described it.
private struct ScriptedProcess {
    let pid: pid_t
    let ppid: pid_t
    let tty: dev_t
    let startTime: Int
    let path: String?
    let arguments: [String]
    let environment: [String: String]
    let workingDirectory: String?
    let facts: PeerPostureFacts

    init?(_ raw: [String: Any]) {
        guard let pid = (raw["pid"] as? NSNumber)?.int32Value else { return nil }
        self.pid = pid
        ppid = (raw["ppid"] as? NSNumber)?.int32Value ?? 1
        tty = dev_t((raw["tty"] as? NSNumber)?.int32Value ?? 0)
        startTime = (raw["startTime"] as? NSNumber)?.intValue ?? 0
        path = raw["path"] as? String
        arguments = (raw["args"] as? [String]) ?? []
        environment = (raw["env"] as? [String: String]) ?? [:]
        workingDirectory = raw["cwd"] as? String
        // Absent means "the kernel would not say", which is a distinct answer the
        // panel has to be able to draw, so it is the default rather than a
        // convenient stand-in for "fine".
        let readable = (raw["signed"] ?? raw["hardened"]) != nil
        facts = PeerPostureFacts(
            isTraced: (raw["traced"] as? NSNumber)?.boolValue ?? false,
            hasHardenedRuntime: (raw["hardened"] as? NSNumber)?.boolValue ?? false,
            signatureValid: (raw["signed"] as? NSNumber)?.boolValue ?? false,
            isReadable: readable
        )
    }
}

private struct ScriptedProcessProvider: ProcessProvider {
    let processes: [ScriptedProcess]

    private func process(_ pid: pid_t) -> ScriptedProcess? {
        return processes.first { $0.pid == pid }
    }

    func info(for pid: pid_t) -> ProcSnapshot? {
        guard let match = process(pid) else { return nil }
        return ProcSnapshot(pid: match.pid, ppid: match.ppid, tty: match.tty, startTime: match.startTime)
    }

    func environment(for pid: pid_t) -> [String: String]? { return process(pid)?.environment }
    func arguments(for pid: pid_t) -> [String]? { return process(pid)?.arguments }
    func path(for pid: pid_t) -> String? { return process(pid)?.path }
    func workingDirectory(for pid: pid_t) -> String? { return process(pid)?.workingDirectory }

    func ttyName(forDevice dev: dev_t) -> String? {
        return dev > 0 ? "ttys\(String(format: "%03d", Int(dev)))" : nil
    }

    func sessionLeader(for pid: pid_t) -> pid_t {
        // The outermost process the payload described, which is what a session
        // leader is for a tree that was written down top first.
        return processes.first?.pid ?? pid
    }
}

private struct ScriptedPostureProbe: PostureProbe {
    let processes: [ScriptedProcess]

    func posture(forPid pid: pid_t) -> PeerPostureFacts {
        return processes.first { $0.pid == pid }?.facts ?? .unreadable
    }
}

/// The agent's own session record, taken from the payload instead of from
/// `~/.claude/sessions`. Parsed by the same code that reads the real file, so a
/// preview cannot drift from what a live session would produce.
private struct ScriptedMetadataReader: AgentSessionMetadataReader {
    let record: [String: Any]?

    func metadata(for product: AgentProduct, pid: pid_t, processStartTime: Int) -> AgentSessionMetadata? {
        guard let record else { return nil }
        let startedAt = (record["startedAt"] as? NSNumber)?.doubleValue
        return AgentSessionMetadata(
            title: LiveAgentSessionMetadataReader.humanTitle(record["name"]),
            isTitleDerived: (record["nameSource"] as? String) == "derived",
            startTime: startedAt.map { Int($0 / 1000) },
            kind: LiveAgentSessionMetadataReader.shortField(record["kind"]),
            workingDirectory: LiveAgentSessionMetadataReader.shortField(
                record["cwd"],
                limit: LiveAgentSessionMetadataReader.maxPathLength
            ),
            entrypoint: LiveAgentSessionMetadataReader.shortField(record["entrypoint"]),
            version: LiveAgentSessionMetadataReader.shortField(record["version"])
        )
    }
}
