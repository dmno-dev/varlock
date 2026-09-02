import XCTest
@testable import IdentitySessions

/// The order an approval happens in.
///
/// The promises being pinned here are the ones a user feels: the scan is the
/// approval and costs one gesture, what it approves is what the panel is showing
/// at that instant, a failed scan is not a refusal, and nothing re-arms itself.
final class ApprovalFlowTests: XCTestCase {

    private func embedded(default scope: SessionGrantScope = .session) -> ApprovalFlow {
        return ApprovalFlow(defaultScope: scope, presenceMode: .embedded)
    }

    // MARK: - The common case

    func testEmbeddedPromptArmsItselfAndTheScanIsTheApproval() {
        var flow = embedded()
        XCTAssertEqual(flow.start(), .beginScan)
        XCTAssertEqual(flow.state, .scanning)

        // One gesture: no confirm press anywhere in this test.
        let effect = flow.apply(.scanSucceeded)
        XCTAssertEqual(effect, .finish(PanelDecision(approved: true, scope: .session, chosenBreadth: .wholeKey)))
        XCTAssertEqual(flow.state, .finished(PanelDecision(approved: true, scope: .session, chosenBreadth: .wholeKey)))
    }

    func testAScanApprovesWhatIsSelectedWhenItLands() {
        var flow = embedded()
        _ = flow.start()

        // Nothing is modal over the panel, so the user can still change their mind
        // while the prompt is armed. The scan must honour that, not the state the
        // panel opened in.
        flow.select(scope: .once)
        XCTAssertEqual(flow.apply(.scanSucceeded), .finish(PanelDecision(approved: true, scope: .once, breadth: .listedItems)))
    }

    func testADurationSelectionCarriesItsWindow() {
        var flow = embedded()
        _ = flow.start()
        // A window nothing on the ladder names, which is what the custom rung
        // produces. The flow carries whatever it is handed: it is not in the
        // business of second-guessing a number the panel already clamped.
        let typed: Int64 = 2_700_000
        flow.select(scope: .duration, durationMs: typed)

        XCTAssertEqual(
            flow.apply(.scanSucceeded),
            .finish(PanelDecision(
                approved: true,
                scope: .duration,
                durationMs: typed,
                chosenBreadth: .wholeKey
            ))
        )
    }

    func testADurationSelectionWithNoWindowTakesThePresetDefault() {
        var flow = embedded()
        _ = flow.start()
        flow.select(scope: .duration)

        XCTAssertEqual(
            flow.apply(.scanSucceeded),
            .finish(PanelDecision(
                approved: true,
                scope: .duration,
                durationMs: DurationPreset.default.milliseconds,
                chosenBreadth: .wholeKey
            ))
        )
    }

    func testMovingOffDurationDropsTheWindow() {
        var flow = embedded()
        _ = flow.start()
        flow.select(scope: .duration, durationMs: DurationPreset.oneHour.milliseconds)
        flow.select(scope: .session)

        XCTAssertEqual(flow.apply(.scanSucceeded), .finish(PanelDecision(approved: true, scope: .session, chosenBreadth: .wholeKey)))
    }

    // MARK: - A scan that does not land

    func testAFailedScanIsNotARefusal() {
        var flow = embedded()
        _ = flow.start()

        XCTAssertEqual(flow.apply(.scanFailed), .showControls)
        XCTAssertEqual(flow.state, .awaitingInput, "the panel stays up with its controls live")
        XCTAssertEqual(flow.failedScans, 1)
    }

    func testNothingReArmsOnItsOwn() {
        var flow = embedded()
        _ = flow.start()
        _ = flow.apply(.scanFailed)

        // The only way back to a scan is the user pressing the button, which is
        // what stops a failing sensor turning into a loop.
        XCTAssertEqual(flow.state, .awaitingInput)
        XCTAssertEqual(flow.apply(.confirmPressed), .beginScan)
        XCTAssertEqual(flow.state, .scanning)
    }

    func testAScanAfterARetryStillApprovesTheCurrentSelection() {
        var flow = embedded()
        _ = flow.start()
        _ = flow.apply(.scanFailed)
        flow.select(scope: .once)
        _ = flow.apply(.confirmPressed)

        XCTAssertEqual(flow.apply(.scanSucceeded), .finish(PanelDecision(approved: true, scope: .once, breadth: .listedItems)))
    }

    func testRepeatedFailuresAreCounted() {
        var flow = embedded()
        _ = flow.start()
        for expected in 1...3 {
            _ = flow.apply(.scanFailed)
            XCTAssertEqual(flow.failedScans, expected)
            _ = flow.apply(.confirmPressed)
        }
    }

    // MARK: - Refusal

    func testCancelIsTheOnlyRefusal() {
        var flow = embedded()
        _ = flow.start()

        XCTAssertEqual(flow.apply(.cancelPressed), .finish(PanelDecision(approved: false, scope: .session)))
        if case .finished(let decision) = flow.state {
            XCTAssertFalse(decision.approved)
        } else {
            XCTFail("cancel should finish the flow")
        }
    }

    func testCancelWhileTheScanIsArmedStillRefuses() {
        var flow = embedded()
        _ = flow.start()
        XCTAssertEqual(flow.state, .scanning)

        XCTAssertEqual(flow.apply(.cancelPressed), .finish(PanelDecision(approved: false, scope: .session)))
    }

    func testRunningOutOfTimeRefuses() {
        var flow = embedded()
        _ = flow.start()

        XCTAssertEqual(flow.apply(.timedOut), .finish(PanelDecision(approved: false, scope: .session)))
    }

    // MARK: - Nothing answers twice

    func testAnAnswerIsFinal() {
        var flow = embedded()
        _ = flow.start()
        let approved = flow.apply(.scanSucceeded)

        // A scan callback landing after the user already cancelled, or a second
        // press, must not change what was answered.
        XCTAssertEqual(flow.apply(.cancelPressed), approved)
        XCTAssertEqual(flow.apply(.scanSucceeded), approved)
        XCTAssertEqual(flow.apply(.timedOut), approved)
    }

    func testSelectionIsIgnoredOnceAnswered() {
        var flow = embedded()
        _ = flow.start()
        _ = flow.apply(.scanSucceeded)

        flow.select(scope: .once)
        XCTAssertEqual(flow.scope, .session, "a late control event cannot rewrite a decision")
    }

    // MARK: - The other two modes

    func testWithoutAPresenceCheckTheButtonIsTheAnswer() {
        var flow = ApprovalFlow(defaultScope: .session, presenceMode: .none)
        XCTAssertEqual(flow.start(), .showControls, "nothing arms itself")
        XCTAssertEqual(flow.state, .awaitingInput)

        flow.select(scope: .once)
        XCTAssertEqual(flow.apply(.confirmPressed), .finish(PanelDecision(approved: true, scope: .once, breadth: .listedItems)))
    }

    func testTheSystemDialogFallbackWaitsForTheButton() {
        var flow = ApprovalFlow(defaultScope: .session, presenceMode: .systemDialog)
        XCTAssertEqual(flow.start(), .showControls, "no dialog until the user asks for one")

        // The button raises the dialog rather than answering by itself, so the
        // approval still costs a real presence check.
        XCTAssertEqual(flow.apply(.confirmPressed), .beginScan)
        XCTAssertEqual(flow.apply(.scanSucceeded), .finish(PanelDecision(approved: true, scope: .session, chosenBreadth: .wholeKey)))
    }

    func testTheFallbackAlsoTreatsAFailedCheckAsNotARefusal() {
        var flow = ApprovalFlow(defaultScope: .session, presenceMode: .systemDialog)
        _ = flow.start()
        _ = flow.apply(.confirmPressed)

        XCTAssertEqual(flow.apply(.scanFailed), .showControls)
        XCTAssertEqual(flow.state, .awaitingInput)
    }

    // MARK: - Strict batches

    func testAStrictOnlyBatchScansStraightIntoOnce() {
        // The planner offers `once` alone for these, so the default the scan
        // approves is already the only thing on offer.
        var flow = embedded(default: .once)
        XCTAssertEqual(flow.start(), .beginScan)
        XCTAssertEqual(flow.apply(.scanSucceeded), .finish(PanelDecision(approved: true, scope: .once, breadth: .listedItems)))
    }
}
