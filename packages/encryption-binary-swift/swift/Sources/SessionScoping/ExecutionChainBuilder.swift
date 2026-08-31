import Foundation
import Darwin

/// Reads the chain of processes behind a request off the live machine.
///
/// The daemon knows the peer's pid from the socket, and everything above it is
/// there to be read: parents, executable paths, arguments, code-signing status.
/// Turning that into "agent.ts, via bun, launched from iTerm2" is what makes the
/// panel answerable, because the pid on its own tells a person nothing.
///
/// Every read here is best effort and bounded. A process that exits mid-walk, an
/// argument list that cannot be read, a signature that cannot be checked: each of
/// those costs one missing detail and never a missing panel. The unlock is the
/// thing the user is waiting for, and no amount of provenance is worth making
/// them wait for it, so the walk gives up on a deadline rather than blocking.

/// The code-signing half of the inspection, behind a protocol so the chain can be
/// built against synthetic processes in tests.
public protocol PostureProbe {
    func posture(forPid pid: pid_t) -> PeerPostureFacts
}

/// The live probe, reading the kernel's own view of a process.
public struct LivePostureProbe: PostureProbe {
    private let reader = PeerPostureReader()

    public init() {}

    public func posture(forPid pid: pid_t) -> PeerPostureFacts {
        return reader.facts(forPid: pid)
    }
}

public struct ExecutionChainBuilder {
    /// How far up the tree to walk. Deep enough to reach the terminal app that
    /// was launched, short enough that a deep tree cannot become a long panel.
    public static let maxDepth = 10

    /// How long the whole inspection may take. The panel is what the user is
    /// waiting for; provenance that is not ready by now is not shown.
    public static let deadlineSeconds: TimeInterval = 0.25

    /// Executables that are plumbing rather than actors. A shell in the chain
    /// says how something was started, not what is running.
    static let shellNames: Set<String> = [
        "sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "login", "env", "xargs",
    ]

    /// Executables that run somebody else's code. The signature on one of these
    /// covers the interpreter, never the script it was handed.
    static let interpreterNames: Set<String> = [
        "node", "bun", "deno", "python", "python3", "ruby", "perl", "tsx", "ts-node",
    ]

    /// Sub-commands to step over when looking for the script an interpreter was
    /// given ("bun run agent.ts", "deno run main.ts").
    static let interpreterSubcommands: Set<String> = ["run", "exec", "x", "-e", "--eval"]

    /// varlock itself is always in the chain, being the process that connected,
    /// and is never the answer to "who is asking".
    static let ownNames: Set<String> = ["varlock", "varlock-local-encrypt", "VarlockEnclave"]

    private let provider: ProcessProvider
    private let posture: PostureProbe
    private let clock: () -> Date

    public init(
        provider: ProcessProvider = LiveProcessProvider(),
        posture: PostureProbe = LivePostureProbe(),
        clock: @escaping () -> Date = Date.init
    ) {
        self.provider = provider
        self.posture = posture
        self.clock = clock
    }

    public func build(forPid pid: pid_t) -> ExecutionChain {
        let started = clock()
        var walked: [WalkedProcess] = []
        var current = pid
        var terminal: String?

        for _ in 0..<Self.maxDepth {
            guard let info = provider.info(for: current) else { break }
            if terminal == nil, info.tty > 0 {
                terminal = provider.ttyName(forDevice: info.tty)
            }
            let path = provider.path(for: current)
            let walkedProcess = WalkedProcess(
                snapshot: info,
                path: path,
                arguments: provider.arguments(for: current) ?? []
            )
            walked.append(walkedProcess)

            // The app the user launched is the top of the story. Anything above
            // it is the system starting apps, which nobody needs to read.
            if walkedProcess.bundlePath != nil { break }
            guard info.ppid > 1, info.ppid != current else { break }
            guard clock().timeIntervalSince(started) < Self.deadlineSeconds else { break }
            current = info.ppid
        }

        guard !walked.isEmpty else { return .empty }

        // Launcher first, the process that connected last: the order things
        // happened in, which is the order a person reconstructs them in.
        let ordered = Array(walked.reversed())
        let importantIndex = importantHopIndex(ordered)

        var hops: [ExecutionHop] = []
        for (index, walkedProcess) in ordered.enumerated() {
            let isLauncher = walkedProcess.bundlePath != nil && index == 0
            hops.append(ExecutionHop(
                pid: walkedProcess.snapshot.pid,
                name: isLauncher ? launcherName(walkedProcess) : walkedProcess.displayName,
                via: walkedProcess.scriptName == nil ? nil : "via \(walkedProcess.executableName)",
                path: isLauncher
                    ? walkedProcess.bundlePath.map { ($0 as NSString).deletingLastPathComponent }
                    : walkedProcess.path,
                bundlePath: walkedProcess.bundlePath,
                // The terminal belongs on the row a person recognises: the app
                // they launched, or failing that whatever started the chain.
                terminalName: index == 0 ? terminal : nil,
                posture: hopPosture(walkedProcess),
                isLauncher: isLauncher,
                isImportant: index == importantIndex
            ))
        }

        return ExecutionChain(
            hops: hops,
            agentSession: agentSession(in: ordered, startedAt: started)
        )
    }

    /// Which hop actually decides what runs.
    ///
    /// A script wins, because the interpreter running it is interchangeable and
    /// the script is not. Failing that it is the first thing below the launcher
    /// that is neither a shell nor varlock, and failing that the shell itself,
    /// which for a plain terminal is the honest answer.
    private func importantHopIndex(_ ordered: [WalkedProcess]) -> Int {
        let candidates = ordered.enumerated().filter { !($0.element.bundlePath != nil && $0.offset == 0) }
        if let script = candidates.last(where: { $0.element.scriptName != nil && !$0.element.isOwnProcess }) {
            return script.offset
        }
        if let binary = candidates.first(where: {
            !$0.element.isShell && !$0.element.isOwnProcess
        }) {
            return binary.offset
        }
        if let shell = candidates.last(where: { !$0.element.isOwnProcess }) {
            return shell.offset
        }
        return ordered.count - 1
    }

    /// What to call the app at the top of the chain.
    ///
    /// The name on screen is the one the user knows it by, which is the app's
    /// own display name, not the file its bundle happens to be called. Falls
    /// back to the executable, which is right often enough ("iTerm2"), and only
    /// then to the bundle's file name.
    private func launcherName(_ walkedProcess: WalkedProcess) -> String {
        guard let bundlePath = walkedProcess.bundlePath else { return walkedProcess.displayName }
        if let bundle = Bundle(path: bundlePath) {
            for key in ["CFBundleDisplayName", "CFBundleName"] {
                if let name = bundle.object(forInfoDictionaryKey: key) as? String, !name.isEmpty {
                    return name
                }
            }
        }
        let executable = walkedProcess.executableName
        if executable != "unknown" { return executable }
        return walkedProcess.displayName
    }

    private func hopPosture(_ walkedProcess: WalkedProcess) -> HopPosture {
        // An interpreter's signature says nothing about the script it was given,
        // so claiming "signed and hardened" here would be true of the wrong
        // thing. The panel says what is actually running instead.
        if walkedProcess.scriptName != nil { return .interpretedScript }
        let facts = posture.posture(forPid: walkedProcess.snapshot.pid)
        guard facts.isReadable else { return .unknown }
        return facts.signatureValid && facts.hasHardenedRuntime ? .signedHardened : .unhardened
    }

    // MARK: - Agent sessions

    /// Products worth naming when their session is what the request came from.
    ///
    /// Matched on the process itself where possible, and otherwise on the
    /// environment it exported, which is what survives into the shell an agent
    /// runs commands in.
    struct AgentMarker {
        let productName: String
        let executableNames: Set<String>
        let environmentKeys: Set<String>
    }

    static let agentMarkers: [AgentMarker] = [
        AgentMarker(
            productName: "Claude Code",
            executableNames: ["claude"],
            environmentKeys: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]
        ),
    ]

    /// The agent session this request came from, if it came from one.
    ///
    /// The executable is checked first because it is free: the walk already read
    /// every argument list. Only if that finds nothing is the environment read,
    /// which costs a syscall per process, and only until the deadline: a badge is
    /// worth having, never worth making an unlock wait.
    private func agentSession(in ordered: [WalkedProcess], startedAt: Date) -> AgentSessionBadge? {
        for walkedProcess in ordered {
            for marker in Self.agentMarkers where marker.executableNames.contains(walkedProcess.executableName) {
                return badge(marker: marker, process: walkedProcess)
            }
        }

        for walkedProcess in ordered {
            guard clock().timeIntervalSince(startedAt) < Self.deadlineSeconds else { return nil }
            guard let environment = provider.environment(for: walkedProcess.snapshot.pid) else { continue }
            for marker in Self.agentMarkers {
                let matched = marker.environmentKeys.contains { key in
                    guard let value = environment[key] else { return false }
                    return !value.isEmpty && value != "0"
                }
                if matched { return badge(marker: marker, process: walkedProcess) }
            }
        }
        return nil
    }

    private func badge(marker: AgentMarker, process: WalkedProcess) -> AgentSessionBadge {
        return AgentSessionBadge(
            productName: marker.productName,
            pid: process.snapshot.pid,
            startTime: process.snapshot.startTime > 0 ? process.snapshot.startTime : nil
        )
    }
}

/// One process as the walk found it, with the reading of it done once.
struct WalkedProcess {
    let snapshot: ProcSnapshot
    let path: String?
    let arguments: [String]

    /// The executable's own name, whatever it is running.
    var executableName: String {
        guard let path, !path.isEmpty else { return "unknown" }
        return (path as NSString).lastPathComponent
    }

    /// The `.app` this process belongs to, when it is a bundled app.
    var bundlePath: String? {
        guard let path, let range = path.range(of: ".app/Contents/MacOS/") else { return nil }
        return String(path[path.startIndex..<range.lowerBound]) + ".app"
    }

    var isShell: Bool { ExecutionChainBuilder.shellNames.contains(executableName) }

    var isInterpreter: Bool { ExecutionChainBuilder.interpreterNames.contains(executableName) }

    var isOwnProcess: Bool {
        if ExecutionChainBuilder.ownNames.contains(executableName) { return true }
        if let script = scriptName, ExecutionChainBuilder.ownNames.contains(script) { return true }
        return false
    }

    /// The script an interpreter was handed, when it was handed one.
    ///
    /// This is the whole reason the chain exists: `bun` is not the actor, the
    /// file it is running is, and that file is mutable in a way a signed binary
    /// is not.
    var scriptName: String? {
        guard isInterpreter else { return nil }
        for argument in arguments.dropFirst() {
            if argument.hasPrefix("-") { continue }
            if ExecutionChainBuilder.interpreterSubcommands.contains(argument) { continue }
            let name = (argument as NSString).lastPathComponent
            guard !name.isEmpty else { continue }
            // A bare word with no path and no extension is a package script or a
            // sub-command, not a file: naming it would be a guess.
            guard argument.contains("/") || name.contains(".") else { return nil }
            return name
        }
        return nil
    }

    /// What the panel calls this hop.
    var displayName: String {
        if let bundlePath {
            return ((bundlePath as NSString).lastPathComponent as NSString).deletingPathExtension
        }
        return scriptName ?? executableName
    }
}
