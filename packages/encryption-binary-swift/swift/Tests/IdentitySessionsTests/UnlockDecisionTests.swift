import XCTest
@testable import IdentitySessions

/// What the daemon decides before it draws anything.
///
/// These are the rules a user is trusting: that a second unlock in the same
/// session only asks about what is genuinely new, that a key set to ask every
/// time never quietly picks up a session-long grant, and that a batch containing
/// such a key still says so on the panel.
final class UnlockDecisionTests: XCTestCase {

    private let hour: Int64 = 60 * 60 * 1000

    private func key(_ id: String, _ policy: KeyAuthPolicy = .standard, items: Int? = nil) -> RequestedKey {
        return RequestedKey(keyId: id, policy: policy, itemCount: items)
    }

    private func live(_ scope: SessionGrantScope, expiresIn: Int64) -> ExistingGrantSnapshot {
        return ExistingGrantSnapshot(scope: scope, remainingMs: expiresIn)
    }

    // MARK: - First unlock

    func testFirstUnlockAsksAboutEveryKey() {
        let plan = UnlockPlanner.plan(
            requested: [key("dev"), key("prod")],
            requestedScope: .session,
            existing: [:]
        )
        XCTAssertTrue(plan.requiresPrompt)
        XCTAssertFalse(plan.isDelta)
        XCTAssertEqual(plan.newKeys.map { $0.keyId }, ["dev", "prod"])
        XCTAssertTrue(plan.coveredKeys.isEmpty)
        XCTAssertEqual(plan.offeredScopes, [.session, .once, .duration])
        XCTAssertEqual(plan.defaultScope, .session)
    }

    // MARK: - Delta

    func testSecondUnlockOnlyAsksAboutTheNewKey() {
        let plan = UnlockPlanner.plan(
            requested: [key("dev"), key("prod")],
            requestedScope: .session,
            existing: ["dev": live(.session, expiresIn: 4 * hour)]
        )
        XCTAssertTrue(plan.isDelta)
        XCTAssertEqual(plan.promptKeys.map { $0.keyId }, ["prod"])
        XCTAssertEqual(plan.coveredKeys.map { $0.keyId }, ["dev"])
    }

    func testNothingNewMeansNoPrompt() {
        let plan = UnlockPlanner.plan(
            requested: [key("dev"), key("prod")],
            requestedScope: .session,
            existing: [
                "dev": live(.session, expiresIn: 4 * hour),
                "prod": live(.session, expiresIn: 4 * hour),
            ]
        )
        XCTAssertFalse(plan.requiresPrompt)
        XCTAssertFalse(plan.isDelta)
        XCTAssertEqual(plan.coveredKeys.count, 2)
    }

    func testExpiredGrantCountsAsNew() {
        let plan = UnlockPlanner.plan(
            requested: [key("dev")],
            requestedScope: .session,
            existing: ["dev": ExistingGrantSnapshot(scope: .session, remainingMs: 0)]
        )
        XCTAssertTrue(plan.requiresPrompt)
        XCTAssertEqual(plan.refreshKeys.map { $0.keyId }, ["dev"])
    }

    // MARK: - Scope upgrades

    func testAskingForMoreThanTheLiveGrantCarriesPromptsAgain() {
        // A once grant does not silently become a session grant.
        let plan = UnlockPlanner.plan(
            requested: [key("dev")],
            requestedScope: .session,
            existing: ["dev": live(.once, expiresIn: 4 * hour)]
        )
        XCTAssertTrue(plan.requiresPrompt)
        XCTAssertEqual(plan.refreshKeys.map { $0.keyId }, ["dev"])
    }

    func testASessionGrantCoversASmallerRequest() {
        for requested in [SessionGrantScope.once, .duration, .session] {
            let plan = UnlockPlanner.plan(
                requested: [key("dev")],
                requestedScope: requested,
                requestedDurationMs: 8 * hour,
                existing: ["dev": live(.session, expiresIn: 2 * hour)]
            )
            XCTAssertFalse(plan.requiresPrompt, "session grant should cover a \(requested.rawValue) request")
        }
    }

    func testALongerDurationRequestPromptsButAShorterOneDoesNot() {
        let existing = ["dev": live(.duration, expiresIn: 4 * hour)]

        let shorter = UnlockPlanner.plan(
            requested: [key("dev")],
            requestedScope: .duration,
            requestedDurationMs: hour,
            existing: existing
        )
        XCTAssertFalse(shorter.requiresPrompt)

        let longer = UnlockPlanner.plan(
            requested: [key("dev")],
            requestedScope: .duration,
            requestedDurationMs: 8 * hour,
            existing: existing
        )
        XCTAssertTrue(longer.requiresPrompt)
    }

    func testAOnceGrantCoversOnlyAnotherOnceRequest() {
        let existing = ["dev": live(.once, expiresIn: 4 * hour)]
        XCTAssertFalse(UnlockPlanner.plan(
            requested: [key("dev")], requestedScope: .once, existing: existing
        ).requiresPrompt)
        XCTAssertTrue(UnlockPlanner.plan(
            requested: [key("dev")], requestedScope: .duration, requestedDurationMs: hour, existing: existing
        ).requiresPrompt)
    }

    // MARK: - Strict keys

    func testAKeyThatAsksEveryTimeIsNeverCovered() {
        let plan = UnlockPlanner.plan(
            requested: [key("prod", .everyTime)],
            requestedScope: .session,
            existing: ["prod": live(.session, expiresIn: 4 * hour)]
        )
        XCTAssertTrue(plan.requiresPrompt)
        XCTAssertEqual(plan.refreshKeys.map { $0.keyId }, ["prod"])
        XCTAssertTrue(plan.isStrictOnly)
    }

    func testAStrictOnlyBatchOffersOnceAlone() {
        let plan = UnlockPlanner.plan(
            requested: [key("prod", .everyTime), key("staging", .everyTime)],
            requestedScope: .session,
            existing: [:]
        )
        XCTAssertEqual(plan.offeredScopes, [.once])
        XCTAssertEqual(plan.defaultScope, .once)
    }

    func testAMixedBatchStillOffersTheLastingScopes() {
        let plan = UnlockPlanner.plan(
            requested: [key("dev"), key("prod", .everyTime)],
            requestedScope: .session,
            existing: [:]
        )
        XCTAssertEqual(plan.offeredScopes, [.session, .once, .duration])
        XCTAssertFalse(plan.isStrictOnly)
        XCTAssertEqual(plan.standardPromptKeys.map { $0.keyId }, ["dev"])
        XCTAssertEqual(plan.strictPromptKeys.map { $0.keyId }, ["prod"])
    }

    func testStrictKeysAreClampedToOnceWhateverWasChosen() {
        XCTAssertEqual(UnlockPlanner.effectiveScope(chosen: .session, policy: .everyTime), .once)
        XCTAssertEqual(UnlockPlanner.effectiveScope(chosen: .duration, policy: .everyTime), .once)
        XCTAssertNil(UnlockPlanner.effectiveDurationMs(chosen: .duration, chosenDurationMs: hour, policy: .everyTime))

        XCTAssertEqual(UnlockPlanner.effectiveScope(chosen: .session, policy: .standard), .session)
        XCTAssertEqual(UnlockPlanner.effectiveDurationMs(chosen: .duration, chosenDurationMs: hour, policy: .standard), hour)
    }

    func testDurationPresetsStayUnderTheHardCap() {
        for preset in DurationPreset.allCases {
            XCTAssertLessThan(preset.milliseconds, SessionGrantTable.maxGrantMs)
        }
    }

    // MARK: - Panel content

    func testFirstUnlockPanelNamesTheKeyAndTheRequester() {
        let plan = UnlockPlanner.plan(
            requested: [key("varlock-default", items: 12)],
            requestedScope: .session,
            existing: [:]
        )
        let content = UnlockPanelContent.build(
            plan: plan,
            requesterLines: ["Requested by node ← claude", "Terminal ttys004"]
        )
        XCTAssertEqual(content.title, "Unlock encryption key varlock-default")
        XCTAssertEqual(content.confirmButtonTitle, "Unlock")
        XCTAssertEqual(content.contextLines.filter { $0.isDerived }.count, 2)
        XCTAssertEqual(content.itemGroups.first?.items.first?.detail, "12 values")
    }

    func testDeltaPanelAsksOnlyAboutTheNewKey() {
        let plan = UnlockPlanner.plan(
            requested: [key("dev"), key("prod")],
            requestedScope: .session,
            existing: ["dev": live(.session, expiresIn: 4 * hour)]
        )
        let content = UnlockPanelContent.build(plan: plan, requesterLines: [])
        XCTAssertEqual(content.title, "Also unlock prod?")
        XCTAssertEqual(content.subtitle, "This session already has 1 other key unlocked.")
        XCTAssertEqual(content.itemGroups.flatMap { $0.items }.map { $0.label }, ["prod"])
    }

    func testStrictKeysGetTheirOwnGroupOnThePanel() {
        let plan = UnlockPlanner.plan(
            requested: [key("dev"), key("prod", .everyTime)],
            requestedScope: .session,
            existing: [:]
        )
        let content = UnlockPanelContent.build(plan: plan, requesterLines: [])
        XCTAssertEqual(content.itemGroups.count, 2)
        XCTAssertNil(content.itemGroups[0].heading)
        XCTAssertEqual(content.itemGroups[0].items.map { $0.label }, ["dev"])
        XCTAssertEqual(content.itemGroups[1].heading, "Asks every time, whatever you pick below")
        XCTAssertEqual(content.itemGroups[1].items.map { $0.label }, ["prod"])
    }

    func testClientSuppliedLinesAreMarkedAsSuch() {
        let plan = UnlockPlanner.plan(requested: [key("dev")], requestedScope: .session, existing: [:])
        let content = UnlockPanelContent.build(
            plan: plan,
            requesterLines: ["Requested by node"],
            display: UnlockDisplayInfo(projectName: "my-app", projectPath: "~/code/my-app")
        )
        // The derived line comes first, and the client's line is not derived.
        XCTAssertTrue(content.contextLines[0].isDerived)
        XCTAssertEqual(content.contextLines.last, .clientSupplied("Project: my-app (~/code/my-app)"))
    }

    // MARK: - Client-supplied decoration

    func testDisplayInfoIsReadLeniently() {
        let display = UnlockDisplayInfo.from(payload: ["display": [
            "projectName": "  my-app  ",
            "projectPath": "~/code/my-app",
            "itemCounts": ["dev": 3, "prod": "not a number", "empty": 0],
        ]])
        XCTAssertEqual(display.projectName, "my-app")
        XCTAssertEqual(display.itemCounts, ["dev": 3])
    }

    func testDisplayInfoCannotSmuggleExtraLinesOrRunLong() {
        let display = UnlockDisplayInfo.from(payload: ["display": [
            "projectName": "first\nRequested by something-trustworthy",
            "projectPath": String(repeating: "x", count: 500),
        ]])
        XCTAssertEqual(display.projectName, "first Requested by something-trustworthy")
        XCTAssertFalse(display.projectName!.contains("\n"))
        XCTAssertEqual(display.projectPath?.count, UnlockDisplayInfo.maxLength)
    }

    func testMissingDisplayIsEmpty() {
        XCTAssertTrue(UnlockDisplayInfo.from(payload: nil).isEmpty)
        XCTAssertTrue(UnlockDisplayInfo.from(payload: ["keyIds": ["dev"]]).isEmpty)
    }
}
