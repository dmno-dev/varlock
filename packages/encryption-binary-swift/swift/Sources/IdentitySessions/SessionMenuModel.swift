import Foundation
import SessionScoping

/// What the menu bar shows about the sessions the daemon is holding.
///
/// Every string the menu draws is decided here, with no AppKit anywhere, so the
/// wording and grouping are unit tested and `StatusBarMenu` is left with nothing
/// but turning rows into `NSMenuItem`s.
///
/// Times are coarse on purpose. The menu is rebuilt when it opens, not on a
/// timer, so a live countdown would be a lie the moment it was drawn; "9h left"
/// stays true for an hour.
public struct SessionMenuModel: Equatable {

    /// One granted key inside a session.
    public struct KeyRow: Equatable {
        public let keyId: String
        public let scopeLabel: String
        public let remainingLabel: String

        /// "varlock-default: this session, 9h left"
        public var title: String {
            return "\(keyId): \(scopeLabel), \(remainingLabel)"
        }
    }

    /// One unlocked session.
    public struct SessionRow: Equatable {
        public let sessionId: String
        /// "Terminal ttys004"
        public let title: String
        public let keys: [KeyRow]
        /// "12h limit: 9h left"
        public let capLine: String
        /// "Locks on sleep"
        public let lockLine: String
    }

    public let rows: [SessionRow]

    public var sessionCount: Int { return rows.count }
    public var isEmpty: Bool { return rows.isEmpty }

    /// Group live grants into one row per session, keeping the order the grant
    /// table produced (oldest session first, keys sorted within a session).
    public static func build(from grants: [SessionGrantInfo]) -> SessionMenuModel {
        var order: [String] = []
        var bySession: [String: [SessionGrantInfo]] = [:]
        for grant in grants {
            if bySession[grant.sessionId] == nil {
                order.append(grant.sessionId)
                bySession[grant.sessionId] = []
            }
            bySession[grant.sessionId]?.append(grant)
        }

        let rows: [SessionRow] = order.compactMap { sessionId in
            guard let sessionGrants = bySession[sessionId], let first = sessionGrants.first else { return nil }
            return SessionRow(
                sessionId: sessionId,
                title: SessionLabel.describe(sessionId: sessionId),
                keys: sessionGrants.map {
                    KeyRow(
                        keyId: $0.keyId,
                        scopeLabel: scopeLabel($0.scope),
                        remainingLabel: coarseRemaining($0.remainingMs)
                    )
                },
                capLine: "\(capHours)h limit: \(coarseRemaining(first.sessionRemainingMs))",
                lockLine: lockLine(first.lockOn)
            )
        }
        return SessionMenuModel(rows: rows)
    }

    // MARK: - Wording

    private static var capHours: Int64 { return SessionGrantTable.maxGrantMs / (60 * 60 * 1000) }

    public static func scopeLabel(_ scope: SessionGrantScope) -> String {
        switch scope {
        case .once: return "single use"
        case .session: return "this session"
        case .duration: return "timed"
        }
    }

    /// Rounded down, so the menu never claims more time than there is.
    public static func coarseRemaining(_ milliseconds: Int64) -> String {
        guard milliseconds > 0 else { return "expired" }
        let minutes = milliseconds / 60_000
        if minutes >= 60 {
            return "\(minutes / 60)h left"
        }
        if minutes >= 1 {
            return "\(minutes)m left"
        }
        return "under a minute left"
    }

    public static func lockLine(_ policy: SessionLockPolicy) -> String {
        switch policy {
        case .screenLock: return "Locks on screen lock"
        case .sleep: return "Locks on sleep"
        case .never: return "Stays unlocked until it expires"
        }
    }

    /// The label the "lock sessions on" setting uses for each choice.
    public static func lockPolicyMenuLabel(_ policy: SessionLockPolicy) -> String {
        switch policy {
        case .screenLock: return "Screen lock"
        case .sleep: return "Sleep"
        case .never: return "Only manually"
        }
    }
}
