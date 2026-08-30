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
    /// epoch ms; always set, since every scope is capped. Display only: what
    /// actually ends the grant is `remainingMs`, which the table measures on the
    /// monotonic clock as well as this one.
    public let expiresAt: Int64
    /// ms of life left, as the table measured it when it built this record.
    ///
    /// Not derived from `expiresAt` by the reader: the wall clock can be moved,
    /// and this number cannot be.
    public let remainingMs: Int64
    /// epoch ms of the last decrypt this grant served, nil until first use
    public let lastUsedAt: Int64?
    /// epoch ms when the session this grant belongs to was unlocked
    public let sessionUnlockedAt: Int64
    /// epoch ms when the session's hard cap runs out
    public let sessionExpiresAt: Int64
    /// ms left on the session's hard cap, measured the same way as `remainingMs`.
    /// Never shorter than `remainingMs`, since every grant is clamped to the cap.
    public let sessionRemainingMs: Int64
    /// which system events erase this session, as resolved at unlock time
    public let lockOn: SessionLockPolicy
    /// how many decrypts this grant has served
    public let useCount: Int

    public func toDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "sessionId": sessionId,
            "keyId": keyId,
            "identityId": identityId,
            "scope": scope.rawValue,
            "grantedAt": grantedAt,
            "expiresAt": expiresAt,
            "sessionUnlockedAt": sessionUnlockedAt,
            "sessionExpiresAt": sessionExpiresAt,
            "sessionExpiresInMs": sessionRemainingMs,
            "lockOn": lockOn.rawValue,
            "useCount": useCount,
            "expiresInMs": remainingMs,
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
        var deadline: GrantDeadline
        var lastUsedAt: Int64?
        var useCount: Int
    }

    private struct SessionState {
        let unlockedAt: Int64
        /// unlockedAt + cap on both clocks; every grant in the session is clamped
        /// to this
        let deadline: GrantDeadline
        /// Which system events erase this session. Held per session rather than
        /// globally, so one session can outlive a screen lock that ends another.
        var lockOn: SessionLockPolicy
        var grants: [String: Grant] = [:] // keyed by keyId
    }

    private var sessions: [String: SessionState] = [:]
    private let clock: () -> Int64
    private let monotonicClock: () -> Int64

    /// - Parameters:
    ///   - clock: epoch milliseconds. Injected so tests can move time.
    ///   - monotonicClock: `MonotonicClock` milliseconds, injected for the same
    ///     reason. Tests drive the two independently, which is the only way to
    ///     check that moving the settable clock cannot buy a grant more life.
    public init(
        clock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        monotonicClock: @escaping () -> Int64 = { MonotonicClock.nowMs() }
    ) {
        self.clock = clock
        self.monotonicClock = monotonicClock
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

    /// The live grant for one (session x key), if there is one.
    ///
    /// Read-only, and it charges nothing. This is what the unlock planner reads to
    /// tell a first unlock from an add-on to a session that is already open.
    public func liveGrant(ref: SessionGrantRef) -> SessionGrantInfo? {
        pruneExpired()
        guard let state = sessions[ref.sessionId], let grant = state.grants[ref.keyId] else { return nil }
        return info(ref: ref, grant: grant, session: state)
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
        durationMs: Int64? = nil,
        lockOn: SessionLockPolicy = .builtInDefault
    ) -> SessionGrantInfo {
        pruneExpired()
        let now = clock()
        let monotonicNow = monotonicClock()

        var state: SessionState
        if var existing = sessions[ref.sessionId] {
            // The most recent unlock sets the session's lock policy, so re-unlocking
            // is how someone changes their mind about it.
            existing.lockOn = lockOn
            sessions[ref.sessionId] = existing
            state = existing
        } else {
            state = SessionState(
                unlockedAt: now,
                deadline: GrantDeadline.after(Self.maxGrantMs, wallNow: now, monotonicNow: monotonicNow),
                lockOn: lockOn
            )
            sessions[ref.sessionId] = state
        }

        let requestedDeadline: GrantDeadline
        switch scope {
        case .once, .session:
            requestedDeadline = state.deadline
        case .duration:
            let window = max(0, min(durationMs ?? Self.maxGrantMs, Self.maxGrantMs))
            requestedDeadline = GrantDeadline.after(window, wallNow: now, monotonicNow: monotonicNow)
        }

        let grant = Grant(
            identityId: identityId,
            scope: scope,
            grantedAt: now,
            // never past the session cap, whatever was asked for, on either clock
            deadline: GrantDeadline.earliest(requestedDeadline, state.deadline),
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
        let monotonicNow = monotonicClock()

        guard let state = sessions[ref.sessionId], var grant = state.grants[ref.keyId] else {
            throw SessionGrantError.noGrant(ref)
        }
        guard !grant.deadline.isExpired(wallNow: now, monotonicNow: monotonicNow),
              !state.deadline.isExpired(wallNow: now, monotonicNow: monotonicNow) else {
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

    /// Drop the sessions whose own lock policy says this event ends them.
    ///
    /// Each session is judged individually, so a `screenLock` session can be erased
    /// by the same event that a `none` session in the same daemon shrugs off.
    @discardableResult
    public func invalidate(onLockEvent event: SessionLockEvent) -> SessionGrantChange {
        var dropped = 0
        var closed: [String] = []

        for (sid, state) in sessions where state.lockOn.erases(on: event) {
            dropped += state.grants.count
            sessions.removeValue(forKey: sid)
            closed.append(sid)
        }

        return SessionGrantChange(dropped: dropped, closedSessions: closed.sorted())
    }

    /// The lock policy a live session is running under.
    public func lockPolicy(forSession sessionId: String) -> SessionLockPolicy? {
        pruneExpired()
        return sessions[sessionId]?.lockOn
    }

    /// Drop everything whose time is up, and report the sessions that closed.
    @discardableResult
    public func pruneExpired() -> SessionGrantChange {
        let now = clock()
        let monotonicNow = monotonicClock()
        var dropped = 0
        var closed: [String] = []

        for (sid, state) in sessions {
            if state.deadline.isExpired(wallNow: now, monotonicNow: monotonicNow) {
                dropped += state.grants.count
                sessions.removeValue(forKey: sid)
                closed.append(sid)
                continue
            }
            var remaining = state.grants
            for (kid, grant) in state.grants
            where grant.deadline.isExpired(wallNow: now, monotonicNow: monotonicNow) {
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
        let now = clock()
        let monotonicNow = monotonicClock()
        return SessionGrantInfo(
            sessionId: ref.sessionId,
            keyId: ref.keyId,
            identityId: grant.identityId,
            scope: grant.scope,
            grantedAt: grant.grantedAt,
            expiresAt: grant.deadline.wall,
            remainingMs: grant.deadline.remainingMs(wallNow: now, monotonicNow: monotonicNow),
            lastUsedAt: grant.lastUsedAt,
            sessionUnlockedAt: session.unlockedAt,
            sessionExpiresAt: session.deadline.wall,
            sessionRemainingMs: session.deadline.remainingMs(wallNow: now, monotonicNow: monotonicNow),
            lockOn: session.lockOn,
            useCount: grant.useCount
        )
    }
}
