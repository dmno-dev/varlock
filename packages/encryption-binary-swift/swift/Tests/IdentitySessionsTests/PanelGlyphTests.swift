import XCTest
@testable import IdentitySessions

/// What the panel's glyph is allowed to say.
///
/// The load-bearing promise is the negative one: the glyph must never breathe as
/// though a finger would be read, unless a presence check is genuinely running.
/// A panel that looked armed while nothing was listening is exactly the failure
/// this whole feature spent several rounds chasing, and it would be cheap to
/// reintroduce as a purely cosmetic change.
final class PanelGlyphTests: XCTestCase {

    private func embedded(default scope: SessionGrantScope = .session) -> ApprovalFlow {
        return ApprovalFlow(defaultScope: scope, presenceMode: .embedded)
    }

    // MARK: - State mapping

    func testTheGlyphOnlyPulsesWhileSomethingIsActuallyArmed() {
        var flow = embedded()
        XCTAssertEqual(flow.glyphState, .idle, "nothing has started yet")

        _ = flow.start()
        XCTAssertEqual(flow.state, .scanning)
        XCTAssertEqual(flow.glyphState, .armed)
    }

    func testAFailedScanReportsFailedRatherThanStillArmed() {
        var flow = embedded()
        _ = flow.start()
        _ = flow.apply(.scanFailed)

        // The sensor is not listening again until the user asks, so the glyph
        // must not go back to promising that it is.
        XCTAssertEqual(flow.glyphState, .failed)
        XCTAssertEqual(
            PanelGlyph.effect(for: .failed, reduceMotion: false),
            .shakeThenStill,
            "shake, then rest: not shake, then resume pulsing"
        )
    }

    func testArmingAgainAfterAFailureGoesBackToArmed() {
        var flow = embedded()
        _ = flow.start()
        _ = flow.apply(.scanFailed)
        _ = flow.apply(.confirmPressed)

        XCTAssertEqual(flow.glyphState, .armed)
    }

    func testApprovalReportsApproved() {
        var flow = embedded()
        _ = flow.start()
        _ = flow.apply(.scanSucceeded)

        XCTAssertEqual(flow.glyphState, .approved)
    }

    func testARefusalIsNotDressedUpAsAnything() {
        var flow = embedded()
        _ = flow.start()
        _ = flow.apply(.cancelPressed)

        XCTAssertEqual(flow.glyphState, .idle)
    }

    func testTheButtonDrivenModesNeverPulse() {
        for mode in [ApprovalPresenceMode.systemDialog, .none] {
            var flow = ApprovalFlow(defaultScope: .session, presenceMode: mode)
            _ = flow.start()
            XCTAssertEqual(flow.glyphState, .idle, "\(mode) waits for a button, so nothing is armed")

            _ = flow.apply(.confirmPressed)
            XCTAssertEqual(
                flow.glyphState,
                .idle,
                "\(mode) raises the system's own dialog, which carries its own affordance"
            )
        }
    }

    func testAnUnattendedApprovalWithNoPresenceCheckStaysStill() {
        var flow = ApprovalFlow(defaultScope: .session, presenceMode: .none)
        _ = flow.start()
        _ = flow.apply(.confirmPressed)

        // Approved by a button press, not by a scan: nothing to celebrate on the
        // glyph, which is not even shown in this mode.
        XCTAssertEqual(flow.glyphState, .idle)
    }

    // MARK: - Effects

    func testEachStateHasItsOwnEffect() {
        XCTAssertEqual(PanelGlyph.effect(for: .idle, reduceMotion: false), .still)
        XCTAssertEqual(PanelGlyph.effect(for: .armed, reduceMotion: false), .pulse)
        XCTAssertEqual(PanelGlyph.effect(for: .failed, reduceMotion: false), .shakeThenStill)
        XCTAssertEqual(PanelGlyph.effect(for: .approved, reduceMotion: false), .successPop)
    }

    func testReduceMotionDropsEveryMovement() {
        for state in [PanelGlyphState.idle, .armed, .failed, .approved] {
            let effect = PanelGlyph.effect(for: state, reduceMotion: true)
            XCTAssertFalse(effect.isAnimated, "\(state) still moved under reduce motion")
        }
    }

    func testReduceMotionStillTellsTheStatesApart() {
        // Dropping the movement must not flatten four meanings into one picture.
        let effects = [PanelGlyphState.idle, .armed, .failed, .approved]
            .map { PanelGlyph.effect(for: $0, reduceMotion: true) }
        XCTAssertEqual(Set(effects).count, effects.count, "each state needs its own still form")
        XCTAssertEqual(PanelGlyph.effect(for: .idle, reduceMotion: true), .still)
        XCTAssertEqual(PanelGlyph.effect(for: .armed, reduceMotion: true), .armedStill)
        XCTAssertEqual(PanelGlyph.effect(for: .failed, reduceMotion: true), .failedStill)
        XCTAssertEqual(PanelGlyph.effect(for: .approved, reduceMotion: true), .successStill)
    }

    func testOnlyTheMovingEffectsCountAsAnimated() {
        XCTAssertTrue(PanelGlyphEffect.pulse.isAnimated)
        XCTAssertTrue(PanelGlyphEffect.shakeThenStill.isAnimated)
        XCTAssertTrue(PanelGlyphEffect.successPop.isAnimated)
        XCTAssertFalse(PanelGlyphEffect.still.isAnimated)
        XCTAssertFalse(PanelGlyphEffect.armedStill.isAnimated)
        XCTAssertFalse(PanelGlyphEffect.failedStill.isAnimated)
        XCTAssertFalse(PanelGlyphEffect.successStill.isAnimated)
    }
}
