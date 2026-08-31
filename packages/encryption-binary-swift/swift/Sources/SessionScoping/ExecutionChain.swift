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

    /// Whether this posture is worth a legend line at the bottom of the chain.
    public var needsExplaining: Bool { self == .interpretedScript }
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
    /// The `.app` bundle this hop is, when it is one. The panel turns it into
    /// the launcher's icon.
    public let bundlePath: String?
    /// Controlling terminal, on the hop that has one.
    public let terminalName: String?
    public let posture: HopPosture
    /// The app the user launched. Drawn small, at the top, with its icon.
    public let isLauncher: Bool
    /// The hop that decides what runs. Drawn large; everything else is quiet.
    public let isImportant: Bool

    public init(
        pid: pid_t,
        name: String,
        via: String? = nil,
        path: String? = nil,
        bundlePath: String? = nil,
        terminalName: String? = nil,
        posture: HopPosture = .unknown,
        isLauncher: Bool = false,
        isImportant: Bool = false
    ) {
        self.pid = pid
        self.name = name
        self.via = via
        self.path = path
        self.bundlePath = bundlePath
        self.terminalName = terminalName
        self.posture = posture
        self.isLauncher = isLauncher
        self.isImportant = isImportant
    }

    /// Hops that are neither the launcher nor the actor: shells, wrappers, and
    /// varlock itself. Present for completeness, drawn small, first to collapse.
    public var isMinor: Bool { !isImportant && !isLauncher }
}

/// A coding-agent session the chain is running inside.
///
/// Named by product and start time rather than by id: "Claude Code session,
/// started 2:14 PM" is what a person can check against their own screen. The raw
/// session id is a machine's business and lives in the audit log.
public struct AgentSessionBadge: Equatable {
    public let productName: String
    public let pid: pid_t
    /// Seconds since the epoch, as the kernel reported the process's start.
    public let startTime: Int?

    public init(productName: String, pid: pid_t, startTime: Int?) {
        self.productName = productName
        self.pid = pid
        self.startTime = startTime
    }
}

/// The whole chain, launcher first, the process that connected last.
public struct ExecutionChain: Equatable {
    public let hops: [ExecutionHop]
    public let agentSession: AgentSessionBadge?

    public init(hops: [ExecutionHop], agentSession: AgentSessionBadge? = nil) {
        self.hops = hops
        self.agentSession = agentSession
    }

    public static let empty = ExecutionChain(hops: [])

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

    /// The legend for the posture marks, built from what this chain actually
    /// contains, so the panel never explains a badge it did not draw.
    public var postureNote: String? {
        var parts: [String] = []
        if let interpreted = hops.first(where: { $0.posture == .interpretedScript }), let via = interpreted.via {
            let interpreter = via.hasPrefix("via ") ? String(via.dropFirst(4)) : via
            parts.append(
                "\(interpreter) is running a script: the actor is \(interpreted.name), "
                + "not the signed interpreter"
            )
        }
        if hops.contains(where: { $0.posture == .signedHardened }) {
            parts.append("signed and hardened")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }
}
