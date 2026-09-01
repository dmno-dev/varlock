import Foundation
import SessionScoping

/// Which answer the panel starts on.
///
/// Three inputs decide it, and they are combined by ONE rule: take the
/// narrowest. Nothing here can ever move the preselection outwards, which is
/// what makes the whole mechanism safe to be wrong about. A stale memory, a
/// misread signal, or a risk rule that fires when it should not all cost the
/// user one extra panel; none of them can hand anything away.
///
///   1. the built-in default, which is broad: the whole key, for this session
///   2. the risk the request itself carries, worked out below
///   3. a narrowing the user chose here before
///
/// The rules live in this one function on purpose. Spread across the panel and
/// the manager as conditionals they would be unreviewable, and "what does
/// varlock preselect and why" is a question a person should be able to answer by
/// reading one screen of code.
///
/// FUTURE WORK: a default set on a vault, or on a single value, is one more
/// input to the same rule. It joins the list `preselect` takes the narrowest of
/// and needs nothing else: no precedence to invent, and no way for it to widen
/// anything. Deliberately not built yet, and deliberately not given a
/// configuration surface, so the shape of that surface stays an open question.

/// What the daemon noticed about this request, as facts rather than as verdicts.
///
/// Every field is derived: the chain comes off the kernel, the agent session off
/// the agent's own record of itself, and `seenBefore` off this Mac's own history
/// of approvals. The client's `projectPath` is the one claim in the mix, and it
/// can only make the answer narrower (a wrong path reads as "somewhere else").
public struct UnlockRiskSignals: Equatable {
    /// The request came from inside a coding-agent session.
    public var hasAgentSession: Bool
    /// That session told us nobody is watching it (headless, print mode).
    public var nobodyWatching: Bool
    /// The session is working in a different tree from the project being opened.
    public var sessionOutsideProject: Bool
    /// The code that decides what happens is a script an interpreter was handed,
    /// and it is not varlock itself. varlock's own JavaScript is excluded on
    /// purpose: that is how most installs run, so treating it as an anomaly
    /// would make the anomaly the norm and teach people to click past it.
    public var actorIsForeignScript: Bool
    /// The kernel had nothing good to say about the actor: no valid signature,
    /// or it would not answer at all.
    public var actorCodeUnverified: Bool
    /// This project and key have been approved on this Mac before.
    public var seenBefore: Bool

    public init(
        hasAgentSession: Bool = false,
        nobodyWatching: Bool = false,
        sessionOutsideProject: Bool = false,
        actorIsForeignScript: Bool = false,
        actorCodeUnverified: Bool = false,
        seenBefore: Bool = false
    ) {
        self.hasAgentSession = hasAgentSession
        self.nobodyWatching = nobodyWatching
        self.sessionOutsideProject = sessionOutsideProject
        self.actorIsForeignScript = actorIsForeignScript
        self.actorCodeUnverified = actorCodeUnverified
        self.seenBefore = seenBefore
    }

    /// Read the signals off what the daemon already worked out for the panel.
    public static func read(
        chain: ExecutionChain?,
        projectPath: String?,
        seenBefore: Bool
    ) -> UnlockRiskSignals {
        let session = chain?.agentSession
        let actor = chain?.hops.first { $0.isImportant }
        return UnlockRiskSignals(
            hasAgentSession: session != nil,
            nobodyWatching: session?.unattendedNote != nil,
            sessionOutsideProject: !UnlockPanelContent.sessionAdvisories(
                session: session,
                projectPath: projectPath
            ).filter { $0.hasPrefix("this session is working in") }.isEmpty,
            actorIsForeignScript: actor.map { $0.posture == .interpretedScript && !$0.isVarlock } ?? false,
            actorCodeUnverified: actor.map { $0.posture == .unsigned } ?? false,
            seenBefore: seenBefore
        )
    }
}

/// How ordinary this request looks.
public enum UnlockRisk: String, Equatable {
    /// A person, in their own project, opening a key they have opened before.
    case routine
    /// Nothing is wrong, but something here is worth being deliberate about.
    case elevated
    /// Something about this request is the shape the panel exists to catch.
    case unusual
}

/// The answer the panel opens on, and why.
public struct UnlockPreselection: Equatable {
    public let breadth: SessionGrantBreadth
    public let window: GrantWindow
    public let risk: UnlockRisk
    /// Whether a narrowing the user chose before is part of this answer.
    public let isRemembered: Bool
    /// The one thing that made this narrower than the default, worded for the
    /// panel. nil when nothing did.
    public let note: String?

    public init(
        breadth: SessionGrantBreadth,
        window: GrantWindow,
        risk: UnlockRisk,
        isRemembered: Bool = false,
        note: String? = nil
    ) {
        self.breadth = breadth
        self.window = window
        self.risk = risk
        self.isRemembered = isRemembered
        self.note = note
    }
}

public enum UnlockDefaults {
    /// What every approval starts from before anything narrows it.
    public static let breadth = SessionGrantBreadth.builtInDefault
    public static let window = GrantWindow.builtInDefault

    /// How unusual this request is, as one readable ladder.
    ///
    /// UNUSUAL is reserved for the three things that change what approving
    /// means rather than merely colouring it:
    ///
    ///   - nobody is watching. "For this session" then means approving for a
    ///     program that will keep going with no person in front of it.
    ///   - the session is somewhere else. An agent working in one tree asking
    ///     for another tree's secrets is the exact shape this panel exists for.
    ///   - the actor's code is unverified. The kernel was asked and had nothing
    ///     good to say, which is different from not having been asked.
    ///
    /// ELEVATED is for the things that are normal but not nothing: an agent is
    /// involved at all, somebody else's script is driving varlock, or this is
    /// the first time this Mac has been asked for this key in this project.
    /// First contact belongs here rather than in `unusual`: it is not a warning
    /// sign, it is simply a decision that has not been made before.
    ///
    /// Everything else is ROUTINE, which is most of what actually happens.
    public static func risk(_ signals: UnlockRiskSignals) -> UnlockRisk {
        if signals.nobodyWatching || signals.sessionOutsideProject || signals.actorCodeUnverified {
            return .unusual
        }
        if signals.hasAgentSession || signals.actorIsForeignScript || !signals.seenBefore {
            return .elevated
        }
        return .routine
    }

    /// What the risk alone would preselect.
    static func selection(for risk: UnlockRisk) -> (SessionGrantBreadth, GrantWindow) {
        switch risk {
        case .routine: return (.wholeKey, GrantWindow(scope: .session))
        case .elevated: return (.listedItems, GrantWindow(scope: .session))
        case .unusual: return (.listedItems, GrantWindow(scope: .once))
        }
    }

    /// The one sentence that says what made this narrower than usual.
    static func note(for risk: UnlockRisk, signals: UnlockRiskSignals) -> String? {
        switch risk {
        case .routine:
            return nil
        case .unusual:
            if signals.nobodyWatching { return "Narrowed: no person is watching this session." }
            if signals.sessionOutsideProject { return "Narrowed: this session is working outside the project." }
            return "Narrowed: the code asking has not been verified."
        case .elevated:
            if !signals.seenBefore { return "Narrowed: this key has not been approved here before." }
            if signals.actorIsForeignScript { return "Narrowed: a script is driving varlock." }
            return "Narrowed: this request came from an agent session."
        }
    }

    /// Where the panel opens: the narrowest of the default, the risk, and what
    /// was remembered, clamped to what this batch can actually offer.
    ///
    /// - Parameters:
    ///   - signals: what the daemon noticed about the request.
    ///   - remembered: a narrowing the user chose here before, if any. Only ever
    ///     narrowings: a broad choice is the default and is never written down.
    ///   - offeredBreadths: `listed` is missing when the batch has no items to
    ///     narrow to, and a preselection of something that is not on the panel
    ///     would be a lie about what is about to happen.
    ///   - offeredScopes: `session` is missing when a key asks every time.
    public static func preselect(
        signals: UnlockRiskSignals,
        remembered: UnlockNarrowing? = nil,
        offeredBreadths: [SessionGrantBreadth],
        offeredScopes: [SessionGrantScope]
    ) -> UnlockPreselection {
        let level = risk(signals)
        let (riskBreadth, riskWindow) = selection(for: level)

        var breadth = SessionGrantBreadth.narrowest([Self.breadth, riskBreadth, remembered?.breadth])
        var window = GrantWindow.narrowest([Self.window, riskWindow, remembered?.window])

        // Never preselect an answer the panel does not offer.
        if !offeredBreadths.contains(breadth) {
            breadth = offeredBreadths.first ?? .wholeKey
        }
        if !offeredScopes.contains(window.scope) {
            window = GrantWindow(scope: offeredScopes.contains(.once) ? .once : (offeredScopes.first ?? .once))
        }

        // Remembered only counts as applied when it is actually the thing that
        // narrowed something. A memory the risk rules had already overtaken is
        // not what the user is looking at, so saying so would be noise.
        let rememberedApplied = remembered.map { memory in
            (memory.breadth == breadth && riskBreadth != breadth)
                || (memory.window == window && riskWindow != window)
        } ?? false

        return UnlockPreselection(
            breadth: breadth,
            window: window,
            risk: level,
            isRemembered: rememberedApplied,
            note: rememberedApplied ? rememberedNote : note(for: level, signals: signals)
        )
    }

    /// What the panel says when a narrowing came from the user's own last answer.
    ///
    /// Said out loud rather than quietly preselected: a panel that is tighter
    /// than the one you saw last week, with nothing explaining why, is a panel
    /// people learn to distrust.
    public static let rememberedNote = "Remembered from the last time you approved this here."
}
