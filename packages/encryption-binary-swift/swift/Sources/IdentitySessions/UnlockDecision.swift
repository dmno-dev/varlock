import Foundation

/// What the daemon decides BEFORE any panel is drawn or any biometric runs.
///
/// Everything here is pure: given the keys a caller asked for, the grants that
/// already exist, and each key's auth policy, it works out whether the user has
/// to be asked at all, which keys the question is about, and which scopes may be
/// offered. Keeping it separate from the AppKit view is what lets the rules be
/// tested with no window server and no enclave.

/// How often a key must be re-authorized.
public enum KeyAuthPolicy: String, Equatable {
    /// The normal case: one approval can cover a session or a chosen window.
    case standard
    /// Strict: this key never receives a lasting grant. Every batch asks again.
    case everyTime = "every-time"

    public init(wireValue: String?) {
        guard let wireValue, let parsed = KeyAuthPolicy(rawValue: wireValue) else {
            self = .standard
            return
        }
        self = parsed
    }
}

/// One key in an unlock request, with the decoration the client sent for it.
public struct RequestedKey: Equatable {
    public let keyId: String
    public let policy: KeyAuthPolicy
    /// How many encrypted items the client says this key covers. Client-supplied
    /// decoration: it changes what the panel says, never what the daemon allows.
    public let itemCount: Int?

    public init(keyId: String, policy: KeyAuthPolicy = .standard, itemCount: Int? = nil) {
        self.keyId = keyId
        self.policy = policy
        self.itemCount = itemCount
    }
}

/// The part of a live grant that matters when deciding whether to ask again.
public struct ExistingGrantSnapshot: Equatable {
    public let scope: SessionGrantScope
    /// epoch ms
    public let expiresAt: Int64

    public init(scope: SessionGrantScope, expiresAt: Int64) {
        self.scope = scope
        self.expiresAt = expiresAt
    }
}

/// The full picture of what an unlock request needs.
public struct UnlockPlan: Equatable {
    /// Keys with no live grant at all.
    public let newKeys: [RequestedKey]
    /// Keys that hold a grant which does not cover this request (strict keys, or
    /// a request for a longer scope than the live grant carries).
    public let refreshKeys: [RequestedKey]
    /// Keys whose live grant already covers this request. Nothing to ask about.
    public let coveredKeys: [RequestedKey]
    /// Which scopes the panel may offer, given the strictest key in the batch.
    public let offeredScopes: [SessionGrantScope]
    /// Which scope the panel starts on.
    public let defaultScope: SessionGrantScope

    /// The keys the user is actually being asked about, in a stable order.
    public var promptKeys: [RequestedKey] { newKeys + refreshKeys }

    /// Keys in the question that must be re-approved every single time.
    public var strictPromptKeys: [RequestedKey] { promptKeys.filter { $0.policy == .everyTime } }

    /// Keys in the question that can take a lasting grant.
    public var standardPromptKeys: [RequestedKey] { promptKeys.filter { $0.policy == .standard } }

    /// Whether the user has to be asked at all.
    public var requiresPrompt: Bool { !promptKeys.isEmpty }

    /// Whether this is an add-on to a session that already holds other keys, which
    /// the panel says differently ("also unlock ...").
    public var isDelta: Bool { !coveredKeys.isEmpty && requiresPrompt }

    /// Whether every key in the question asks every time, so no lasting scope is
    /// on offer.
    public var isStrictOnly: Bool { requiresPrompt && standardPromptKeys.isEmpty }
}

/// Preset windows offered behind the "for a set time" choice.
public enum DurationPreset: Int64, CaseIterable {
    case oneHour = 3_600_000
    case fourHours = 14_400_000
    case eightHours = 28_800_000

    public var label: String {
        switch self {
        case .oneHour: return "1 hour"
        case .fourHours: return "4 hours"
        case .eightHours: return "8 hours"
        }
    }

    public var milliseconds: Int64 { rawValue }

    public static let `default`: DurationPreset = .oneHour
}

public enum UnlockPlanner {
    /// Scopes offered when at least one key in the batch can take a lasting grant.
    public static let fullScopes: [SessionGrantScope] = [.session, .once, .duration]

    /// Work out what an unlock request still needs.
    ///
    /// - Parameters:
    ///   - requested: the keys the caller named, already filtered to ones this
    ///     identity can actually be opened with.
    ///   - requestedScope: the scope the caller asked for, used to judge whether a
    ///     live grant is already strong enough.
    ///   - requestedDurationMs: only meaningful when `requestedScope` is `duration`.
    ///   - existing: live grants for this session, keyed by key id.
    ///   - now: epoch ms.
    public static func plan(
        requested: [RequestedKey],
        requestedScope: SessionGrantScope,
        requestedDurationMs: Int64? = nil,
        existing: [String: ExistingGrantSnapshot],
        now: Int64
    ) -> UnlockPlan {
        var newKeys: [RequestedKey] = []
        var refreshKeys: [RequestedKey] = []
        var coveredKeys: [RequestedKey] = []

        for key in requested {
            guard let live = existing[key.keyId] else {
                newKeys.append(key)
                continue
            }
            // A key that asks every time is never covered by what it was granted
            // last time. That is the whole point of the policy.
            if key.policy == .everyTime {
                refreshKeys.append(key)
                continue
            }
            if covers(live: live, requestedScope: requestedScope, requestedDurationMs: requestedDurationMs, now: now) {
                coveredKeys.append(key)
            } else {
                refreshKeys.append(key)
            }
        }

        let promptKeys = newKeys + refreshKeys
        let anyStandard = promptKeys.contains { $0.policy == .standard }
        let offered: [SessionGrantScope] = anyStandard ? fullScopes : [.once]

        return UnlockPlan(
            newKeys: newKeys,
            refreshKeys: refreshKeys,
            coveredKeys: coveredKeys,
            offeredScopes: offered,
            defaultScope: offered.contains(.session) ? .session : .once
        )
    }

    /// Whether a live grant is already at least as strong as what was asked for.
    ///
    /// The rules are deliberately blunt, so the answer never depends on clock
    /// drift or on comparing two windows that were measured from different
    /// starting points:
    ///
    ///   - a `session` grant covers anything, since it is the longest thing on offer
    ///   - a `duration` grant covers a `once` request, and covers another `duration`
    ///     request only if the window already granted reaches past the new one
    ///   - a `once` grant covers only another `once` request
    ///
    /// Anything else counts as an upgrade and is worth asking about.
    static func covers(
        live: ExistingGrantSnapshot,
        requestedScope: SessionGrantScope,
        requestedDurationMs: Int64?,
        now: Int64
    ) -> Bool {
        guard live.expiresAt > now else { return false }
        switch live.scope {
        case .session:
            return true
        case .duration:
            switch requestedScope {
            case .once: return true
            case .duration:
                let window = min(requestedDurationMs ?? SessionGrantTable.maxGrantMs, SessionGrantTable.maxGrantMs)
                return live.expiresAt >= now + window
            case .session: return false
            }
        case .once:
            return requestedScope == .once
        }
    }

    /// The scope a single key actually receives once the user has chosen one.
    ///
    /// A key that asks every time only ever gets `once`, whatever the panel was
    /// set to for the rest of the batch.
    public static func effectiveScope(chosen: SessionGrantScope, policy: KeyAuthPolicy) -> SessionGrantScope {
        return policy == .everyTime ? .once : chosen
    }

    /// The duration a single key actually receives, in the same spirit.
    public static func effectiveDurationMs(
        chosen: SessionGrantScope,
        chosenDurationMs: Int64?,
        policy: KeyAuthPolicy
    ) -> Int64? {
        return effectiveScope(chosen: chosen, policy: policy) == .duration ? chosenDurationMs : nil
    }
}
