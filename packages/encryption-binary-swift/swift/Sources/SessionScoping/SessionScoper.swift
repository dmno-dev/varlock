import Foundation
import Darwin

/// Computes a stable session identifier for a process, used to scope biometric
/// sessions in the daemon (`SessionManager`). All process inspection goes
/// through an injected `ProcessProvider`, so the full decision matrix is unit
/// testable against synthetic process trees.
///
/// Prefers the controlling TTY (combined with the session leader's start time
/// to prevent TTY device reuse attacks). When no TTY is available (e.g.
/// processes spawned by VSCode/Cursor extensions, background agents, etc.),
/// walks up the process tree to find a stable ancestor for session scoping.
///
/// A known LLM-session environment identifier (e.g. `CLAUDE_CODE_SESSION_ID`),
/// when present, is *combined with* the TTY/process-tree anchor — never trusted
/// on its own. This means a rogue process that forges the env var still gets a
/// distinct identity unless it is genuinely inside the same process subtree.
public struct SessionScoper {
    private let provider: ProcessProvider

    public init(provider: ProcessProvider) {
        self.provider = provider
    }

    /// Env vars set by terminal multiplexers on every descendant. When present
    /// they signal "the user is interactively driving this pane", so per-pane
    /// PTYs should remain a session boundary even though they look identical
    /// (structurally) to PTYs allocated by fan-out task runners like turbo.
    private static let multiplexerEnvKeys: [String] = [
        "TMUX",                // tmux: "<socket>,<server_pid>,<session_id>"
        "STY",                 // GNU screen: "<pid>.<tty>.<host>"
        "ZELLIJ",              // zellij
        "ZELLIJ_SESSION_NAME", // zellij (alt)
    ]

    /// Shells are one-shot command wrappers and should never scope a no-TTY session.
    private static let shellRunnerNames: Set<String> = [
        "sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh",
    ]

    /// Varlock CLI launchers are also one-shot; scope to the host that invoked them.
    private static let varlockLauncherNames: Set<String> = [
        "varlock", "varlock.exe", "varlock.cmd",
    ]

    /// Runtime/package-manager processes are wrappers only when their command line
    /// shows they are launching the Varlock CLI. A long-lived process like Vite may
    /// also be `node` or `bun`, and should remain a valid session scope.
    private static let packageManagerRunnerNames: Set<String> = [
        "bun", "node", "npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg",
    ]

    /// Env vars identifying a per-LLM-session, checked in no-TTY contexts
    /// (agents/extensions). When combined with a TTY/process-tree anchor these
    /// merely *narrow* the identity — but in the anchorless fallback (see
    /// `sessionIdentifier`) the value becomes the SOLE session key. Therefore
    /// every key listed here MUST carry a globally-unique, unguessable value (a
    /// UUID / thread id). Do NOT add coarse keys (NODE_ENV, a project name,
    /// etc.): a non-unique value here would let unrelated processes share a
    /// session in the anchorless case.
    private static let noTtySessionEnvKeys: [String] = [
        "CODEX_THREAD_ID",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_SESSION_ID",
    ]

    /// Minimum length for an env value to be trusted as a *standalone* session
    /// key (the anchorless fallback). Defense-in-depth sanity floor, not a
    /// security guarantee — real session UUIDs / thread ids are comfortably
    /// longer, while coarse values ("prod", a short name) are rejected.
    private static let minStandaloneSessionIdLength = 16

    // MARK: - Public entry point

    /// Get a stable session identifier for a process.
    ///
    /// Returns nil only when no ancestor can be determined (chain shorter than 2)
    /// and there is no LLM-session env identifier either.
    public func sessionIdentifier(forPid pid: pid_t) -> String? {
        guard let info = provider.info(for: pid) else { return nil }
        let parentSessionId = parentSessionIdentifier(forPid: pid, info: info)
        let aiSession = aiSessionFromEnvironment(forPid: pid)

        if let aiSession, let parentSessionId {
            return "env:\(aiSession.key):\(aiSession.value)|\(parentSessionId)"
        }
        if let parentSessionId {
            return parentSessionId
        }
        if let aiSession {
            // No TTY and no walkable process tree (e.g. a process reparented to
            // launchd). With no anchor, the env value is the ENTIRE session
            // boundary, so it must be a globally-unique, unguessable identifier.
            // Reject implausibly short values so a coarse key accidentally added
            // to `noTtySessionEnvKeys` can't scope a shared session. Fail closed
            // → the daemon re-authenticates on every call.
            if aiSession.value.count >= Self.minStandaloneSessionIdLength {
                return "env:\(aiSession.key):\(aiSession.value)"
            }
            return nil
        }
        return nil
    }

    // MARK: - Anchor selection

    private func parentSessionIdentifier(forPid pid: pid_t, info: ProcSnapshot) -> String? {
        if let ttyId = ttySessionIdentifier(forPid: pid, info: info) {
            return ttyId
        }
        return processTreeSessionIdentifier(forPid: pid)
    }

    private func parentPid(of pid: pid_t) -> pid_t? {
        guard let ppid = provider.info(for: pid)?.ppid, ppid > 0 else { return nil }
        return ppid
    }

    private func detectMultiplexerSignal(env: [String: String]?) -> (key: String, value: String)? {
        guard let env else { return nil }
        for key in Self.multiplexerEnvKeys {
            guard let raw = env[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
                continue
            }
            return (key, raw)
        }
        return nil
    }

    private func ttySessionIdentifier(forPid pid: pid_t, info: ProcSnapshot) -> String? {
        // e_tdev is dev_t (Int32). NODEV is -1, so we require strictly > 0.
        let peerTty = info.tty
        guard peerTty > 0 else { return nil }

        // Pick the anchor process for TTY scoping. Walking up past per-task PTYs
        // prevents fan-out task runners (turbo, nx, pnpm/npm parallel scripts,
        // concurrently, etc.) from fragmenting biometric sessions across what the
        // user perceives as a single command. Multiplexers (tmux, screen, zellij)
        // are detected via env vars and treated as a session boundary so panes the
        // user split for independent work remain separate.
        let peerEnv = provider.environment(for: pid)
        let multiplexer = detectMultiplexerSignal(env: peerEnv)

        var anchorPid = pid
        var anchorTty = peerTty
        var current = pid
        for _ in 0..<64 {
            guard let ppid = parentPid(of: current), ppid > 1,
                  let parentInfo = provider.info(for: ppid),
                  parentInfo.tty > 0 else { break }

            // Multiplexer present: only walk up while the parent still carries the
            // same multiplexer value. That keeps us inside the pane (still walking
            // past any inner turbo-style wrapper PTYs) but stops at the pane's
            // outermost shell, never crossing into the host shell that launched
            // the multiplexer.
            if let mux = multiplexer {
                let parentEnv = provider.environment(for: ppid)
                let parentValue = parentEnv?[mux.key]?.trimmingCharacters(in: .whitespacesAndNewlines)
                if parentValue != mux.value { break }
            }

            anchorPid = ppid
            anchorTty = parentInfo.tty
            current = ppid
        }

        guard let ttyName = provider.ttyName(forDevice: anchorTty) else { return nil }

        let sessionLeaderPid = provider.sessionLeader(for: anchorPid)
        var startTimestamp = 0
        if sessionLeaderPid > 0, let leaderInfo = provider.info(for: sessionLeaderPid) {
            startTimestamp = leaderInfo.startTime
        }
        if startTimestamp == 0 {
            startTimestamp = provider.info(for: anchorPid)?.startTime ?? 0
        }

        if let mux = multiplexer {
            // Include the multiplexer value so separate tmux servers / sessions
            // stay distinct even if a TTY device name happens to collide.
            return "tty:\(ttyName):\(startTimestamp):\(mux.key)=\(mux.value)"
        }
        return "tty:\(ttyName):\(startTimestamp)"
    }

    private func processTreeSessionIdentifier(forPid pid: pid_t) -> String? {
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
        let chain = buildAncestryChain(from: pid)
        guard let scopePid = selectScopePid(from: chain) else { return nil }
        let startTime = provider.info(for: scopePid)?.startTime ?? 0
        return "ptree:\(scopePid):\(startTime)"
    }

    // MARK: - Process-tree helpers

    private func buildAncestryChain(from pid: pid_t) -> [pid_t] {
        var chain: [pid_t] = [pid]
        var current = pid
        // Walk up with a depth limit to avoid infinite loops
        for _ in 0..<64 {
            guard let ppid = parentPid(of: current), ppid > 1 else { break }
            chain.append(ppid)
            current = ppid
        }
        return chain
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

    private func isEphemeralRunner(pid: pid_t) -> Bool {
        guard let processPath = provider.path(for: pid) else { return false }
        let name = (processPath as NSString).lastPathComponent.lowercased()
        if Self.shellRunnerNames.contains(name) || Self.varlockLauncherNames.contains(name) {
            return true
        }
        return Self.packageManagerRunnerNames.contains(name) && processCommandLineLaunchesVarlock(pid: pid)
    }

    private func processCommandLineLaunchesVarlock(pid: pid_t) -> Bool {
        guard let args = provider.arguments(for: pid), !args.isEmpty else { return false }
        return args.contains(where: argIsVarlockLauncher)
    }

    /// Whether a single argv entry is the Varlock CLI being launched — as
    /// opposed to merely *mentioning* a varlock-ish path inside a flag value or
    /// a longer string. Flags are skipped, and known launch paths are matched at
    /// the END of the arg (not as a buried substring, which previously
    /// false-matched siblings like `.../.bin/varlock-foo`).
    private func argIsVarlockLauncher(_ arg: String) -> Bool {
        if arg.hasPrefix("-") { return false }
        let name = (arg as NSString).lastPathComponent.lowercased()
        if Self.varlockLauncherNames.contains(name) { return true }
        return arg.hasSuffix("/node_modules/.bin/varlock")
            || arg.hasSuffix("/varlock/bin/cli.js")
            || arg.hasSuffix("/packages/varlock/bin/cli.js")
    }

    // MARK: - Environment-based identity

    private func aiSessionFromEnvironment(forPid pid: pid_t) -> (key: String, value: String)? {
        guard let env = provider.environment(for: pid) else { return nil }
        for key in Self.noTtySessionEnvKeys {
            guard let valueRaw = env[key] else { continue }
            let value = valueRaw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty {
                return (key, value)
            }
        }
        return nil
    }
}

/// Convenience wrapper using the live, OS-backed provider. This is the entry
/// point the daemon's IPC layer calls.
public func getSessionIdentifier(forPid pid: pid_t) -> String? {
    return SessionScoper(provider: LiveProcessProvider()).sessionIdentifier(forPid: pid)
}
