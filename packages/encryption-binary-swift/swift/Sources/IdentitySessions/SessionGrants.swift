import Foundation

/// Grant bookkeeping for identity-backed sessions.
///
/// A grant is what makes the daemon's holding of an identity key legitimate. It is
/// keyed by (sessionId x keyId): the same session unlocking a different key is a
/// separate grant, and the same key in a different session is too. `sessionId` comes
/// from `SessionScoping`, so a grant cannot be borrowed by an unrelated session on
/// the same machine.
///
/// This type is pure bookkeeping with an injected clock, so the lifetime rules are
/// unit testable without an enclave. Key material lives in `IdentitySessionStore`
/// on the daemon side, which drives its erase decisions off what this table reports.

public enum SessionGrantScope: String, CaseIterable {
    /// a single decrypt call, then the grant is spent
    case once
    /// until the session it is bound to ends, or the cap is hit
    case session
    /// a caller-chosen window, still bounded by the cap
    case duration

    public init?(wireValue: String?) {
        guard let wireValue else { return nil }
        self.init(rawValue: wireValue)
    }
}

/// Identifies one grant.
public struct SessionGrantRef: Hashable {
    public let sessionId: String
    public let keyId: String

    public init(sessionId: String, keyId: String) {
        self.sessionId = sessionId
        self.keyId = keyId
    }
}

/// A grant as the daemon reports it back. Never includes key material.
public struct SessionGrantInfo: Equatable {
    public let sessionId: String
    public let keyId: String
    public let identityId: String
    public let scope: SessionGrantScope
    /// epoch ms
    public let grantedAt: Int64
    /// epoch ms; always set, since every scope is capped
    public let expiresAt: Int64
    /// epoch ms of the last decrypt this grant served, nil until first use
    public let lastUsedAt: Int64?
    /// epoch ms when the session this grant belongs to was unlocked
    public let sessionUnlockedAt: Int64
    /// epoch ms when the session's hard cap runs out
    public let sessionExpiresAt: Int64
    /// how many decrypts this grant has served
    public let useCount: Int

    public func toDictionary(now: Int64) -> [String: Any] {
        var dict: [String: Any] = [
            "sessionId": sessionId,
            "keyId": keyId,
            "identityId": identityId,
            "scope": scope.rawValue,
            "grantedAt": grantedAt,
            "expiresAt": expiresAt,
            "sessionUnlockedAt": sessionUnlockedAt,
            "sessionExpiresAt": sessionExpiresAt,
            "useCount": useCount,
            "expiresInMs": max(0, expiresAt - now),
        ]
        if let lastUsedAt {
            dict["lastUsedAt"] = lastUsedAt
        }
        return dict
    }
}

public enum SessionGrantError: LocalizedError {
    case noGrant(SessionGrantRef)
    case expired(SessionGrantRef)

    public var errorDescription: String? {
        switch self {
        case .noGrant(let ref):
            return "No unlock session for key \"\(ref.keyId)\"; run an unlock first"
        case .expired(let ref):
            return "The unlock session for key \"\(ref.keyId)\" has expired; unlock again"
        }
    }

    /// Stable code the TS client can branch on without matching message text.
    public var code: String {
        switch self {
        case .noGrant: return "NO_SESSION_GRANT"
        case .expired: return "SESSION_GRANT_EXPIRED"
        }
    }
}

/// What changed after a mutation, so the caller knows when to crypto-erase.
public struct SessionGrantChange {
    /// how many grants were dropped
    public let dropped: Int
    /// sessions that no longer hold any live grant, and whose key should be erased
    public let closedSessions: [String]
}

public final class SessionGrantTable {
    /// Hard ceiling on any grant, whatever scope or duration was asked for.
    /// A `session` grant on a session that never ends still expires here.
    public static let maxGrantMs: Int64 = 12 * 60 * 60 * 1000

    private struct Grant {
        let identityId: String
        let scope: SessionGrantScope
        let grantedAt: Int64
        var expiresAt: Int64
        var lastUsedAt: Int64?
        var useCount: Int
    }

    private struct SessionState {
        let unlockedAt: Int64
        /// unlockedAt + cap; every grant in the session is clamped to this
        let expiresAt: Int64
        var grants: [String: Grant] = [:] // keyed by keyId
    }

    private var sessions: [String: SessionState] = [:]
    private let clock: () -> Int64

    /// - Parameter clock: epoch milliseconds. Injected so tests can move time.
    public init(clock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.clock = clock
    }

    public func nowMs() -> Int64 { clock() }

    // MARK: - Session lifetime

    /// When the given session was unlocked, if it is still live.
    public func sessionUnlockedAt(_ sessionId: String) -> Int64? {
        pruneExpired()
        return sessions[sessionId]?.unlockedAt
    }

    /// Whether the session still holds at least one live grant, meaning the daemon
    /// is still holding its session-wrapped identity key.
    public func isSessionLive(_ sessionId: String) -> Bool {
        pruneExpired()
        guard let state = sessions[sessionId] else { return false }
        return !state.grants.isEmpty
    }

    /// Whether any session is live. The daemon refuses to idle-quit while this holds.
    public func hasLiveSessions() -> Bool {
        pruneExpired()
        return sessions.values.contains { !$0.grants.isEmpty }
    }

    public func liveSessionIds() -> [String] {
        pruneExpired()
        return sessions.filter { !$0.value.grants.isEmpty }.keys.sorted()
    }

    // MARK: - Granting

    /// Record a grant, opening the session if this is its first one.
    ///
    /// The session's cap starts at its first unlock, so a caller cannot extend its
    /// hold past 12h by re-granting the same key over and over.
    @discardableResult
    public func grant(
        ref: SessionGrantRef,
        identityId: String,
        scope: SessionGrantScope,
        durationMs: Int64? = nil
    ) -> SessionGrantInfo {
        pruneExpired()
        let now = clock()

        let state: SessionState
        if let existing = sessions[ref.sessionId] {
            state = existing
        } else {
            state = SessionState(unlockedAt: now, expiresAt: now + Self.maxGrantMs)
            sessions[ref.sessionId] = state
        }

        let requestedExpiry: Int64
        switch scope {
        case .once, .session:
            requestedExpiry = state.expiresAt
        case .duration:
            let window = max(0, min(durationMs ?? Self.maxGrantMs, Self.maxGrantMs))
            requestedExpiry = now + window
        }

        let grant = Grant(
            identityId: identityId,
            scope: scope,
            grantedAt: now,
            // never past the session cap, whatever was asked for
            expiresAt: min(requestedExpiry, state.expiresAt),
            lastUsedAt: nil,
            useCount: 0
        )
        sessions[ref.sessionId]?.grants[ref.keyId] = grant
        return info(ref: ref, grant: grant, session: sessions[ref.sessionId]!)
    }

    // MARK: - Using

    /// Check a grant and charge one use against it.
    ///
    /// A `once` grant is spent here: it serves exactly one `decrypt-v2` call, however
    /// many payloads that call carries, and is then dropped.
    public func consume(ref: SessionGrantRef) throws -> (info: SessionGrantInfo, change: SessionGrantChange) {
        // Deliberately no prune first: an expired grant should still be found here
        // so the caller is told the session ran out, not that it never existed.
        let now = clock()

        guard let state = sessions[ref.sessionId], var grant = state.grants[ref.keyId] else {
            throw SessionGrantError.noGrant(ref)
        }
        guard grant.expiresAt > now, state.expiresAt > now else {
            // Drop it here rather than leaving a dead row for the next prune to find.
            drop(ref: ref)
            throw SessionGrantError.expired(ref)
        }

        grant.useCount += 1
        grant.lastUsedAt = now
        sessions[ref.sessionId]?.grants[ref.keyId] = grant
        let served = info(ref: ref, grant: grant, session: state)

        if grant.scope == .once {
            return (served, drop(ref: ref))
        }
        return (served, SessionGrantChange(dropped: 0, closedSessions: []))
    }

    // MARK: - Listing

    /// Every live grant, oldest session first, stable within a session by key id.
    public func list() -> [SessionGrantInfo] {
        pruneExpired()
        var out: [SessionGrantInfo] = []
        for (sessionId, state) in sessions {
            for (keyId, grant) in state.grants {
                out.append(info(ref: SessionGrantRef(sessionId: sessionId, keyId: keyId), grant: grant, session: state))
            }
        }
        return out.sorted {
            if $0.sessionUnlockedAt != $1.sessionUnlockedAt { return $0.sessionUnlockedAt < $1.sessionUnlockedAt }
            if $0.sessionId != $1.sessionId { return $0.sessionId < $1.sessionId }
            return $0.keyId < $1.keyId
        }
    }

    // MARK: - Invalidating

    /// Drop grants.
    ///
    /// Omitting both arguments drops every grant, which is what the argument-less
    /// `invalidate-session` has always done. Naming a session drops that session's
    /// grants; naming both drops exactly one.
    @discardableResult
    public func invalidate(sessionId: String? = nil, keyId: String? = nil) -> SessionGrantChange {
        var dropped = 0
        var closed: [String] = []

        for (sid, state) in sessions where sessionId == nil || sessionId == sid {
            var remaining = state.grants
            for kid in state.grants.keys where keyId == nil || keyId == kid {
                remaining.removeValue(forKey: kid)
                dropped += 1
            }
            if remaining.isEmpty {
                sessions.removeValue(forKey: sid)
                closed.append(sid)
            } else {
                sessions[sid]?.grants = remaining
            }
        }

        return SessionGrantChange(dropped: dropped, closedSessions: closed.sorted())
    }

    /// Drop everything whose time is up, and report the sessions that closed.
    @discardableResult
    public func pruneExpired() -> SessionGrantChange {
        let now = clock()
        var dropped = 0
        var closed: [String] = []

        for (sid, state) in sessions {
            if state.expiresAt <= now {
                dropped += state.grants.count
                sessions.removeValue(forKey: sid)
                closed.append(sid)
                continue
            }
            var remaining = state.grants
            for (kid, grant) in state.grants where grant.expiresAt <= now {
                remaining.removeValue(forKey: kid)
                dropped += 1
            }
            if remaining.count != state.grants.count {
                if remaining.isEmpty {
                    sessions.removeValue(forKey: sid)
                    closed.append(sid)
                } else {
                    sessions[sid]?.grants = remaining
                }
            }
        }

        return SessionGrantChange(dropped: dropped, closedSessions: closed.sorted())
    }

    // MARK: - Private

    @discardableResult
    private func drop(ref: SessionGrantRef) -> SessionGrantChange {
        guard var state = sessions[ref.sessionId], state.grants[ref.keyId] != nil else {
            return SessionGrantChange(dropped: 0, closedSessions: [])
        }
        state.grants.removeValue(forKey: ref.keyId)
        if state.grants.isEmpty {
            sessions.removeValue(forKey: ref.sessionId)
            return SessionGrantChange(dropped: 1, closedSessions: [ref.sessionId])
        }
        sessions[ref.sessionId] = state
        return SessionGrantChange(dropped: 1, closedSessions: [])
    }

    private func info(ref: SessionGrantRef, grant: Grant, session: SessionState) -> SessionGrantInfo {
        return SessionGrantInfo(
            sessionId: ref.sessionId,
            keyId: ref.keyId,
            identityId: grant.identityId,
            scope: grant.scope,
            grantedAt: grant.grantedAt,
            expiresAt: grant.expiresAt,
            lastUsedAt: grant.lastUsedAt,
            sessionUnlockedAt: session.unlockedAt,
            sessionExpiresAt: session.expiresAt,
            useCount: grant.useCount
        )
    }
}
