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
    /// The ciphertexts this key is being asked to open, by digest, as the daemon
    /// computed them from the payloads the client handed over.
    ///
    /// This is the only part of a request that can narrow a grant, and it is the
    /// only part of it the daemon worked out for itself. Everything else about a
    /// key (its name, its file, how many values the client claims) is
    /// decoration; this is the enforcement set.
    public let itemDigests: Set<String>
    /// Whether this key has a source that item scope does not reach: today,
    /// varlock's value cache. See `SessionGrantBreadth`, and the line the panel
    /// draws about it.
    public let hasUnlistableSource: Bool

    public init(
        keyId: String,
        policy: KeyAuthPolicy = .standard,
        itemCount: Int? = nil,
        itemDigests: Set<String> = [],
        hasUnlistableSource: Bool = false
    ) {
        self.keyId = keyId
        self.policy = policy
        self.itemCount = itemCount
        self.itemDigests = itemDigests
        self.hasUnlistableSource = hasUnlistableSource
    }
}

/// The part of a live grant that matters when deciding whether to ask again.
public struct ExistingGrantSnapshot: Equatable {
    public let scope: SessionGrantScope
    /// ms of life the grant has left, as the grant table measured it.
    ///
    /// A remaining window rather than an expiry instant, so the planner never has
    /// to pick a clock. The table already reconciles the wall and monotonic
    /// deadlines; this is the answer it arrived at.
    public let remainingMs: Int64
    /// What an item-scoped grant covers, or nil when it covers the whole key.
    ///
    /// A grant that is long enough but narrow is still not enough for a batch
    /// carrying something it never covered, so this sits beside the window
    /// rather than behind it: the two are independent, and coverage means both.
    public let coveredItems: Set<String>?

    public init(scope: SessionGrantScope, remainingMs: Int64, coveredItems: Set<String>? = nil) {
        self.scope = scope
        self.remainingMs = remainingMs
        self.coveredItems = coveredItems
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
    /// Which breadths the panel may offer.
    ///
    /// The narrow one is only there when EVERY key in the question brought
    /// items with it. A batch where one key's ciphertexts arrived and another's
    /// did not cannot honestly offer "only these values": the second key's grant
    /// would open nothing, and the panel would have promised a narrowing that
    /// was really an outage.
    public let offeredBreadths: [SessionGrantBreadth]

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

    /// Whether the panel has a breadth choice to draw at all.
    public var offersBreadthChoice: Bool { offeredBreadths.count > 1 }

    /// How many distinct ciphertexts a narrow approval would cover, across every
    /// key in the question.
    ///
    /// Counted from the digests the daemon computed, so unlike the client's own
    /// value count this number is one varlock can stand behind: it is exactly
    /// how many payloads the grant will open.
    public var listedItemCount: Int {
        return promptKeys.reduce(into: Set<String>()) { $0.formUnion($1.itemDigests) }.count
    }

    /// Whether anything in the question has a source item scope does not reach.
    public var hasUnlistableSource: Bool { promptKeys.contains { $0.hasUnlistableSource } }
}

/// Preset windows offered behind the "for a set time" choice.
///
/// The longest is the session cap itself, so the choice never offers a window
/// the grant table would quietly clip.
public enum DurationPreset: Int64, CaseIterable {
    case oneHour = 3_600_000
    case fourHours = 14_400_000
    case eightHours = 28_800_000
    case twelveHours = 43_200_000

    public var label: String {
        switch self {
        case .oneHour: return "1 hour"
        case .fourHours: return "4 hours"
        case .eightHours: return "8 hours"
        case .twelveHours: return "12 hours"
        }
    }

    /// The next window in the list, wrapping. Used where a menu cannot be drawn.
    public var next: DurationPreset {
        let all = DurationPreset.allCases
        let index = all.firstIndex(of: self) ?? 0
        return all[(index + 1) % all.count]
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
    public static func plan(
        requested: [RequestedKey],
        requestedScope: SessionGrantScope,
        requestedDurationMs: Int64? = nil,
        existing: [String: ExistingGrantSnapshot]
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
            if covers(
                live: live,
                requestedScope: requestedScope,
                requestedDurationMs: requestedDurationMs,
                requestedItems: key.itemDigests
            ) {
                coveredKeys.append(key)
            } else {
                refreshKeys.append(key)
            }
        }

        let promptKeys = newKeys + refreshKeys
        let anyStandard = promptKeys.contains { $0.policy == .standard }
        let offered: [SessionGrantScope] = anyStandard ? fullScopes : [.once]
        let canNarrow = !promptKeys.isEmpty && promptKeys.allSatisfy { !$0.itemDigests.isEmpty }

        return UnlockPlan(
            newKeys: newKeys,
            refreshKeys: refreshKeys,
            coveredKeys: coveredKeys,
            offeredScopes: offered,
            defaultScope: offered.contains(.session) ? .session : .once,
            offeredBreadths: canNarrow ? [.listedItems, .wholeKey] : [.wholeKey]
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
    ///
    /// Breadth is checked first and separately. A grant can be long enough and
    /// still not cover this request, because the two axes are independent: a
    /// session-long approval over three values does not become an approval over
    /// a fourth just by having time left on it. A batch carrying something
    /// outside the covered set is an upgrade, and upgrades are what the panel is
    /// for, so it goes back through the same delta prompt a brand-new key takes.
    static func covers(
        live: ExistingGrantSnapshot,
        requestedScope: SessionGrantScope,
        requestedDurationMs: Int64?,
        requestedItems: Set<String> = []
    ) -> Bool {
        guard live.remainingMs > 0 else { return false }
        if let coveredItems = live.coveredItems, !requestedItems.isSubset(of: coveredItems) {
            return false
        }
        switch live.scope {
        case .session:
            return true
        case .duration:
            switch requestedScope {
            case .once: return true
            case .duration:
                let window = min(requestedDurationMs ?? SessionGrantTable.maxGrantMs, SessionGrantTable.maxGrantMs)
                return live.remainingMs >= window
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
