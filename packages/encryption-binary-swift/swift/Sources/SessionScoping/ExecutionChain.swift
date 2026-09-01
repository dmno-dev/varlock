import Foundation
import Darwin

/// The line of processes that leads to whoever is asking.
///
/// One name is not enough to answer "is this me?". `bun` says nothing; `agent.ts
/// via bun, started from iTerm2` says everything. So the panel shows the chain
/// from the app that was launched down to the process on the other end of the
/// socket, and marks the one hop that actually decides what is running.
///
/// Everything in here is read off the kernel by the daemon, never taken from the
/// message, which is what makes it worth showing. It is a value type with no
/// syscalls of its own so the shape, the emphasis, and the collapsing can be
/// tested against synthetic process trees.

/// What the daemon can say about the code running at one hop.
///
/// The distinction that matters most here is between a hop that IS an executable
/// and a hop that is a FILE an executable was handed. macOS will happily tell you
/// that a `bun` process is signed by Jarred Sumner with the Hardened Runtime, and
/// every word of that is true of bun and none of it is true of the JavaScript bun
/// is running, which is an ordinary file any process running as the user can
/// rewrite. Reporting the first as though it answered for the second is the one
/// claim a security prompt must never make, so `interpretedScript` is its own
/// answer rather than a shade of `signedHardened`.
public enum HopPosture: Equatable {
    /// A valid signature and the Hardened Runtime. The strongest thing the
    /// kernel will say about an executable.
    case signedHardened
    /// A valid signature, but no Hardened Runtime, so nothing stops a debugger
    /// or an injected library attaching to it later. Not an accusation: plenty
    /// of legitimate tools ship this way, `varlock`'s own binary included.
    case signedOnly
    /// The status word was readable and there is no valid signature on it.
    case unsigned
    /// The code that decides what happens here is a file an interpreter was
    /// handed. Whatever the interpreter's own signature says, nothing has been
    /// checked about the file, so nothing is claimed about it.
    case interpretedScript
    /// Nothing could be read. Neither answer, and drawn as neither.
    case unknown

    /// The word that goes next to the mark once the chain is opened.
    ///
    /// Every posture has one now, including the ones that are not good news. An
    /// absent word used to mean "we are not saying", which reads on a panel as
    /// "nothing to report": the two are opposites, and a reader cannot tell them
    /// apart from a blank space.
    public var inlineLabel: String {
        switch self {
        case .signedHardened: return "signed"
        case .signedOnly: return "unhardened"
        case .unsigned: return "unsigned"
        case .interpretedScript: return "not verified"
        case .unknown: return "unchecked"
        }
    }

    /// The SF Symbol the mark is drawn with.
    ///
    /// A bare coloured dot says nothing to anyone who was not told the legend, so
    /// each answer gets a shape that carries it: a shield for what was checked, a
    /// warning triangle for code that was not, and a question mark for a process
    /// the kernel would not talk about.
    public var symbolName: String {
        switch self {
        case .signedHardened: return "checkmark.shield.fill"
        case .signedOnly: return "shield"
        case .unsigned: return "shield.slash"
        case .interpretedScript: return "exclamationmark.triangle.fill"
        case .unknown: return "questionmark.circle"
        }
    }

    /// Every answer, so a test can hold each one to the same standard.
    public static let allAnswers: [HopPosture] = [
        .signedHardened, .signedOnly, .unsigned, .interpretedScript, .unknown,
    ]

    /// Whether this answer is the good one, for whoever is choosing a colour.
    public var isVerified: Bool { self == .signedHardened }

    /// Whether this answer should read as a caution rather than as a shrug.
    public var isCaution: Bool { self == .interpretedScript }

    /// What was checked and what was not, in plain language, for the tooltip.
    ///
    /// - Parameter subject: what this mark is about, as the row names it.
    /// - Parameter interpreter: the interpreter running the code, when there is
    ///   one, so the sentence can say whose signature is being set aside.
    public func explanation(subject: String, interpreter: String? = nil) -> String {
        switch self {
        case .signedHardened:
            return "\(subject) has a code signature the kernel accepts, and is running with the "
                + "Hardened Runtime, so macOS refuses to attach a debugger to it or inject code into it. "
                + "Checked: signature valid, Hardened Runtime on, no debugger attached. "
                + "Not checked: who signed it."
        case .signedOnly:
            return "\(subject) has a code signature the kernel accepts, but is not running with the "
                + "Hardened Runtime, so nothing stops a debugger or an injected library attaching to it "
                + "later. Checked: signature valid, no debugger attached right now. "
                + "Not checked: who signed it, and whether it stays uncompromised."
        case .unsigned:
            return "\(subject) has no code signature the kernel accepts. "
                + "Checked: no debugger attached right now. "
                + "Not checked: everything else. Anything running as you could have replaced this file."
        case .interpretedScript:
            let runner = interpreter ?? "an interpreter"
            return "Nothing has been verified about the code running here. "
                + "\(subject) is a file on disk that \(runner) is executing, and any process running "
                + "as you can edit that file. \(runner)'s own signature is checked and says nothing "
                + "about it. Checked: the interpreter. Not checked: the code that actually decides "
                + "what happens."
        case .unknown:
            return "The kernel would not report this process's code-signing status, so nothing about "
                + "\(subject) has been checked either way. This is not a verdict, it is the absence "
                + "of one."
        }
    }
}

/// One line of evidence under a hop, drawn only once the chain is opened.
public struct HopEvidence: Equatable {
    /// The quiet word on the left: "program", "interpreter", "version".
    public let label: String
    public let value: String
    /// Paths are drawn monospaced and elided in the MIDDLE, so the tail (the
    /// package and the entry file, which is the identifying half) survives.
    public let isPath: Bool
    /// A posture mark at the end of the line, when this line is about something
    /// whose posture was checked.
    public let posture: HopPosture?
    /// What that mark is a claim about, for its tooltip.
    public let postureSubject: String?

    public init(
        label: String,
        value: String,
        isPath: Bool = false,
        posture: HopPosture? = nil,
        postureSubject: String? = nil
    ) {
        self.label = label
        self.value = value
        self.isPath = isPath
        self.posture = posture
        self.postureSubject = postureSubject
    }
}

/// Which build of a program is running, and how confident the daemon is of it.
///
/// A version on a security prompt is only worth drawing if the reader can tell
/// whether the machine established it or the caller merely said it, so the two
/// are different cases rather than one string with an asterisk.
public struct HopRelease: Equatable {
    public enum Source: Equatable {
        /// Read by the daemon off a file on disk that it resolved itself.
        case readFromDisk
        /// Sent over the socket by the client. A claim, and drawn as one.
        case clientReported
    }

    public let version: String
    public let source: Source

    public init(version: String, source: Source) {
        self.version = version
        self.source = source
    }

    /// Whether this is a build somebody made rather than one that was published.
    ///
    /// A `-dev` or `-canary` suffix is real signal on this panel: a development
    /// build is not the artifact the release pipeline produced and nobody can
    /// look up what is in it.
    public var isPrerelease: Bool { version.contains("-") }

    /// "1.17.1", or "1.17.1 (reported by the caller)".
    public var displayValue: String {
        switch source {
        case .readFromDisk: return version
        case .clientReported: return "\(version) (reported by the caller)"
        }
    }
}

/// One process in the chain.
public struct ExecutionHop: Equatable {
    public let pid: pid_t
    /// What the hop is called: a script's file name, an app's name, or the
    /// executable's own.
    public let name: String
    /// "via bun", when `name` is a script rather than the executable itself.
    public let via: String?
    /// Executable path, shown only when the chain is expanded.
    public let path: String?
    /// The script this hop is running, as a real file on disk, when the argument
    /// could be resolved to one. This is what the file's own icon is read from:
    /// asking the system about a path lets the registered handler answer, where
    /// asking about an extension gets whichever type claimed it first.
    public let scriptPath: String?
    /// The `.app` bundle this hop is, when it is one: the OUTERMOST enclosing
    /// one, so an Electron editor's nested helper is drawn as the editor. The
    /// panel turns it into the launcher's icon.
    public let bundlePath: String?
    /// The interpreter's own file name, when this hop's code is a script rather
    /// than an executable: "bun", "node".
    ///
    /// Set whether or not `via` is, and they are not the same decision. `via` is
    /// a DISPLAY choice ("varlock via bun" is noise on the resting row, so it is
    /// left off); this is the FACT, and the panel needs it wherever it makes a
    /// claim about what was checked, because the interpreter is the only part
    /// that was.
    public let interpreterName: String?
    /// Where that interpreter is, for the expanded detail.
    public let interpreterPath: String?
    /// The interpreter's own posture. Never this hop's: it is stated next to the
    /// interpreter's name, never on its own, so the verified thing and the claim
    /// about it can never drift apart on screen.
    public let interpreterPosture: HopPosture
    /// The version of the code running here, when it could be established, and
    /// where that answer came from.
    public let release: HopRelease?
    /// How this process was invoked, as the kernel has it: "varlock load".
    ///
    /// Set on the process that actually connected, and read from its argv rather
    /// than from anything it sent, which is what makes it worth showing next to
    /// the value names the client reported for itself.
    public let invocation: String?
    /// For a `varlock run`, the command this run will start and hand the values
    /// to. That process does not exist yet, so it is in no ancestry: naming it
    /// from argv is the only way the panel can say where the values are going.
    public let runTarget: String?
    public let posture: HopPosture
    /// The process that actually connected to the daemon.
    public let isRequester: Bool
    /// The app the user launched. Drawn small, at the top, with its icon.
    public let isLauncher: Bool
    /// The hop that decides what runs. Drawn large; everything else is quiet.
    public let isImportant: Bool
    /// Set on the hop the unlock's session identity is anchored to: the process a
    /// "this session" grant will actually attach to. Exactly one hop in a chain
    /// carries it, and it is where the session begins in the ancestry, so it is
    /// drawn there rather than as a note floating beside the chain.
    public let sessionRoot: SessionRootMark?
    /// Whether this hop is running inside the session rooted above it. The panel
    /// tints the rail for these, so "inside the session" is something you can see
    /// rather than something you work out.
    public let isInsideSession: Bool

    public init(
        pid: pid_t,
        name: String,
        via: String? = nil,
        path: String? = nil,
        scriptPath: String? = nil,
        bundlePath: String? = nil,
        interpreterName: String? = nil,
        interpreterPath: String? = nil,
        interpreterPosture: HopPosture = .unknown,
        release: HopRelease? = nil,
        invocation: String? = nil,
        runTarget: String? = nil,
        posture: HopPosture = .unknown,
        isRequester: Bool = false,
        isLauncher: Bool = false,
        isImportant: Bool = false,
        sessionRoot: SessionRootMark? = nil,
        isInsideSession: Bool = false
    ) {
        self.pid = pid
        self.name = name
        self.via = via
        self.path = path
        self.scriptPath = scriptPath
        self.bundlePath = bundlePath
        self.interpreterName = interpreterName
        self.interpreterPath = interpreterPath
        self.interpreterPosture = interpreterPosture
        self.release = release
        self.invocation = invocation
        self.runTarget = runTarget
        self.posture = posture
        self.isRequester = isRequester
        self.isLauncher = isLauncher
        self.isImportant = isImportant
        self.sessionRoot = sessionRoot
        self.isInsideSession = isInsideSession
    }

    /// Whether this hop is varlock itself, however it was started.
    public var isVarlock: Bool { ExecutionChainBuilder.isOwnCommand(name) }

    /// Whether this hop is a plain shell: plumbing that says how something was
    /// started rather than what is running.
    public var isShell: Bool { ExecutionChainBuilder.shellNames.contains(name) }

    /// Whether the session a grant attaches to begins here.
    public var isSessionRoot: Bool { sessionRoot != nil }

    /// The coding-agent session running at this hop, when it is one. Decoration
    /// on the session root row rather than the reason that row exists.
    public var agentSession: AgentSession? { sessionRoot?.agent }

    /// The one thing about this hop a person should know before approving.
    ///
    /// It sits under the hop it is about rather than in a legend at the bottom of
    /// the chain: a warning a reader has to match back up to a row is a warning
    /// that gets skipped.
    public var advisory: String? {
        guard posture == .interpretedScript, let via else { return nil }
        let interpreter = via.hasPrefix("via ") ? String(via.dropFirst(4)) : via
        return "a script run by \(interpreter): approval trusts this file, not the signed interpreter"
    }

    /// What this posture mark is a claim about, worded for a tooltip.
    public var postureSubject: String {
        if posture == .interpretedScript { return "The code at \u{201C}\(name)\u{201D}" }
        return "\u{201C}\(name)\u{201D}"
    }

    /// How varlock itself is running, in words, on the row that is varlock.
    ///
    /// `bunx varlock load` and `/opt/homebrew/bin/varlock load` both draw a row
    /// called "varlock", and they are not the same thing: one is a self-contained
    /// binary the kernel has a signature for, the other is ordinary JavaScript
    /// files any process running as the user can rewrite, executed by somebody
    /// else's signed interpreter. A reader should not have to work that out from
    /// a path, so the row says it.
    public var runtimeForm: String? {
        guard isVarlock else { return nil }
        guard let interpreterName else { return "the standalone varlock binary" }
        return "varlock's JavaScript, run by \(interpreterName), not the standalone binary"
    }

    /// Whether that line is the one that should read as a caution.
    public var runtimeFormIsCaution: Bool { isVarlock && interpreterName != nil }

    /// The lines drawn under this hop once the chain is opened: where the code
    /// is, what is running it, and which build it is.
    ///
    /// Paths used to be crammed into the right-hand end of the hop's own row,
    /// where they had a few dozen points to live in and truncated to things like
    /// "~/Libra\u{2026}2.1.234". Evidence you cannot read is not evidence, so it
    /// gets full-width lines of its own.
    public var evidence: [HopEvidence] {
        var lines: [HopEvidence] = []

        // The file whose contents decide what this hop does, named first.
        if let scriptPath {
            lines.append(HopEvidence(label: "program", value: scriptPath, isPath: true))
        } else if interpreterName != nil {
            // An interpreter with a script we could not resolve to a real file.
            // Saying so is better than leaving the row looking complete.
            lines.append(HopEvidence(label: "program", value: "could not be resolved to a file on disk"))
        } else if let path {
            lines.append(HopEvidence(label: isLauncher ? "bundle" : "program", value: path, isPath: true))
        }

        // The interpreter, and its posture stated right beside it. These two
        // never appear apart: the whole failure this replaces was a signature
        // shown without the name of what it was a signature of.
        if let interpreterName {
            lines.append(HopEvidence(
                label: "interpreter",
                value: interpreterPath ?? interpreterName,
                isPath: interpreterPath != nil,
                posture: interpreterPosture,
                postureSubject: "\u{201C}\(interpreterName)\u{201D}"
            ))
        }

        if let release {
            lines.append(HopEvidence(label: "version", value: release.displayValue))
        }

        if let agent = agentSession {
            lines.append(contentsOf: agent.evidence)
        }
        return lines
    }

    /// Hops that are neither the launcher, the actor, nor the root of a session:
    /// shells, wrappers, and varlock itself. Present for completeness, drawn
    /// small, and the first thing to fold away.
    ///
    /// A session root is never one of these. It is the answer to "which session
    /// am I granting to", which the panel is asking about in the same breath, and
    /// a fact that load-bearing does not go behind a disclosure.
    public var isMinor: Bool { !isImportant && !isLauncher && !isSessionRoot }
}

/// The session-root mark a hop can carry: what the session is called, and the
/// agent running it where there is one.
///
/// The label comes from the identifier the grant is scoped to, so the panel and
/// the menu bar call the same session by the same name.
public struct SessionRootMark: Equatable {
    /// "Terminal ttys004", "Process 4120", "Claude Code session".
    public let label: String
    /// How the identity was anchored, for anyone who needs to word it.
    public let kind: SessionAnchor.Kind
    /// The terminal this session is on, when it is on one, read back out of the
    /// same identifier. This row is the ONLY place a tty id is drawn: a
    /// controlling terminal is inherited, so naming it on a second row would be
    /// saying the same fact twice, and naming it on the app that was launched
    /// would be saying it where it is not even true.
    public let terminal: String?
    /// The coding-agent session rooted at this exact hop, when there is one.
    public let agent: AgentSession?

    public init(
        label: String,
        kind: SessionAnchor.Kind,
        terminal: String? = nil,
        agent: AgentSession? = nil
    ) {
        self.label = label
        self.kind = kind
        self.terminal = terminal
        self.agent = agent
    }

    /// The line under the session root's name.
    ///
    /// The session is always named here, because this is the row that answers
    /// "which session am I granting to" and the one place the chain states a
    /// tty. An agent's own title leads when it recorded one, since that is what
    /// tells two of its sessions apart, but it never replaces the name: a title
    /// is what somebody called a conversation, and the terminal is where it is.
    public var descriptionLine: String {
        guard let quoted = quotedTitle else { return label }
        return "\(quoted) \u{00B7} \(terminal ?? label)"
    }

    /// The session's own title as it is drawn: the prefix of `descriptionLine`
    /// the view sets in italics, so a name cannot be read as something varlock
    /// asserts.
    ///
    /// Quotation marks are reserved for a name a PERSON chose. Agents generate a
    /// name for every session from the directory they were opened in, and
    /// dressing that in quotes would present a machine's guess as somebody's
    /// words, on the one surface where the difference matters.
    public var quotedTitle: String? {
        guard let title = agent?.title, !title.isEmpty else { return nil }
        guard agent?.isTitleDerived != true else { return title }
        return "\u{201C}\(title)\u{201D}"
    }
}

/// A coding-agent session the chain is running inside.
///
/// Named by product, the session's own human title, and when it started. Never by
/// id: a uuid is not something a person can check against their own screen, and
/// the raw id is a machine's business that lives in the audit log.
public struct AgentSession: Equatable {
    public let productName: String
    /// What the agent itself calls this session. nil when it could not be read,
    /// which costs the row its title and nothing else.
    public let title: String?
    /// Whether the agent made that name up rather than the user typing it.
    public let isTitleDerived: Bool
    /// Seconds since the epoch: the agent's own record of when the session began
    /// where that is available, and the process start otherwise.
    public let startTime: Int?
    /// The agent's word for what kind of session this is. nil when it did not
    /// say, which is not the same as saying "not interactive".
    public let kind: String?
    /// Where the session is working. Cross-checked against the project being
    /// unlocked, because an agent in one project opening another project's
    /// secrets is exactly the anomaly this panel exists to surface.
    public let workingDirectory: String?
    public let entrypoint: String?
    public let version: String?

    public init(
        productName: String,
        title: String?,
        isTitleDerived: Bool = false,
        startTime: Int?,
        kind: String? = nil,
        workingDirectory: String? = nil,
        entrypoint: String? = nil,
        version: String? = nil
    ) {
        self.productName = productName
        self.title = title
        self.isTitleDerived = isTitleDerived
        self.startTime = startTime
        self.kind = kind
        self.workingDirectory = workingDirectory
        self.entrypoint = entrypoint
        self.version = version
    }

    /// The agent's own word for an attended session.
    public static let interactiveKind = "interactive"

    /// Said out loud on the session row when nobody is watching this agent.
    ///
    /// This is the single most decision-changing thing in the whole record. An
    /// interactive session has a person in front of it who will see what happens
    /// next; a print-mode or headless one does not, and "approve for this
    /// session" then means "approve for a program running unattended".
    ///
    /// Only ever said on positive evidence. A record with no `kind` gets no line,
    /// because "the agent did not say" and "no human is watching" are different
    /// facts and only one of them is worth an alarm.
    public var unattendedNote: String? {
        guard let kind, kind != Self.interactiveKind else { return nil }
        return "a \(kind) session: no person is watching this agent"
    }

    /// The evidence lines this session contributes once the chain is opened.
    public var evidence: [HopEvidence] {
        var lines: [HopEvidence] = []
        if let workingDirectory {
            lines.append(HopEvidence(label: "working dir", value: workingDirectory, isPath: true))
        }
        if let build = buildLine {
            lines.append(HopEvidence(label: "agent", value: build))
        }
        if isTitleDerived, title != nil {
            lines.append(HopEvidence(label: "name", value: "generated by \(productName), not typed by you"))
        }
        return lines
    }

    /// "Claude Code 2.1.234, started from claude-desktop".
    private var buildLine: String? {
        switch (version, entrypoint) {
        case (let version?, let entrypoint?): return "\(productName) \(version), started from \(entrypoint)"
        case (let version?, nil): return "\(productName) \(version)"
        case (nil, let entrypoint?): return "\(productName), started from \(entrypoint)"
        default: return nil
        }
    }
}

/// The whole chain, launcher first, the process that connected last.
public struct ExecutionChain: Equatable {
    public let hops: [ExecutionHop]

    public init(hops: [ExecutionHop]) {
        self.hops = hops
    }

    public static let empty = ExecutionChain(hops: [])

    /// What the host process was running, when varlock was loaded by one rather
    /// than run by a person.
    ///
    /// An auto-load spawns the same CLI a person would, so the useful line is not
    /// varlock's own internal command but the command it was loaded inside: the
    /// nearest thing above it that is not varlock.
    public var hostInvocation: String? {
        if let hostProgram { return hostProgram.invocation }
        guard let requesterIndex = hops.firstIndex(where: { $0.isRequester }) else { return nil }
        // Nothing but shells above: they answer only when there is nothing else
        // to point at.
        return hops[..<requesterIndex].reversed().first { !$0.isVarlock && !$0.isLauncher }?.invocation
    }

    /// The program that could have loaded varlock: the nearest hop above the
    /// requester that is neither a shell, nor varlock, nor the app that was
    /// launched.
    ///
    /// This is the kernel's half of the auto-load question. The mode itself is
    /// client-reported (a spawned CLI looks the same either way from inside), but
    /// whether anything up there could have done the spawning is a fact, and a
    /// claim that contradicts it does not get to stand.
    public var hostProgram: ExecutionHop? {
        guard let requesterIndex = hops.firstIndex(where: { $0.isRequester }) else { return nil }
        return hops[..<requesterIndex].reversed().first {
            !$0.isVarlock && !$0.isLauncher && !$0.isShell
        }
    }

    /// The hop a coding-agent session begins at, when the request came from one.
    public var sessionRootHop: ExecutionHop? {
        return hops.first { $0.isSessionRoot }
    }

    /// That session, for anything that only needs to know which one it was.
    public var agentSession: AgentSession? {
        return sessionRootHop?.agentSession
    }

    public var isEmpty: Bool { hops.isEmpty }

    /// How many hops the panel shows before it starts folding the boring ones
    /// away. Four fits without the chain becoming the whole panel.
    public static let collapseThreshold = 4

    /// Whether the resting panel folds this chain's minor hops away.
    public var collapsesWhenResting: Bool {
        return hops.count >= Self.collapseThreshold && !collapsibleHops.isEmpty
    }

    /// The hops folded away at rest: everything that is neither the launcher nor
    /// the actor. The two that carry meaning always stay on screen.
    public var collapsibleHops: [ExecutionHop] {
        return hops.filter { $0.isMinor }
    }

    /// What the chain shows at rest.
    public var restingHops: [ExecutionHop] {
        return collapsesWhenResting ? hops.filter { !$0.isMinor } : hops
    }

    /// "2 more steps (zsh, varlock)", or nil when nothing is folded away.
    public var expanderLabel: String? {
        guard collapsesWhenResting else { return nil }
        let folded = collapsibleHops
        let names = folded.map { $0.name }.joined(separator: ", ")
        let count = folded.count == 1 ? "1 more step" : "\(folded.count) more steps"
        return "\(count) (\(names))"
    }
}
