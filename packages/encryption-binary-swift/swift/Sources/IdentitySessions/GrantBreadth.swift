import Foundation
import CryptoKit

/// The second axis of an approval: how MUCH an approval opens.
///
/// Duration answers "for how long". This answers "over what", and the two are
/// independent: a session-long approval over three named values is a real
/// answer, and so is a single-use approval over everything a vault can open.
///
/// The narrow side is enforced by the daemon, not described by the client. What
/// it covers is a set of SHA-256 digests the daemon computed itself from the
/// ciphertexts it was handed at unlock time, so a client cannot widen a grant by
/// relabelling anything: a payload whose digest is not in the set is refused and
/// raises a fresh panel, exactly as a key nobody has unlocked yet would.
///
/// The broad side has a ceiling that is not a control: see `VaultBoundary`.
public enum SessionGrantBreadth: String, CaseIterable {
    /// Only the ciphertexts that were on the panel when this was approved.
    case listedItems = "listed"
    /// Anything inside the vaults the panel showed, which is what an approval
    /// covered before there was a choice to make.
    case wholeKey = "key"

    public init?(wireValue: String?) {
        guard let wireValue else { return nil }
        self.init(rawValue: wireValue)
    }

    /// What an approval covers when nothing narrows it. Broad on purpose: the
    /// unremarkable case is a person opening their own project's values, and
    /// that case should cost them nothing to think about.
    public static let builtInDefault: SessionGrantBreadth = .wholeKey

    /// Lower is narrower. Only ever compared, never displayed.
    var restrictiveness: Int { self == .listedItems ? 0 : 1 }

    /// The narrowest of several answers.
    ///
    /// Used everywhere breadth is decided, so the preselection can be described
    /// as one rule ("take the narrowest of the default, the risk, and what was
    /// remembered") rather than as a precedence chain nobody can hold in their
    /// head.
    public static func narrowest(_ values: [SessionGrantBreadth?]) -> SessionGrantBreadth {
        let present = values.compactMap { $0 }
        guard let first = present.first else { return builtInDefault }
        return present.reduce(first) { $0.restrictiveness <= $1.restrictiveness ? $0 : $1 }
    }
}

/// Which breadth applies to which vault.
///
/// One control sets it for every vault in a request today, because a request
/// names one vault in practice and a second checkbox for a distinction nobody
/// can yet make would be a control with nothing to control.
///
/// It resolves PER VAULT anyway, which is the point of the type. A per-vault
/// checkbox (broad on your own local vault, narrow on a shared team one) is a
/// real thing to want and is deliberately deferred rather than ruled out;
/// building the resolution this way now means adding it later is a change to
/// the panel and nothing else. Nothing downstream asks "what did the user
/// pick", it asks "what applies to this vault".
public struct UnlockBreadthSelection: Equatable {
    /// Per-vault answers, where one has been made.
    private var byVault: [String: SessionGrantBreadth]
    /// What a vault with no answer of its own gets.
    private let fallback: SessionGrantBreadth

    public init(fallback: SessionGrantBreadth, byVault: [String: SessionGrantBreadth] = [:]) {
        self.fallback = fallback
        self.byVault = byVault
    }

    /// One answer for every vault, which is what the panel's single checkbox
    /// produces today.
    public static func uniform(_ breadth: SessionGrantBreadth) -> UnlockBreadthSelection {
        return UnlockBreadthSelection(fallback: breadth)
    }

    public func breadth(forVault vaultId: String) -> SessionGrantBreadth {
        return byVault[vaultId] ?? fallback
    }

    /// Clamp to what the panel actually offered, per vault.
    ///
    /// A breadth that was never on the panel cannot be chosen, whatever comes
    /// back from it: the answer is bounded by the question that was asked.
    public func clamped(to offered: [SessionGrantBreadth]) -> UnlockBreadthSelection {
        func allow(_ value: SessionGrantBreadth) -> SessionGrantBreadth {
            return offered.contains(value) ? value : .wholeKey
        }
        return UnlockBreadthSelection(
            fallback: allow(fallback),
            byVault: byVault.mapValues(allow)
        )
    }

    /// The single answer, for the places that still speak in one (the audit
    /// record's summary line, and remembering a choice). The narrowest of what
    /// was chosen, so a summary can never claim less caution than was applied.
    public var narrowest: SessionGrantBreadth {
        return SessionGrantBreadth.narrowest([fallback] + byVault.values.map { $0 })
    }
}

/// The line a broad approval may not cross.
///
/// Breadth is a control; this is not. Approving broadly says "anything in what
/// you just showed me", and what the panel showed is a set of vaults. A key in
/// a vault that was never on the panel is not something the user said yes to,
/// however broad they were feeling, so it asks again.
///
/// Today every key sits in one implicit local vault, so this mostly holds
/// trivially. It is written as a vault rule rather than a key rule anyway,
/// because the moment a second vault exists it is the only rule that is
/// defensible, and a boundary retrofitted after the fact is a boundary with
/// holes in it.
public enum VaultBoundary {
    /// The vault every key belongs to until there are vaults to belong to.
    public static let localVaultId = "local"

    /// Whether a live grant's approval reaches a key in this vault.
    public static func covers(approvedVaultId: String?, requestedVaultId: String) -> Bool {
        guard let approvedVaultId else { return false }
        return approvedVaultId == requestedVaultId
    }
}

/// A scope and its window as one comparable thing.
///
/// `duration` is not a single answer, it is a family of them, so comparing two
/// approvals means comparing `once` against `4 hours` against `this session`.
/// Folding the window into the value is what lets that be a `<`.
public struct GrantWindow: Equatable {
    public let scope: SessionGrantScope
    /// Only meaningful for `duration`; nil elsewhere.
    public let durationMs: Int64?

    public init(scope: SessionGrantScope, durationMs: Int64? = nil) {
        self.scope = scope
        self.durationMs = scope == .duration ? durationMs : nil
    }

    /// The longest thing on offer, and the built-in default.
    public static let builtInDefault = GrantWindow(scope: .session)

    /// How much life this answer carries, in ms, for comparing two of them.
    ///
    /// A `session` grant is clamped to the 12h cap like everything else, but it
    /// also ends when the session does, so it ranks above the longest window a
    /// caller can name rather than equal to it.
    var lifetimeRank: Int64 {
        switch scope {
        case .once: return 0
        case .duration: return max(1, min(durationMs ?? SessionGrantTable.maxGrantMs, SessionGrantTable.maxGrantMs))
        case .session: return Int64.max
        }
    }

    /// The shortest-lived of several answers.
    public static func narrowest(_ values: [GrantWindow?]) -> GrantWindow {
        let present = values.compactMap { $0 }
        guard let first = present.first else { return builtInDefault }
        return present.reduce(first) { $0.lifetimeRank <= $1.lifetimeRank ? $0 : $1 }
    }
}

/// How a ciphertext is named in a grant's covered set.
///
/// SHA-256 of the RAW payload bytes, computed on this side of the socket from
/// the ciphertext itself. Never a hash the client sent, and never anything
/// derived from a label: a digest the client could choose would let a client
/// choose what its own grant covers, which is the whole thing this is for.
public enum GrantItemDigest {
    public static func of(_ ciphertext: Data) -> String {
        return SHA256.hash(data: ciphertext).map { String(format: "%02x", $0) }.joined()
    }

    /// The digests of a batch, in order, skipping nothing.
    public static func of(_ ciphertexts: [Data]) -> [String] {
        return ciphertexts.map { of($0) }
    }
}
