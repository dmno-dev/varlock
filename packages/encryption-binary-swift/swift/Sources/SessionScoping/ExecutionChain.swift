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

/// What the daemon can say about one hop's own hardening.
public enum HopPosture: Equatable {
    /// Signed, with the hardened runtime. The strongest thing we can say.
    case signedHardened
    /// Signed, but without the hardened runtime, or not signed at all. Not an
    /// accusation: plenty of legitimate tools ship this way.
    case unhardened
    /// An interpreter running a script. The signature belongs to the
    /// interpreter, and the script it is running is the part that decides what
    /// happens, so the signature says nothing about the actor.
    case interpretedScript
    /// Nothing could be read. Drawn as neutral, never as either answer.
    case unknown

    /// The word that goes next to the mark once the chain is opened.
    ///
    /// Only for what we actually checked. There is no word for "unhardened" or
    /// "unknown", because a hop the daemon could not vouch for should read as
    /// unremarked rather than as accused.
    public var inlineLabel: String? {
        return self == .signedHardened ? "signed" : nil
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
    /// The `.app` bundle this hop is, when it is one: the OUTERMOST enclosing
    /// one, so an Electron editor's nested helper is drawn as the editor. The
    /// panel turns it into the launcher's icon.
    public let bundlePath: String?
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
        bundlePath: String? = nil,
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
        self.bundlePath = bundlePath
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

    /// The agent's own words, in quotes: the prefix of `descriptionLine` the view
    /// sets in italics so a title cannot be read as something varlock asserts.
    public var quotedTitle: String? {
        guard let title = agent?.title, !title.isEmpty else { return nil }
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
    /// Seconds since the epoch: the agent's own record of when the session began
    /// where that is available, and the process start otherwise.
    public let startTime: Int?

    public init(productName: String, title: String?, startTime: Int?) {
        self.productName = productName
        self.title = title
        self.startTime = startTime
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
