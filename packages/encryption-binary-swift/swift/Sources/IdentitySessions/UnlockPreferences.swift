import Foundation

/// What this Mac remembers about how you answer an unlock panel.
///
/// It remembers ONE thing: that you tightened a request. That is the whole
/// feature, and the reason it is safe.
///
/// The default is already broad (the whole key, for this session), so a broad
/// answer is not worth writing down: replaying it would change nothing. A narrow
/// answer is worth writing down, because otherwise the panel springs back to the
/// broad default next time and quietly undoes a decision somebody made on
/// purpose. Since a memory can only ever move the preselection inwards, a stale
/// or mismatched one costs an extra panel and nothing else, which is why this
/// needs no invalidation matrix over requesters, session roots and postures: it
/// has no failure mode worth defending against.
///
/// Choosing the broad default again is how you forget. That is not a
/// convenience, it is the design: an answer that cannot be taken back is an
/// answer people stop giving.
///
/// It lives under the user's varlock directory, never in a project file. What a
/// machine will hand over is the machine's business, and a preference committed
/// to a repository is a preference anybody who can open a pull request gets to
/// set.

/// One remembered narrowing, keyed by project and key id.
public struct UnlockNarrowing: Equatable {
    /// Set only when the user chose the narrow breadth. Never `wholeKey`.
    public var breadth: SessionGrantBreadth?
    /// Set only when the user chose something shorter than a session.
    public var window: GrantWindow?
    /// Whether this project and key have ever been approved on this Mac.
    ///
    /// Kept here because it is the same fact about the same pair, and because
    /// its absence is the safe direction: a first sighting reads as elevated
    /// risk and preselects something narrower.
    public var approvedBefore: Bool
    /// epoch ms, so a person reading the file can tell when this was decided
    public var savedAt: Int64

    public init(
        breadth: SessionGrantBreadth? = nil,
        window: GrantWindow? = nil,
        approvedBefore: Bool = false,
        savedAt: Int64 = 0
    ) {
        self.breadth = breadth
        self.window = window
        self.approvedBefore = approvedBefore
        self.savedAt = savedAt
    }

    /// Whether there is anything here worth keeping a row for.
    public var isEmpty: Bool { breadth == nil && window == nil && !approvedBefore }
}

/// Reading and writing the file, with no file system in sight.
///
/// Everything is a pure function of `Data`, so the rules can be tested without a
/// home directory and the daemon side is a read, a call, and a write.
public enum UnlockPreferences {
    /// Under the user varlock dir, beside the identities and the audit log.
    public static let fileName = "unlock-preferences.json"
    public static let fileVersion = 1

    /// How a row is addressed: the project it was decided in, and the key.
    ///
    /// The project is the client's own `projectPath`, which is a claim like
    /// everything else it sends. It cannot be used to widen anything (the only
    /// thing a row can do is narrow), so the worst a wrong one can do is fail to
    /// find a narrowing that exists, which costs a broader preselection than the
    /// user last chose. That is the one direction worth being careful about, so
    /// a request with no project path is not remembered at all rather than
    /// sharing one nameless bucket across every project on the machine.
    public static func rowKey(projectPath: String?, keyId: String) -> String? {
        guard let projectPath, !projectPath.isEmpty else { return nil }
        return "\(projectPath)\u{0000}\(keyId)"
    }

    // MARK: - Codec

    public static func decode(_ data: Data?) -> [String: UnlockNarrowing] {
        guard let data, !data.isEmpty else { return [:] }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        guard (json["version"] as? NSNumber)?.intValue == fileVersion else { return [:] }
        guard let rows = json["projects"] as? [String: Any] else { return [:] }

        var out: [String: UnlockNarrowing] = [:]
        for (key, raw) in rows {
            guard let raw = raw as? [String: Any] else { continue }
            let scope = SessionGrantScope(wireValue: raw["scope"] as? String)
            let window = scope.map {
                GrantWindow(scope: $0, durationMs: (raw["durationMs"] as? NSNumber)?.int64Value)
            }
            let entry = UnlockNarrowing(
                // Only a narrowing is ever honoured, whatever the file says. A
                // hand-edited "key" here must not be able to widen a panel.
                breadth: SessionGrantBreadth(wireValue: raw["breadth"] as? String) == .listedItems
                    ? .listedItems
                    : nil,
                window: window.flatMap { $0.scope == .session ? nil : $0 },
                approvedBefore: (raw["approvedBefore"] as? NSNumber)?.boolValue ?? false,
                savedAt: (raw["savedAt"] as? NSNumber)?.int64Value ?? 0
            )
            if !entry.isEmpty { out[key] = entry }
        }
        return out
    }

    public static func encode(_ rows: [String: UnlockNarrowing]) -> Data? {
        var projects: [String: Any] = [:]
        for (key, entry) in rows where !entry.isEmpty {
            var row: [String: Any] = ["approvedBefore": entry.approvedBefore, "savedAt": entry.savedAt]
            if let breadth = entry.breadth { row["breadth"] = breadth.rawValue }
            if let window = entry.window {
                row["scope"] = window.scope.rawValue
                if let durationMs = window.durationMs { row["durationMs"] = durationMs }
            }
            projects[key] = row
        }
        let json: [String: Any] = ["version": fileVersion, "projects": projects]
        return try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
    }

    // MARK: - Rules

    /// What to keep after an approval, given what the user actually chose.
    ///
    /// Only the axes they tightened are written down. An axis they left at the
    /// default clears whatever was remembered for it, which is what makes
    /// choosing the default the way to forget.
    public static func remembering(
        breadth: SessionGrantBreadth,
        window: GrantWindow,
        now: Int64
    ) -> UnlockNarrowing {
        return UnlockNarrowing(
            breadth: breadth == UnlockDefaults.breadth ? nil : breadth,
            window: window.scope == UnlockDefaults.window.scope ? nil : window,
            approvedBefore: true,
            savedAt: now
        )
    }

    /// Fold one approval into the whole file.
    public static func apply(
        rows: [String: UnlockNarrowing],
        rowKey: String?,
        breadth: SessionGrantBreadth,
        window: GrantWindow,
        now: Int64
    ) -> [String: UnlockNarrowing] {
        guard let rowKey else { return rows }
        var next = rows
        let entry = remembering(breadth: breadth, window: window, now: now)
        if entry.isEmpty {
            next.removeValue(forKey: rowKey)
        } else {
            next[rowKey] = entry
        }
        return next
    }

    /// Drop rows. No arguments forgets everything; a project forgets that
    /// project; both forget one key in one project.
    public static func forget(
        rows: [String: UnlockNarrowing],
        projectPath: String? = nil,
        keyId: String? = nil
    ) -> (rows: [String: UnlockNarrowing], forgotten: Int) {
        guard projectPath != nil || keyId != nil else { return ([:], rows.count) }
        var next: [String: UnlockNarrowing] = [:]
        var forgotten = 0
        for (key, entry) in rows {
            let parts = key.components(separatedBy: "\u{0000}")
            let rowProject = parts.first ?? ""
            let rowKeyId = parts.count > 1 ? parts[1] : ""
            let projectMatches = projectPath == nil || projectPath == rowProject
            let keyMatches = keyId == nil || keyId == rowKeyId
            if projectMatches && keyMatches {
                forgotten += 1
            } else {
                next[key] = entry
            }
        }
        return (next, forgotten)
    }
}
