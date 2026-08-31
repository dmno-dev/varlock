import Foundation
import Darwin

/// What a coding agent recorded about the session a request came from.
///
/// The panel wants to say "Claude Code, 'vault panel redesign', started 2:14 PM",
/// because that is a sentence a person can check against the window they were
/// just looking at. A uuid is not, so none is ever shown; the raw id stays in the
/// audit log where a machine reads it.
///
/// The agent writes this itself, so reading it is a same-user file read of a file
/// that is already on disk. It is display only: a missing, stale, or unparseable
/// file costs the row its title and nothing else.

/// The coding agents the panel knows how to name.
public enum AgentProduct: String, Equatable, CaseIterable {
    case claudeCode
    case codex

    public var displayName: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .codex: return "Codex"
        }
    }
}

public struct AgentSessionMetadata: Equatable {
    /// The session's own human name.
    public let title: String?
    /// When the agent says the session began, in seconds since the epoch.
    public let startTime: Int?

    public init(title: String?, startTime: Int?) {
        self.title = title
        self.startTime = startTime
    }
}

/// Looks up a session's own record of itself. Behind a protocol so the chain can
/// be built in tests without a home directory full of agent state.
public protocol AgentSessionMetadataReader {
    /// - Parameters:
    ///   - product: which agent this is.
    ///   - pid: the process the daemon identified as the session's root.
    ///   - processStartTime: when the kernel says that process started, used to
    ///     reject a record left behind by a different process with the same pid.
    func metadata(for product: AgentProduct, pid: pid_t, processStartTime: Int) -> AgentSessionMetadata?
}

/// Reads the agents' own on-disk session records.
public struct LiveAgentSessionMetadataReader: AgentSessionMetadataReader {
    /// A record bigger than this is not the small json file we are looking for,
    /// and is not worth reading to find out.
    static let maxFileBytes = 64 * 1024

    /// How far the recorded start may be from the kernel's view of the process
    /// start before the record is treated as belonging to a different process.
    /// Pids are reused, and a stale file would name somebody else's session.
    static let startTimeToleranceSeconds = 300

    private let homeDirectory: String

    public init(homeDirectory: String = NSHomeDirectory()) {
        self.homeDirectory = homeDirectory
    }

    public func metadata(
        for product: AgentProduct,
        pid: pid_t,
        processStartTime: Int
    ) -> AgentSessionMetadata? {
        switch product {
        case .claudeCode:
            return claudeCodeMetadata(pid: pid, processStartTime: processStartTime)
        case .codex:
            // Codex keys its rollout files by timestamp and working directory, not
            // by pid, so tying one to a live process would mean picking the most
            // recent file that looks close enough. A guess is worse than no title
            // here: naming the wrong session is exactly the mistake this panel
            // exists to prevent. Detection and the start time still work.
            return nil
        }
    }

    /// Claude Code writes `~/.claude/sessions/<pid>.json` for each live session,
    /// carrying the session's name and when it started.
    private func claudeCodeMetadata(pid: pid_t, processStartTime: Int) -> AgentSessionMetadata? {
        let path = "\(homeDirectory)/.claude/sessions/\(pid).json"
        guard let record = readJsonObject(atPath: path) else { return nil }

        // The record has to be about the process we are looking at. Both checks
        // are cheap and both matter: pids are reused, and a session that ended
        // may leave its file behind.
        if let recordedPid = (record["pid"] as? NSNumber)?.int32Value, recordedPid != pid {
            return nil
        }
        let startedAtMs = (record["startedAt"] as? NSNumber)?.doubleValue
        let startedAt = startedAtMs.map { Int($0 / 1000) }
        if let startedAt, processStartTime > 0,
           abs(startedAt - processStartTime) > Self.startTimeToleranceSeconds {
            return nil
        }

        return AgentSessionMetadata(
            title: Self.humanTitle(record["name"]),
            startTime: startedAt
        )
    }

    private func readJsonObject(atPath path: String) -> [String: Any]? {
        let url = URL(fileURLWithPath: path)
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let size = (attributes[.size] as? NSNumber)?.intValue,
              size > 0, size <= Self.maxFileBytes else { return nil }
        guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// A title worth showing: trimmed, short enough to draw, and never a uuid.
    ///
    /// Agents fall back to the session id when they have nothing better, and an
    /// id on the panel is noise a person cannot check anything against.
    static func humanTitle(_ value: Any?) -> String? {
        guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty, !looksLikeIdentifier(text) else { return nil }
        let flattened = text.components(separatedBy: .newlines).joined(separator: " ")
        return String(flattened.prefix(64))
    }

    static func looksLikeIdentifier(_ text: String) -> Bool {
        // A uuid, with or without its dashes.
        let stripped = text.replacingOccurrences(of: "-", with: "")
        guard stripped.count == 32 else { return false }
        return stripped.allSatisfy { $0.isHexDigit }
    }
}
