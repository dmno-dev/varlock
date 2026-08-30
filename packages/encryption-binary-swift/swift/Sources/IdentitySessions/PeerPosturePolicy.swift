import Foundation
import SessionScoping

/// What the daemon does about a peer that fails a posture check.
///
/// Deliberately two-valued. A check that is off entirely is a check nobody
/// notices has stopped working, so the weaker setting still says something on
/// stderr every time it fires.
public enum PostureSeverity: Equatable {
    /// Refuse the connection.
    case reject
    /// Serve the connection, and say on stderr that it should not have been
    /// necessary.
    case warn
}

/// A posture check that a peer did not pass.
public enum PeerPostureViolation: Equatable {
    /// A debugger or tracer is attached to the peer right now.
    case debuggerAttached
    /// The peer is not running with Hardened Runtime, so nothing stops a
    /// debugger or an injected library from attaching to it later.
    case hardenedRuntimeMissing
    /// The kernel would not say, so neither of the above could be checked.
    case postureUnreadable

    /// Stable code, so a client can branch without matching message text.
    public var code: String {
        switch self {
        case .debuggerAttached: return "PEER_DEBUGGER_ATTACHED"
        case .hardenedRuntimeMissing: return "PEER_HARDENED_RUNTIME_MISSING"
        case .postureUnreadable: return "PEER_POSTURE_UNREADABLE"
        }
    }

    /// What the client is told. Short, and it names the fix.
    public var clientMessage: String {
        switch self {
        case .debuggerAttached:
            return "Refusing to serve a process that is being debugged or traced; detach the debugger and try again"
        case .hardenedRuntimeMissing:
            return "Refusing to serve a process that is not running with the Hardened Runtime; "
                + "use an official varlock, node, or bun build"
        case .postureUnreadable:
            return "Could not read the calling process's code-signing status, so it was refused"
        }
    }

    /// One line per check, so which one fired is obvious in the daemon's log.
    public func stderrLine(pid: pid_t, path: String, severity: PostureSeverity) -> String {
        let verb = severity == .reject ? "rejected" : "allowed (posture warning only)"
        switch self {
        case .debuggerAttached:
            return "varlock: \(verb) IPC connection: the calling process is being debugged or traced "
                + "(pid=\(pid), path=\(path))\n"
        case .hardenedRuntimeMissing:
            return "varlock: \(verb) IPC connection: the calling process is not running with the "
                + "Hardened Runtime (pid=\(pid), path=\(path))\n"
        case .postureUnreadable:
            return "varlock: \(verb) IPC connection: the calling process's code-signing status could "
                + "not be read (pid=\(pid), path=\(path))\n"
        }
    }
}

/// How hard each posture check bites.
///
/// Two knobs rather than one switch, because the two checks are not equally safe
/// to enforce. See `resolve` for what each build actually gets.
public struct PeerPostureRequirements: Equatable {
    public let debugger: PostureSeverity
    /// Also governs `postureUnreadable`: both mean "cannot show this process is
    /// hard to get into", one because it is not, one because nobody could tell.
    public let hardenedRuntime: PostureSeverity

    public init(debugger: PostureSeverity, hardenedRuntime: PostureSeverity) {
        self.debugger = debugger
        self.hardenedRuntime = hardenedRuntime
    }

    /// Everything rejects. What `sessions.peerPosture: "strict"` asks for.
    public static let strict = PeerPostureRequirements(debugger: .reject, hardenedRuntime: .reject)

    /// Nothing rejects, everything is reported.
    public static let warnOnly = PeerPostureRequirements(debugger: .warn, hardenedRuntime: .warn)

    /// The default for a signed release daemon.
    ///
    /// A traced peer is rejected: there is no legitimate reason for a process to
    /// be under a debugger while asking this daemon for secrets, and the check has
    /// no false positives to speak of.
    ///
    /// A peer without Hardened Runtime is reported and served. That check is
    /// correct in principle and unshippable as a rejection today, because the
    /// processes that legitimately connect are frequently not hardened: the
    /// standalone `varlock` binary is ad-hoc signed by `bun build --compile`, and
    /// Homebrew's node and bun are ad-hoc signed too. Rejecting would lock those
    /// users out of their own secrets to close a hole that only matters once
    /// somebody already has code running as them. It flips to `.reject` here once
    /// the release pipeline signs the CLI with `--options runtime`; anyone whose
    /// clients are all hardened can have that today with
    /// `sessions.peerPosture: "strict"`.
    public static let signedRelease = PeerPostureRequirements(debugger: .reject, hardenedRuntime: .warn)

    /// The default for a development daemon, which is any daemon whose own binary
    /// is not running hardened.
    ///
    /// A daemon that is not hardened itself is in no position to demand it of
    /// anyone, and this is also the shape of a working tree: `swift build` output
    /// is ad-hoc signed, and it is normally being driven by processes a developer
    /// may well have a debugger on. So the checks run and report, and nothing is
    /// refused. This is the same allowance the peer binary-name check already
    /// makes for `node` and `bun`, kept in one place.
    public static let development = warnOnly
}

/// The answer for one peer.
public struct PeerPostureOutcome: Equatable {
    /// The check that refused the connection, if any. First one wins.
    public let rejection: PeerPostureViolation?
    /// Checks that failed but were configured only to report.
    public let warnings: [PeerPostureViolation]

    public var isAllowed: Bool { return rejection == nil }

    public static let clean = PeerPostureOutcome(rejection: nil, warnings: [])
}

public enum PeerPostureEvaluator {
    /// Key path into the machine config file:
    /// `{ "sessions": { "peerPosture": "strict" } }`
    public static let configSectionKey = "sessions"
    public static let configFieldKey = "peerPosture"

    /// Wire values for `sessions.peerPosture`.
    public static let configValues = ["default", "strict", "warn"]

    /// Judge one peer.
    ///
    /// The debugger check is answered first: when a debugger is attached, that is
    /// the interesting fact, and saying "no Hardened Runtime" instead would send
    /// the reader after the wrong thing.
    public static func evaluate(
        facts: PeerPostureFacts,
        requirements: PeerPostureRequirements
    ) -> PeerPostureOutcome {
        var failed: [(PeerPostureViolation, PostureSeverity)] = []

        if !facts.isReadable {
            failed.append((.postureUnreadable, requirements.hardenedRuntime))
        } else {
            if facts.isTraced {
                failed.append((.debuggerAttached, requirements.debugger))
            }
            if !facts.hasHardenedRuntime {
                failed.append((.hardenedRuntimeMissing, requirements.hardenedRuntime))
            }
        }

        let rejection = failed.first { $0.1 == .reject }?.0
        let warnings = failed.filter { $0.1 == .warn }.map(\.0)
        return PeerPostureOutcome(rejection: rejection, warnings: warnings)
    }

    /// What this daemon demands of its peers.
    ///
    /// The starting point is the daemon's own hardening, not a build flag in its
    /// Info.plist: a plist can be edited by anyone who can reach the bundle, while
    /// the code-signing status word cannot be. The config file may then move it,
    /// in either direction.
    public static func resolve(
        selfFacts: PeerPostureFacts,
        machineConfigData: Data?,
        warn: (String) -> Void = { message in fputs("varlock: \(message)\n", stderr) }
    ) -> PeerPostureRequirements {
        let base: PeerPostureRequirements = selfFacts.hasHardenedRuntime ? .signedRelease : .development

        guard let raw = configValue(fromConfigData: machineConfigData, warn: warn) else { return base }
        switch raw {
        case "strict": return .strict
        case "warn": return .warnOnly
        case "default": return base
        default:
            warn(
                "ignoring invalid config \(configSectionKey).\(configFieldKey) value \"\(raw)\"; expected one of "
                    + configValues.map { "\"\($0)\"" }.joined(separator: ", ")
            )
            return base
        }
    }

    private static func configValue(
        fromConfigData data: Data?,
        warn: (String) -> Void
    ) -> String? {
        guard let data, !data.isEmpty else { return nil }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            warn("could not parse the varlock config file; ignoring it for peer posture settings")
            return nil
        }
        guard let sessions = json[configSectionKey] as? [String: Any] else { return nil }
        guard let value = sessions[configFieldKey] else { return nil }
        guard let string = value as? String else {
            warn("ignoring non-string config \(configSectionKey).\(configFieldKey) value")
            return nil
        }
        return string
    }
}
