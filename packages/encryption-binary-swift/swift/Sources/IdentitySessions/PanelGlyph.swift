import Foundation

/// What the panel's Touch ID glyph is doing, and why.
///
/// The glyph is the only part of the panel that moves, so what it does has to
/// mean something. It breathes while the sensor is actually armed, reacts when a
/// check ends without an answer, and confirms when one succeeds. Deciding that
/// here, from the flow's own state, keeps the mapping honest and testable: the
/// AppKit side only turns an effect into animation, and cannot invent a state the
/// flow is not in.
///
/// The rule the mapping exists to enforce: the glyph never animates as though it
/// were waiting for a finger unless a presence check is genuinely running. A
/// panel that looked armed while nothing was listening is the exact bug this
/// feature spent several rounds chasing.

/// What is happening, in glyph terms.
public enum PanelGlyphState: Equatable {
    /// Nothing is armed. Includes the button-driven modes, and the moment after a
    /// check ends, since the sensor is not listening again until asked.
    case idle
    /// A presence check is running: the sensor is live right now.
    case armed
    /// A check just ended without an answer.
    case failed
    /// Approved by a presence check.
    case approved
}

/// What the view should do about it.
public enum PanelGlyphEffect: Equatable {
    /// Static glyph, resting colour.
    case still
    /// Gentle breathing, for a sensor that is genuinely listening.
    case pulse
    /// A short horizontal shake, then back to static. Deliberately not back to
    /// pulsing: after a failed check nothing is armed until the user asks again,
    /// and a pulse would promise a sensor that is not listening.
    case shakeThenStill
    /// Green, with a small pop, before the panel closes.
    case successPop
    /// Reduce-motion forms. Same meaning, carried by colour alone.
    case armedStill
    case failedStill
    case successStill

    /// Whether this effect involves movement, which is what reduce-motion drops.
    public var isAnimated: Bool {
        switch self {
        case .pulse, .shakeThenStill, .successPop: return true
        case .still, .armedStill, .failedStill, .successStill: return false
        }
    }
}

public enum PanelGlyph {
    /// The effect for a glyph state, honouring the system's reduce-motion setting.
    ///
    /// Reduce motion does not mean "show nothing different": the states still have
    /// to be distinguishable, so each keeps a colour and emphasis of its own and
    /// only the movement is dropped.
    public static func effect(for state: PanelGlyphState, reduceMotion: Bool) -> PanelGlyphEffect {
        switch state {
        case .idle:
            return .still
        case .armed:
            return reduceMotion ? .armedStill : .pulse
        case .failed:
            return reduceMotion ? .failedStill : .shakeThenStill
        case .approved:
            return reduceMotion ? .successStill : .successPop
        }
    }
}

public extension ApprovalFlow {
    /// What the glyph should be showing for this flow, right now.
    ///
    /// Only the embedded mode ever draws a glyph, and only that mode arms anything
    /// without a button, so every other mode reports `idle` and the glyph sits
    /// still.
    var glyphState: PanelGlyphState {
        if case .finished(let decision) = state {
            return decision.approved && presenceMode != .none ? .approved : .idle
        }
        guard presenceMode == .embedded else { return .idle }
        switch state {
        case .scanning:
            return .armed
        case .awaitingInput:
            return failedScans > 0 ? .failed : .idle
        case .finished:
            return .idle
        }
    }
}
