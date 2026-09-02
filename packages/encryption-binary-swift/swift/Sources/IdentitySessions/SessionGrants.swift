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
    /// how much of the key this grant opens
    public let breadth: SessionGrantBreadth
    /// how many distinct ciphertexts an item-scoped grant currently covers.
    /// nil for a whole-key grant, which covers a number nobody can count.
    public let coveredItemCount: Int?
    /// the vault this grant was approved over, which a broad approval may not
    /// reach outside of
    public let vaultId: String

    /// Defaulted, so every caller that predates the breadth axis reads as what
    /// it has always been: an approval over the whole key.
    public init(
        sessionId: String,
        keyId: String,
        identityId: String,
        scope: SessionGrantScope,
        grantedAt: Int64,
        expiresAt: Int64,
        remainingMs: Int64,
        lastUsedAt: Int64? = nil,
        sessionUnlockedAt: Int64,
        sessionExpiresAt: Int64,
        sessionRemainingMs: Int64,
        lockOn: SessionLockPolicy,
        useCount: Int,
        breadth: SessionGrantBreadth = .wholeKey,
        coveredItemCount: Int? = nil,
        vaultId: String = VaultBoundary.localVaultId
    ) {
        self.sessionId = sessionId
        self.keyId = keyId
        self.identityId = identityId
        self.scope = scope
        self.grantedAt = grantedAt
        self.expiresAt = expiresAt
        self.remainingMs = remainingMs
        self.lastUsedAt = lastUsedAt
        self.sessionUnlockedAt = sessionUnlockedAt
        self.sessionExpiresAt = sessionExpiresAt
        self.sessionRemainingMs = sessionRemainingMs
        self.lockOn = lockOn
        self.useCount = useCount
        self.breadth = breadth
        self.coveredItemCount = coveredItemCount
        self.vaultId = vaultId
    }

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
            "breadth": breadth.rawValue,
            "vaultId": vaultId,
        ]
        if let lastUsedAt {
            dict["lastUsedAt"] = lastUsedAt
        }
        if let coveredItemCount {
            dict["coveredItemCount"] = coveredItemCount
        }
        return dict
    }
}

public enum SessionGrantError: LocalizedError {
    case noGrant(SessionGrantRef)
    case expired(SessionGrantRef)
    /// The grant is live, but this batch carries a ciphertext it was not
    /// approved over. Not a failure: the caller is expected to go and ask.
    case itemNotCovered(SessionGrantRef)

    public var errorDescription: String? {
        switch self {
        case .noGrant(let ref):
            return "No unlock session for key \"\(ref.keyId)\"; run an unlock first"
        case .expired(let ref):
            return "The unlock session for key \"\(ref.keyId)\" has expired; unlock again"
        case .itemNotCovered(let ref):
            return "The unlock session for key \"\(ref.keyId)\" covers only the values it was approved over; "
                + "this request includes others, so it needs approving again"
        }
    }

    /// Stable code the TS client can branch on without matching message text.
    public var code: String {
        switch self {
        case .noGrant: return "NO_SESSION_GRANT"
        case .expired: return "SESSION_GRANT_EXPIRED"
        case .itemNotCovered: return "GRANT_ITEM_NOT_COVERED"
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
        /// The ciphertexts this grant may open, by SHA-256 digest, or nil when
        /// it opens anything the key can.
        ///
        /// Digests only. The grant never holds a ciphertext, a value name, or
        /// anything else a client sent: it holds the one thing the daemon
        /// computed for itself, which is what makes membership in this set an
        /// answer rather than a claim.
        var coveredItems: Set<String>?
        /// The vault this was approved over. Held on the grant rather than
        /// looked up per request, because the answer that matters is the one
        /// the user was shown, not whatever a caller says now.
        let vaultId: String

        var breadth: SessionGrantBreadth { coveredItems == nil ? .wholeKey : .listedItems }
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

    /// What an item-scoped grant currently covers, or nil when it covers the
    /// whole key. Read by the unlock planner, which is how a batch carrying a
    /// ciphertext nobody approved becomes a panel rather than a refusal.
    public func coveredItems(ref: SessionGrantRef) -> Set<String>? {
        pruneExpired()
        return sessions[ref.sessionId]?.grants[ref.keyId]?.coveredItems
    }

    /// The vault a live grant was approved over, if there is one.
    public func vaultId(ref: SessionGrantRef) -> String? {
        pruneExpired()
        return sessions[ref.sessionId]?.grants[ref.keyId]?.vaultId
    }

    // MARK: - Granting

    /// Record a grant, opening the session if this is its first one.
    ///
    /// The session's cap starts at its first unlock, so a caller cannot extend its
    /// hold past 12h by re-granting the same key over and over.
    ///
    /// - Parameter coveredItems: the ciphertext digests this grant may open, or
    ///   nil for the whole key. An empty set is not the same as nil: it is a
    ///   grant that opens nothing yet, which is what an item-scoped approval
    ///   over a batch the client described badly should degrade to.
    @discardableResult
    public func grant(
        ref: SessionGrantRef,
        identityId: String,
        scope: SessionGrantScope,
        durationMs: Int64? = nil,
        lockOn: SessionLockPolicy = .builtInDefault,
        coveredItems: Set<String>? = nil,
        vaultId: String = VaultBoundary.localVaultId
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
            useCount: 0,
            coveredItems: coveredItems,
            vaultId: vaultId
        )
        sessions[ref.sessionId]?.grants[ref.keyId] = grant
        return info(ref: ref, grant: grant, session: sessions[ref.sessionId]!)
    }

    // MARK: - Using

    /// Check a grant and charge one use against it.
    ///
    /// A `once` grant is spent here: it serves exactly one `decrypt-v2` call, however
    /// many payloads that call carries, and is then dropped.
    ///
    /// - Parameters:
    ///   - itemDigests: the digests of the ciphertexts this batch carries, as
    ///     the daemon computed them. An item-scoped grant refuses the WHOLE
    ///     batch if any of them is outside what it was approved over, and is
    ///     not charged for the attempt: the caller's next move is to ask, and
    ///     spending a `once` grant on a refusal would cost it the answer.
    ///   - alsoCovered: digests the grant covers for a structural reason rather
    ///     than because they were listed. This is where the value cache lives:
    ///     see `admitsUnlistedItems` on the source kind. Consulted only when the
    ///     listed set has already said no, so it costs nothing in the normal case.
    public func consume(
        ref: SessionGrantRef,
        itemDigests: [String] = [],
        alsoCovered: () -> Set<String> = { [] }
    ) throws -> (info: SessionGrantInfo, change: SessionGrantChange) {
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

        if var covered = grant.coveredItems {
            let unlisted = itemDigests.filter { !covered.contains($0) }
            if !unlisted.isEmpty {
                let structural = alsoCovered()
                guard unlisted.allSatisfy({ structural.contains($0) }) else {
                    // Nothing is charged and nothing is dropped. The grant is
                    // still good for what it covers; this batch simply is not it.
                    throw SessionGrantError.itemNotCovered(ref)
                }
                // Remembered, so the same entry read again later is an O(1) hit
                // and stays readable even once the store behind it has moved on.
                covered.formUnion(unlisted)
                grant.coveredItems = covered
            }
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
            useCount: grant.useCount,
            breadth: grant.breadth,
            coveredItemCount: grant.coveredItems?.count,
            vaultId: grant.vaultId
        )
    }
}
