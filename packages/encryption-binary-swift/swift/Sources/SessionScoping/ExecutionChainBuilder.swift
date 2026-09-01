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

    /// Wrappers that exist to go and fetch the real command.
    ///
    /// `bunx varlock load` is varlock being run, and saying so is the whole job
    /// of the line under the hop.
    static let commandWrappers: Set<String> = ["npx", "bunx", "pnpx", "dlx"]

    /// Words that follow an interpreter or package manager before the real
    /// command starts.
    static let wrapperSubcommands: Set<String> = ["run", "exec", "x", "dlx", "--"]

    private let provider: ProcessProvider
    private let posture: PostureProbe
    private let sessionMetadata: AgentSessionMetadataReader
    private let clock: () -> Date

    public init(
        provider: ProcessProvider = LiveProcessProvider(),
        posture: PostureProbe = LivePostureProbe(),
        sessionMetadata: AgentSessionMetadataReader = LiveAgentSessionMetadataReader(),
        clock: @escaping () -> Date = Date.init
    ) {
        self.provider = provider
        self.posture = posture
        self.sessionMetadata = sessionMetadata
        self.clock = clock
    }

    public func build(forPid pid: pid_t) -> ExecutionChain {
        let started = clock()
        var walked: [WalkedProcess] = []
        var current = pid

        for _ in 0..<Self.maxDepth {
            guard let info = provider.info(for: current) else { break }
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
        // Where a "this session" grant will actually attach, and therefore which
        // row has to say so. Found before the hops are built, because it changes
        // which hop is the actor and which hops read as inside the session.
        let anchor = SessionScoper(provider: provider).sessionAnchor(forPid: pid)
        let rootIndex = sessionRootIndex(in: ordered, anchor: anchor)
        let session = agentSession(in: ordered, startedAt: started)
        let root = anchor.flatMap { anchor in
            rootIndex.map { index in
                SessionRootMark(
                    label: anchor.label,
                    kind: anchor.kind,
                    // The one tty id in the chain. It belongs here because a
                    // controlling terminal is inherited: the shell and varlock
                    // below it share this exact tty, and the app that launched
                    // them holds none of its own.
                    terminal: anchor.terminal,
                    // Decoration, not the reason the row exists, and only on
                    // positive evidence: a row is named after an agent when the
                    // session is anchored on the agent's own process. An
                    // inherited environment marker says the request came from
                    // inside a session, which the label already says, and is no
                    // reason to call some other program by the agent's name.
                    agent: index == session?.index && session?.isTheAgentItself == true
                        ? session?.session
                        : nil
                )
            }
        }
        let importantIndex = importantHopIndex(ordered, sessionRootIndex: rootIndex)

        var hops: [ExecutionHop] = []
        for (index, walkedProcess) in ordered.enumerated() {
            let isLauncher = walkedProcess.bundlePath != nil && index == 0
            let resolvedScript = scriptPath(of: walkedProcess)
            hops.append(ExecutionHop(
                pid: walkedProcess.snapshot.pid,
                name: isLauncher ? launcherName(walkedProcess) : walkedProcess.displayName,
                // "varlock via node" is true and useless: node is how varlock
                // ships, not who is asking. The interpreter is still there in
                // the path when the chain is opened.
                via: walkedProcess.scriptName == nil || walkedProcess.isOwnProcess
                    ? nil
                    : "via \(walkedProcess.executableName)",
                path: isLauncher ? launcherDetailPath(walkedProcess) : walkedProcess.path,
                scriptPath: resolvedScript,
                bundlePath: walkedProcess.bundlePath,
                // The interpreter is a fact whether or not the row shows "via
                // bun". `via` is a display choice; this is what the posture claim
                // is actually about, and the two are not allowed to be the same
                // decision ever again.
                interpreterName: walkedProcess.scriptName == nil ? nil : walkedProcess.executableName,
                interpreterPath: walkedProcess.scriptName == nil ? nil : walkedProcess.path,
                interpreterPosture: walkedProcess.scriptName == nil
                    ? .unknown
                    : Self.posture(from: posture.posture(forPid: walkedProcess.snapshot.pid)),
                release: release(of: walkedProcess, scriptPath: resolvedScript),
                // Read for every hop, because an auto-load's useful line is the
                // host's command rather than varlock's own. Only the requester's
                // is drawn.
                invocation: Self.invocation(from: walkedProcess.arguments),
                runTarget: Self.runTarget(from: walkedProcess.arguments),
                posture: hopPosture(walkedProcess),
                isRequester: walkedProcess.snapshot.pid == pid,
                isLauncher: isLauncher,
                isImportant: importantIndex.map { $0 == index } ?? false,
                sessionRoot: index == rootIndex ? root : nil,
                // Everything below the session root ran inside it, which the
                // panel draws as one span rather than leaving to be inferred.
                isInsideSession: rootIndex.map { index > $0 } ?? false
            ))
        }

        return ExecutionChain(hops: hops)
    }

    /// Which hop is the ACTOR: the program the secrets are being loaded FOR.
    ///
    /// That is the whole definition, and everything below follows from it:
    ///
    ///   - a script beats the interpreter running it. `bun` is interchangeable;
    ///     `agent.ts` is the thing the values are for, and the mutable one.
    ///   - a host that auto-loaded varlock (`next dev`, `vite`, a test runner) is
    ///     the actor. varlock ran on its behalf.
    ///   - varlock itself NEVER is. It is in every chain, being the process that
    ///     connected, so emphasising it says nothing about this request. Its
    ///     command line is still shown under its own hop, which is where the
    ///     recognisable information actually lives.
    ///   - shells never are. `zsh` is how a command was typed, not what it was
    ///     typed for.
    ///   - the session root never is. It has a treatment of its own, and marking
    ///     it twice would claim the session is what is running, when what is
    ///     running is whatever the session started.
    ///   - an app bundle never is, wherever it sits. Today the walk stops at the
    ///     first one it meets, so that is the launcher; but an Electron editor's
    ///     "Code Helper" is a bundle and is not a shell, so without this it would
    ///     answer to the second rule the moment one ever appeared lower down.
    ///     A windowed app is where a command was started, never the command.
    ///
    /// When nothing qualifies, nothing is bold. That is the honest state for a
    /// command a person typed themselves: the values are for the command, the
    /// command is varlock, and there is no third party in the picture. Do not
    /// reintroduce a fallback here; a bold row that always exists is a bold row
    /// that means nothing.
    private func importantHopIndex(_ ordered: [WalkedProcess], sessionRootIndex: Int?) -> Int? {
        let candidates = ordered.enumerated().filter {
            $0.element.bundlePath == nil && $0.offset != sessionRootIndex
        }
        if let script = candidates.last(where: { $0.element.scriptName != nil && !$0.element.isOwnProcess }) {
            return script.offset
        }
        return candidates.first(where: { !$0.element.isShell && !$0.element.isOwnProcess })?.offset
    }

    /// Which hop the session a grant attaches to begins at.
    ///
    /// The anchor comes from `SessionScoper`, the same code that computes the
    /// identifier the grant is keyed by, so the row a person reads and the
    /// identity they are granting to cannot drift apart.
    ///
    /// The anchor is always the peer or one of its ancestors. When the walk
    /// stopped before reaching it (an app bundle at the top, the depth cap, the
    /// deadline) the nearest hop this chain has is its topmost one, so the mark
    /// goes there: the session exists either way, and a panel offering "This
    /// session" as a scope has to be able to say which session that is.
    private func sessionRootIndex(in ordered: [WalkedProcess], anchor: SessionAnchor?) -> Int? {
        guard let anchor else { return nil }
        guard !ordered.isEmpty else { return nil }
        guard let anchorPid = anchor.pid else {
            // An agent's own session id, with no process behind it. The outermost
            // hop is as close as the chain can get to where that session begins.
            return 0
        }
        return ordered.firstIndex { $0.snapshot.pid == anchorPid } ?? 0
    }

    /// The command line, short enough to draw.
    ///
    /// The program is named by its own file name rather than by the path it was
    /// found at, because "varlock load" is what a person typed and
    /// "/opt/homebrew/bin/varlock load" is where it happened to live. Long
    /// argument lists are cut at the end, so the subcommand and the first
    /// arguments (the part that says what is happening) always survive.
    public static func invocation(from arguments: [String]) -> String? {
        guard let program = arguments.first else { return nil }

        // "bunx varlock load", "node .../node_modules/.bin/varlock load" and
        // "/opt/homebrew/bin/varlock load" are the same act, and the only useful
        // way to say it is the way the user typed it. So when varlock appears
        // anywhere in the front of the command line, the line starts there.
        var tokens = arguments
        if let index = tokens.firstIndex(where: { isOwnCommand($0) }) {
            tokens = ["varlock"] + tokens.dropFirst(index + 1)
        } else if let script = scriptToken(in: tokens) {
            // "node .../node_modules/.bin/next dev" is "next dev" to everyone
            // except the person who wrote the launcher script.
            tokens = [(script.token as NSString).lastPathComponent] + tokens.dropFirst(script.index + 1)
        } else {
            let name = (program as NSString).lastPathComponent
            guard !name.isEmpty else { return nil }
            tokens = [name] + tokens.dropFirst()
        }

        // varlock's own line gets the trimming rule: it is the one a person is
        // being asked to judge, so it is drawn without waiting for the chain to
        // be opened, and it earns that place by saying only what matters.
        if tokens.first == "varlock" {
            return VarlockInvocation.fit(
                VarlockInvocation.trimmed(tokens),
                limit: maxVarlockInvocationLength
            )
        }

        let line = tokens.joined(separator: " ")
        guard line.count > maxInvocationLength else { return line }
        return String(line.prefix(maxInvocationLength - 1)) + "\u{2026}"
    }

    /// The command a `varlock run` will hand these values to, when that is what
    /// this command line is.
    public static func runTarget(from arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(where: { isOwnCommand($0) }) else { return nil }
        return VarlockInvocation.runTarget(["varlock"] + arguments.dropFirst(index + 1))
    }

    /// The script an interpreter or wrapper was pointed at, if that is the shape
    /// of this command line.
    static func scriptToken(in tokens: [String]) -> (index: Int, token: String)? {
        guard let program = tokens.first else { return nil }
        let name = (program as NSString).lastPathComponent
        guard interpreterNames.contains(name) || commandWrappers.contains(name) else { return nil }
        for (index, token) in tokens.enumerated().dropFirst() {
            if token.hasPrefix("-") { continue }
            if interpreterSubcommands.contains(token) || commandWrappers.contains(token) { continue }
            let leaf = (token as NSString).lastPathComponent
            guard !leaf.isEmpty else { continue }
            guard token.contains("/") || leaf.contains(".") else {
                // A bare word after a wrapper is the command itself ("bunx next").
                return commandWrappers.contains(name) ? (index, token) : nil
            }
            return (index, token)
        }
        return nil
    }

    /// Whether one argv token names varlock's own CLI, however it was reached.
    static func isOwnCommand(_ token: String) -> Bool {
        var name = (token as NSString).lastPathComponent
        for suffix in [".js", ".mjs", ".cjs", ".ts"] where name.hasSuffix(suffix) {
            name = String(name.dropLast(suffix.count))
        }
        return ownNames.contains(name)
    }

    /// Enough for a subcommand and its first arguments, and no more.
    public static let maxInvocationLength = 56

    /// varlock's own line is always on screen and is the one being judged, so it
    /// gets more room than a passing mention of a host command does.
    public static let maxVarlockInvocationLength = 72

    /// What to call the app at the top of the chain.
    ///
    /// The name on screen is the one the user knows it by, which is the app's
    /// own display name rather than the file its bundle happens to be called,
    /// and it is read from the OUTERMOST enclosing bundle: Electron editors
    /// spawn terminals from a helper nested inside the real app, and nobody
    /// launched "Code Helper (Plugin)".
    ///
    /// The bundle's file name wins when it is the fuller form of the same name,
    /// because that is the one Finder and the Dock show: "Visual Studio Code.app"
    /// says CFBundleName "Code". It never wins over a different name, so
    /// "iTerm.app" is still called iTerm2.
    ///
    /// Falls back to the executable, which is right often enough ("iTerm2"), and
    /// only then to the bundle's file name. A nested bundle skips that step: the
    /// executable there is the helper, which is the name being corrected.
    private func launcherName(_ walkedProcess: WalkedProcess) -> String {
        guard let bundlePath = walkedProcess.bundlePath else { return walkedProcess.displayName }
        let fileName = walkedProcess.displayName
        if let bundle = Bundle(path: bundlePath) {
            for key in ["CFBundleDisplayName", "CFBundleName"] {
                guard let name = bundle.object(forInfoDictionaryKey: key) as? String, !name.isEmpty else {
                    continue
                }
                return Self.isFullerForm(fileName, of: name) ? fileName : name
            }
        }
        let executable = walkedProcess.executableName
        if executable != "unknown", !walkedProcess.isNestedBundle { return executable }
        return fileName
    }

    /// Whether `candidate` is the same name as `name` with more of it: "Visual
    /// Studio Code" for "Code". Whole words only, so "Xcode" is not a fuller
    /// form of "code".
    static func isFullerForm(_ candidate: String, of name: String) -> Bool {
        guard candidate.count > name.count, !name.isEmpty else { return false }
        return candidate.hasPrefix("\(name) ")
            || candidate.hasSuffix(" \(name)")
            || candidate.contains(" \(name) ")
    }

    /// The script this hop is running, as a real file on disk.
    ///
    /// Worth the two syscalls because a file's own icon is the fastest way a
    /// person recognises the thing they are being asked about, and the system
    /// will only answer honestly for a path: an extension is ambiguous (".ts" is
    /// registered for MPEG transport streams as well as TypeScript), so nothing
    /// here ever guesses from one. An argument that does not resolve to a file
    /// that exists is left as nil, and the panel draws a plain document.
    ///
    /// Resolved for varlock's own CLI too. It used to be skipped there, on the
    /// reasoning that varlock does not need to be introduced to itself; but the
    /// resolved path is the answer to "WHICH varlock is this", which for a
    /// `node_modules` copy is the whole question.
    private func scriptPath(of walkedProcess: WalkedProcess) -> String? {
        guard let token = Self.scriptToken(in: walkedProcess.arguments)?.token else { return nil }

        var candidate = token
        if candidate.hasPrefix("~") {
            candidate = NSString(string: candidate).expandingTildeInPath
        }
        if !candidate.hasPrefix("/") {
            // Relative to wherever the process was started, which only the
            // kernel knows. Unreadable for a process we are not allowed to
            // inspect, and that is a fine place to stop.
            guard let directory = provider.workingDirectory(for: walkedProcess.snapshot.pid) else { return nil }
            candidate = NSString(string: directory).appendingPathComponent(candidate)
        }
        candidate = NSString(string: candidate).standardizingPath
        guard FileManager.default.fileExists(atPath: candidate) else { return nil }
        // Through the symlink, because a package manager's `node_modules/.bin`
        // entry is a link and the question the reader is asking is where the
        // code actually is. `.../node_modules/.bin/varlock` and
        // `.../node_modules/varlock/bin/cli.js` are the same file, and only the
        // second one says which package it came out of.
        return NSString(string: candidate).resolvingSymlinksInPath
    }

    /// Which build of varlock is running, read off the package it came out of.
    ///
    /// Only for varlock, and only from a file the daemon resolved itself: the
    /// nearest `package.json` above the entry script that actually names varlock.
    /// A version is worth drawing on this panel because a `-dev` suffix says the
    /// running code is not the published artifact, and that is exactly the kind
    /// of thing somebody should notice before approving.
    ///
    /// The manifest's own `name` is the test, rather than the argv looking like
    /// varlock. The two disagree in real invocations: a `node_modules/.bin`
    /// entry resolves through its symlink to `varlock/bin/cli.js`, and by then
    /// the file is called `cli.js`. The package that owns the file is the better
    /// witness anyway, and it is why a third party's script gets no version line:
    /// its manifest does not say varlock, so nothing is drawn.
    ///
    /// The compiled binary has no package around it, so nothing is returned for
    /// it here; the panel falls back to what the client reported and says so.
    private func release(of walkedProcess: WalkedProcess, scriptPath: String?) -> HopRelease? {
        guard let scriptPath else { return nil }
        var directory = (scriptPath as NSString).deletingLastPathComponent
        for _ in 0..<Self.maxPackageDepth {
            guard !directory.isEmpty, directory != "/" else { return nil }
            let manifest = NSString(string: directory).appendingPathComponent("package.json")
            if let package = Self.readPackage(atPath: manifest) {
                // Any other package.json on the way up belongs to something
                // varlock happens to live inside, and its version is not ours.
                guard package.name == "varlock" else { return nil }
                return package.version.map { HopRelease(version: $0, source: .readFromDisk) }
            }
            directory = (directory as NSString).deletingLastPathComponent
        }
        return nil
    }

    /// How far above an entry script to look for the package that owns it.
    /// `packages/varlock/src/cli/cli-executable.ts` is three, and a bundled
    /// `dist/cli.mjs` is one.
    static let maxPackageDepth = 6
    /// A manifest bigger than this is not one worth reading two fields out of.
    static let maxPackageBytes = 512 * 1024

    static func readPackage(atPath path: String) -> (name: String?, version: String?)? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let size = (attributes[.size] as? NSNumber)?.intValue,
              size > 0, size <= maxPackageBytes else { return nil }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: [.mappedIfSafe]),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return (json["name"] as? String, Self.versionText(json["version"]))
    }

    /// A version string short enough and plain enough to draw. Anything else is
    /// dropped: this is a file on disk that anyone running as the user can edit,
    /// and it is display decoration either way.
    public static func versionText(_ value: Any?) -> String? {
        guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty, text.count <= 32 else { return nil }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-+_"))
        guard text.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        return text
    }

    /// The path shown for the launcher once the chain is opened.
    ///
    /// The headline is the app a person launched; the evidence is the bundle the
    /// process is actually in, which for an Electron editor is a helper nested
    /// several directories down. Saying so is honest, and it is not the headline.
    ///
    /// The whole bundle path, not the directory it sits in. The directory used to
    /// be shown on the theory that the bundle's name was already the row's name,
    /// which made the evidence line under an app in `/Applications` read
    /// "/Applications" and say nothing. Which COPY of an app this is, is the
    /// question the line exists to answer, and only the full path answers it: an
    /// agent CLI installed under `~/Library/Application Support` is not the one in
    /// `/Applications`, and the version is in that path too.
    private func launcherDetailPath(_ walkedProcess: WalkedProcess) -> String? {
        if let inner = walkedProcess.innerBundlePath, inner != walkedProcess.bundlePath {
            return inner
        }
        return walkedProcess.bundlePath
    }

    /// What the daemon can honestly say about the code running at one hop.
    ///
    /// An interpreter's signature covers the interpreter and nothing else. When a
    /// hop is `bun` running a `.mjs` file, the kernel reports a valid signature
    /// and the Hardened Runtime, and every word of that is about bun: the file it
    /// was handed is unsigned and any process running as the user can rewrite it
    /// between now and the next read. So an interpreted hop gets
    /// `.interpretedScript` and its interpreter's real posture is carried
    /// separately, to be stated next to the interpreter's name.
    ///
    /// varlock's own CLI used to be exempt from this, on the grounds that the
    /// daemon "verifies the peer's code signature before it will speak to it at
    /// all". It does not. `verifyPeerProcess` checks the peer's binary NAME
    /// against an allowlist that contains `node` and `bun` precisely so that
    /// varlock's JavaScript can connect, and `PeerPosture.check` reads the same
    /// status word this function reads, about the same interpreter process. The
    /// effect of the exemption was that `bunx varlock load` drew a green shield
    /// and the word "signed" on a row labelled "varlock", describing bun. That is
    /// the one claim this panel must never make, so the exemption is gone.
    private func hopPosture(_ walkedProcess: WalkedProcess) -> HopPosture {
        if walkedProcess.scriptName != nil { return .interpretedScript }
        return Self.posture(from: posture.posture(forPid: walkedProcess.snapshot.pid))
    }

    /// The posture of one process's own binary, from the kernel's status word.
    static func posture(from facts: PeerPostureFacts) -> HopPosture {
        guard facts.isReadable else { return .unknown }
        guard facts.signatureValid else { return .unsigned }
        return facts.hasHardenedRuntime ? .signedHardened : .signedOnly
    }

    // MARK: - Agent sessions

    /// Products worth naming when their session is what the request came from.
    ///
    /// Matched on the process itself where possible, and otherwise on the
    /// environment it exported, which is what survives into the shell an agent
    /// runs commands in.
    struct AgentMarker {
        let product: AgentProduct
        let executableNames: Set<String>
        let environmentKeys: Set<String>
    }

    static let agentMarkers: [AgentMarker] = [
        AgentMarker(
            product: .claudeCode,
            executableNames: ["claude"],
            environmentKeys: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]
        ),
        AgentMarker(
            product: .codex,
            executableNames: ["codex"],
            environmentKeys: []
        ),
    ]

    /// A session, which hop it was found at, and how strong that finding is.
    struct FoundSession {
        let index: Int
        let session: AgentSession
        /// Whether this hop IS the agent, rather than merely a process running
        /// inside one. Only the first can put the agent's name on a row.
        let isTheAgentItself: Bool
    }

    /// The agent session this request came from, if it came from one.
    ///
    /// The executable is checked first because it is free: the walk already read
    /// every argument list. Only if that finds nothing is the environment read,
    /// which costs a syscall per process, and only until the deadline: a badge is
    /// worth having, never worth making an unlock wait.
    private func agentSession(in ordered: [WalkedProcess], startedAt: Date) -> FoundSession? {
        for (index, walkedProcess) in ordered.enumerated() {
            for marker in Self.agentMarkers where marker.executableNames.contains(walkedProcess.executableName) {
                return found(marker: marker, index: index, process: walkedProcess, isTheAgentItself: true)
            }
        }

        for (index, walkedProcess) in ordered.enumerated() {
            guard clock().timeIntervalSince(startedAt) < Self.deadlineSeconds else { return nil }
            guard let environment = provider.environment(for: walkedProcess.snapshot.pid) else { continue }
            for marker in Self.agentMarkers {
                let matched = marker.environmentKeys.contains { key in
                    guard let value = environment[key] else { return false }
                    return !value.isEmpty && value != "0"
                }
                // An exported marker proves the request came from INSIDE that
                // agent's session, never that this process is the agent: the
                // variable is inherited by every descendant, so the topmost
                // carrier is just the outermost process the walk could read.
                // `next dev` started by an agent would answer to this too.
                if matched {
                    return found(marker: marker, index: index, process: walkedProcess, isTheAgentItself: false)
                }
            }
        }
        return nil
    }

    /// The session as the panel will say it: product, the session's own title
    /// where the agent recorded one, and when it began.
    private func found(
        marker: AgentMarker,
        index: Int,
        process: WalkedProcess,
        isTheAgentItself: Bool
    ) -> FoundSession {
        let processStart = process.snapshot.startTime > 0 ? process.snapshot.startTime : nil
        let metadata = sessionMetadata.metadata(
            for: marker.product,
            pid: process.snapshot.pid,
            processStartTime: process.snapshot.startTime
        )
        return FoundSession(
            index: index,
            session: AgentSession(
                productName: marker.product.displayName,
                title: metadata?.title,
                isTitleDerived: metadata?.isTitleDerived ?? false,
                // The agent's own record of when the session began where there is
                // one, since a session can outlive the process that started it.
                startTime: metadata?.startTime ?? processStart,
                kind: metadata?.kind,
                workingDirectory: metadata?.workingDirectory,
                entrypoint: metadata?.entrypoint,
                version: metadata?.version
            ),
            isTheAgentItself: isTheAgentItself
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

    /// The `.app` this process's executable sits directly inside, which for an
    /// Electron editor is a helper bundle: "Code Helper (Plugin).app".
    var innerBundlePath: String? {
        guard let path, let range = path.range(of: ".app/Contents/MacOS/") else { return nil }
        return String(path[path.startIndex..<range.lowerBound]) + ".app"
    }

    /// The `.app` a person actually launched: the OUTERMOST bundle enclosing this
    /// process.
    ///
    /// Electron editors run their terminals from a helper nested inside the real
    /// app ("Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app"),
    /// and the name and the icon anyone recognises belong to the outer one. Where
    /// there is no outer bundle this is the same path as `innerBundlePath`, which
    /// is every non-Electron case.
    var bundlePath: String? {
        guard let inner = innerBundlePath else { return nil }
        guard let range = inner.range(of: ".app/") else { return inner }
        return String(inner[inner.startIndex..<range.lowerBound]) + ".app"
    }

    /// Whether this process runs from a helper bundle inside a bigger app, the
    /// way every Electron editor spawns its integrated terminal.
    var isNestedBundle: Bool {
        guard let inner = innerBundlePath else { return false }
        return inner != bundlePath
    }

    var isShell: Bool { ExecutionChainBuilder.shellNames.contains(executableName) }

    var isInterpreter: Bool { ExecutionChainBuilder.interpreterNames.contains(executableName) }

    var isOwnProcess: Bool {
        if ExecutionChainBuilder.isOwnCommand(executableName) { return true }
        if let script = scriptName, ExecutionChainBuilder.isOwnCommand(script) { return true }
        return false
    }

    /// The script an interpreter was handed, when it was handed one.
    ///
    /// This is the whole reason the chain exists: `bun` is not the actor, the
    /// file it is running is, and that file is mutable in a way a signed binary
    /// is not. A wrapper counts too, because `bunx varlock` is varlock being run
    /// and saying "bun" would name the delivery van.
    var scriptName: String? {
        guard isInterpreter || isWrapperInvocation else { return nil }
        guard let script = ExecutionChainBuilder.scriptToken(in: arguments) else { return nil }
        let name = (script.token as NSString).lastPathComponent
        return name.isEmpty ? nil : name
    }

    /// Whether the command line was written as a wrapper fetching something else.
    var isWrapperInvocation: Bool {
        guard let program = arguments.first else { return false }
        return ExecutionChainBuilder.commandWrappers.contains((program as NSString).lastPathComponent)
    }

    /// What the panel calls this hop.
    var displayName: String {
        if let bundlePath {
            return ((bundlePath as NSString).lastPathComponent as NSString).deletingPathExtension
        }
        return scriptName ?? executableName
    }
}
