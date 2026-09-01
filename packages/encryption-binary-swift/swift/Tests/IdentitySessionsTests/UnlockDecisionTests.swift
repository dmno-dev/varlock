import XCTest
@testable import IdentitySessions
import SessionScoping

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

    func testDurationPresetsNeverOfferMoreThanTheHardCap() {
        for preset in DurationPreset.allCases {
            XCTAssertLessThanOrEqual(preset.milliseconds, SessionGrantTable.maxGrantMs)
        }
        // The longest window on offer is the cap itself: a choice the grant table
        // would silently clip is a choice that lied to the user.
        XCTAssertEqual(DurationPreset.allCases.last?.milliseconds, SessionGrantTable.maxGrantMs)
    }

    func testTheWindowsCycleSoThePickerIsNeverDead() {
        // The panel steps through these when a menu cannot be drawn, so every
        // window has to stay reachable by clicking.
        var seen: [DurationPreset] = [.default]
        var current = DurationPreset.default
        for _ in 0..<DurationPreset.allCases.count {
            current = current.next
            if !seen.contains(current) { seen.append(current) }
        }
        XCTAssertEqual(Set(seen), Set(DurationPreset.allCases))
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
            requester: PanelRequester(
                summary: "Requested by node in ttys004",
                details: [.derived("Process: node ← claude"), .derived("Terminal ttys004")]
            )
        )
        // The default key's id is an implementation detail; the panel says what
        // it is instead, and draws the name as an identifier.
        XCTAssertEqual(content.title, "Unlock local encryption")
        XCTAssertEqual(content.titleSegments, [.plain("Unlock "), .code("local encryption")])
        XCTAssertEqual(content.confirmButtonTitle, "Unlock")
        // One line at rest, the chain behind the disclosure.
        XCTAssertEqual(content.requester.summary, "Requested by node in ttys004")
        XCTAssertEqual(content.requester.details.count, 2)
        XCTAssertEqual(content.keyRows.first?.keyId, "varlock-default")
        XCTAssertEqual(content.keyRows.first?.valueCountLabel, "12 values")
    }

    func testTwoKeysAreBothNamedInTheHeading() {
        let plan = UnlockPlanner.plan(
            requested: [key("dev"), key("prod")],
            requestedScope: .session,
            existing: [:]
        )
        let content = UnlockPanelContent.build(plan: plan, requester: PanelRequester(summary: ""))
        XCTAssertEqual(content.title, "Unlock dev and prod")
        XCTAssertEqual(content.keyRows.map { $0.displayName }, ["dev", "prod"])
    }

    func testTheProjectIsTheHerosSecondLine() {
        let plan = UnlockPlanner.plan(requested: [key("dev")], requestedScope: .session, existing: [:])
        let content = UnlockPanelContent.build(
            plan: plan,
            requester: PanelRequester(summary: ""),
            display: UnlockDisplayInfo(projectName: "acme-api")
        )
        XCTAssertEqual(content.subtitle, "for acme-api")
    }

    func testTheVaultTagNamesTheVaultAndNeverRepeatsTheRow() {
        let plan = UnlockPlanner.plan(
            requested: [key("varlock-default"), key("prod")],
            requestedScope: .session,
            existing: [:]
        )
        let content = UnlockPanelContent.build(
            plan: plan,
            requester: PanelRequester(summary: ""),
            display: UnlockDisplayInfo(keys: [
                "prod": UnlockKeyDisplay(vaultLabel: "acme-team vault", vaultColor: "#b48ce8"),
            ])
        )
        let rows = Dictionary(uniqueKeysWithValues: content.keyRows.map { ($0.keyId, $0) })
        // The default key is already called "local encryption", so tagging it
        // with the same words would only be the row saying itself twice.
        XCTAssertNil(rows["varlock-default"]?.vaultLabel)
        XCTAssertEqual(rows["prod"]?.vaultLabel, "acme-team vault")
        XCTAssertEqual(rows["prod"]?.vaultColor, "#b48ce8")
    }

    func testTheTopBarFactFollowsWhatTheApprovalCanActuallyDo() {
        let sessionPlan = UnlockPlanner.plan(requested: [key("dev")], requestedScope: .session, existing: [:])
        XCTAssertEqual(
            UnlockPanelContent.build(
                plan: sessionPlan,
                requester: PanelRequester(summary: ""),
                lockOn: .screenLock
            ).factLine,
            "Sessions end on screen lock \u{00B7} 12h max"
        )

        // A batch that can only ever be approved once has no session to talk
        // about, so the fact worth stating is the other one.
        let strictPlan = UnlockPlanner.plan(
            requested: [key("prod", .everyTime)],
            requestedScope: .session,
            existing: [:]
        )
        XCTAssertEqual(
            UnlockPanelContent.build(plan: strictPlan, requester: PanelRequester(summary: "")).factLine,
            "Recorded to the audit log"
        )
    }

    func testDeltaPanelAsksOnlyAboutTheNewKey() {
        let plan = UnlockPlanner.plan(
            requested: [key("dev"), key("prod")],
            requestedScope: .session,
            existing: ["dev": live(.session, expiresIn: 4 * hour)]
        )
        let content = UnlockPanelContent.build(plan: plan, requester: PanelRequester(summary: ""))
        XCTAssertEqual(content.title, "Also unlock prod")
        XCTAssertEqual(content.notes, ["This session already has 1 other key unlocked."])
        XCTAssertEqual(content.keyRows.map { $0.keyId }, ["prod"])
    }

    func testAStrictKeyIsMarkedOnItsOwnRow() {
        let plan = UnlockPlanner.plan(
            requested: [key("dev"), key("prod", .everyTime)],
            requestedScope: .session,
            existing: [:]
        )
        let content = UnlockPanelContent.build(plan: plan, requester: PanelRequester(summary: ""))
        XCTAssertEqual(content.keyRows.map { $0.keyId }, ["dev", "prod"])
        XCTAssertNil(content.keyRows[0].note)
        XCTAssertEqual(content.keyRows[1].note, "asks every time")
    }

    func testValueNamesRideAlongOnTheirKeysRow() {
        let plan = UnlockPlanner.plan(requested: [key("dev")], requestedScope: .session, existing: [:])
        let content = UnlockPanelContent.build(
            plan: plan,
            requester: PanelRequester(summary: ""),
            display: UnlockDisplayInfo(keys: [
                "dev": UnlockKeyDisplay(
                    valueCount: 2,
                    files: [UnlockValueFile(path: ".env", valueNames: ["DATABASE_URL", "STRIPE_KEY"])]
                ),
            ])
        )
        let row = content.keyRows[0]
        XCTAssertEqual(row.valueCountLabel, "2 values")
        XCTAssertTrue(row.isExpandable)
        XCTAssertEqual(row.files.first?.valueNames, ["DATABASE_URL", "STRIPE_KEY"])
    }

    func testClientSuppliedLinesAreMarkedAsSuch() {
        let plan = UnlockPlanner.plan(requested: [key("dev")], requestedScope: .session, existing: [:])
        let content = UnlockPanelContent.build(
            plan: plan,
            requester: PanelRequester(summary: "Requested by node", details: [.derived("Process: node")]),
            display: UnlockDisplayInfo(projectName: "my-app", projectPath: "~/code/my-app")
        )
        // The derived line comes first among the details, and the client's line is
        // not derived. Neither the summary nor the derived detail can be displaced
        // by what the client sent.
        XCTAssertEqual(content.requester.summary, "Requested by node")
        XCTAssertTrue(content.requester.details[0].isDerived)
        XCTAssertEqual(content.requester.details.last, PanelContextLine.clientSupplied("Project: my-app (~/code/my-app)"))
    }

    // MARK: - What the system's own sheet says

    func testTheSystemSheetSaysTheShortestTrueThing() {
        // macOS builds the sentence ("Varlock is trying to ..."), so this is only
        // ever its tail. The panel is the surface that says who is asking and
        // what they get; a sheet that covers the panel and repeats it badly is
        // the worst of both.
        let plan = UnlockPlanner.plan(
            requested: [key("varlock-default", items: 12)],
            requestedScope: .session,
            existing: [:]
        )
        let content = UnlockPanelContent.build(
            plan: plan,
            requester: PanelRequester(summary: "Requested by node in ttys004"),
            display: UnlockDisplayInfo(projectName: "acme-api")
        )
        XCTAssertEqual(content.presenceReason, "unlock local encryption")
        // The requester belongs to the panel, and the key id belongs to nobody.
        XCTAssertFalse(content.presenceReason.contains("node"))
        XCTAssertFalse(content.presenceReason.contains("varlock-default"))
    }

    func testTheSheetNamesEveryKeyItCanAndCountsTheRest() {
        func reason(_ keyIds: [String]) -> String {
            let plan = UnlockPlanner.plan(
                requested: keyIds.map { key($0) },
                requestedScope: .session,
                existing: [:]
            )
            return UnlockPanelContent.build(plan: plan, requester: PanelRequester(summary: "")).presenceReason
        }
        XCTAssertEqual(reason(["dev"]), "unlock dev")
        XCTAssertEqual(reason(["dev", "prod"]), "unlock dev and prod")
        XCTAssertEqual(reason(["dev", "prod", "staging"]), "unlock 3 encryption keys")
    }

    func testTheSheetPrefersAVaultNameOverTheDefaultKeysNonName() {
        let display = UnlockDisplayInfo(keys: [
            "varlock-default": UnlockKeyDisplay(vaultLabel: "acme-team vault"),
        ])
        XCTAssertEqual(
            UnlockPanelContent.presenceReason(forKeyIds: ["varlock-default"], display: display),
            "unlock acme-team vault"
        )
        // Without one, the default key still has something to be called.
        XCTAssertEqual(
            UnlockPanelContent.presenceReason(forKeyIds: ["varlock-default"], display: UnlockDisplayInfo()),
            "unlock local encryption"
        )
        // A key the user named keeps its own name, whatever vault it is in.
        XCTAssertEqual(
            UnlockPanelContent.presenceReason(
                forKeyIds: ["prod"],
                display: UnlockDisplayInfo(keys: ["prod": UnlockKeyDisplay(vaultLabel: "acme-team vault")])
            ),
            "unlock prod"
        )
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

    func testPerKeyValueMetadataIsRead() {
        let display = UnlockDisplayInfo.from(payload: ["display": [
            "keys": [
                "dev": [
                    "valueCount": 3,
                    "files": [
                        ["path": ".env", "valueNames": ["DATABASE_URL", "STRIPE_KEY"]],
                        ["path": ".env.local", "valueNames": ["NGROK_TOKEN"]],
                    ],
                ],
                "prod": [
                    "valueCount": 1,
                    "vaultLabel": "acme-team vault",
                    "vaultColor": "#B48CE8",
                ],
            ],
        ]])

        XCTAssertEqual(display.keys["dev"]?.valueCount, 3)
        XCTAssertEqual(display.keys["dev"]?.files.map { $0.path }, [".env", ".env.local"])
        XCTAssertEqual(display.keys["dev"]?.files.first?.valueNames, ["DATABASE_URL", "STRIPE_KEY"])
        XCTAssertEqual(display.keys["prod"]?.vaultLabel, "acme-team vault")
        XCTAssertEqual(display.keys["prod"]?.vaultColor, "#b48ce8")
        XCTAssertEqual(display.valueCount(forKey: "dev"), 3)
    }

    func testValueMetadataIsCappedAndSanitised() {
        let manyNames = (0..<200).map { "VALUE_\($0)" }
        let display = UnlockDisplayInfo.from(payload: ["display": [
            "keys": [
                "dev": [
                    "valueCount": 0,
                    "files": (0..<20).map { ["path": ".env.\($0)", "valueNames": manyNames] },
                    // not a colour: dropped rather than drawn
                    "vaultColor": "red; drop table",
                ],
            ],
        ]])

        let key = display.keys["dev"]
        XCTAssertNil(key?.valueCount, "a count of zero says nothing, so it is not shown")
        XCTAssertNil(key?.vaultColor)
        XCTAssertLessThanOrEqual(key?.files.count ?? 0, UnlockKeyDisplay.maxFiles)
        XCTAssertEqual(
            key?.files.reduce(0) { $0 + $1.valueNames.count },
            UnlockKeyDisplay.maxValueNames
        )
    }

    func testValueMetadataFallsBackToTheItemCountsForm() {
        let display = UnlockDisplayInfo.from(payload: ["display": ["itemCounts": ["dev": 12]]])
        XCTAssertEqual(display.valueCount(forKey: "dev"), 12)
        XCTAssertNil(display.valueCount(forKey: "prod"))
    }

    // MARK: - Which keys were asked for

    func testBothKeyFormsAreAccepted() {
        XCTAssertEqual(UnlockRequestKeys.from(payload: ["keyIds": ["prod", "dev"]]), ["dev", "prod"])
        XCTAssertEqual(UnlockRequestKeys.from(payload: ["keyId": "dev"]), ["dev"])
        XCTAssertEqual(
            UnlockRequestKeys.from(payload: ["keyIds": ["prod"], "keyId": "dev"]),
            ["dev", "prod"]
        )
    }

    func testKeysAreDedupedAndOrderedSoOneUnlockCoversTheSameSet() {
        XCTAssertEqual(
            UnlockRequestKeys.from(payload: ["keyIds": ["prod", "dev", "prod"], "keyId": "dev"]),
            ["dev", "prod"]
        )
    }

    func testNamingNoKeyResolvesToNothingRatherThanADefault() {
        // The daemon turns an empty list into NO_KEYS_REQUESTED. What must never
        // happen is a key the caller did not name appearing here.
        XCTAssertEqual(UnlockRequestKeys.from(payload: nil), [])
        XCTAssertEqual(UnlockRequestKeys.from(payload: [:]), [])
        XCTAssertEqual(UnlockRequestKeys.from(payload: ["keyIds": []]), [])
        XCTAssertEqual(UnlockRequestKeys.from(payload: ["scope": "session"]), [])
    }

    func testBlankAndNonStringKeyIdsAreDropped() {
        XCTAssertEqual(UnlockRequestKeys.from(payload: ["keyIds": ["", "   ", "\n"]]), [])
        XCTAssertEqual(UnlockRequestKeys.from(payload: ["keyId": ""]), [])
        XCTAssertEqual(UnlockRequestKeys.from(payload: ["keyIds": [42, true, "dev"]]), ["dev"])
        XCTAssertEqual(UnlockRequestKeys.from(payload: ["keyIds": "not-an-array"]), [])
    }

    func testMissingDisplayIsEmpty() {
        XCTAssertTrue(UnlockDisplayInfo.from(payload: nil).isEmpty)
        XCTAssertTrue(UnlockDisplayInfo.from(payload: ["keyIds": ["dev"]]).isEmpty)
    }
}

/// Cross-checking the agent session against the project being unlocked.
///
/// Two halves that arrive by different routes: the session comes off the kernel
/// and the agent's own record of itself, the project comes off the client. Only
/// together do they say anything, and what they say is an observation rather
/// than an accusation, so these pin down when the panel stays quiet as hard as
/// when it speaks.
final class SessionAdvisoryTests: XCTestCase {
    private func session(kind: String? = "interactive", cwd: String?) -> AgentSession {
        return AgentSession(
            productName: "Claude Code",
            title: "a session",
            startTime: nil,
            kind: kind,
            workingDirectory: cwd
        )
    }

    func testAnAgentInsideTheProjectSaysNothing() {
        XCTAssertTrue(UnlockPanelContent.sessionAdvisories(
            session: session(cwd: "/Users/dev/projects/api/packages/core"),
            projectPath: "/Users/dev/projects/api"
        ).isEmpty)
        // The project directory itself counts as inside it.
        XCTAssertTrue(UnlockPanelContent.sessionAdvisories(
            session: session(cwd: "/Users/dev/projects/api"),
            projectPath: "/Users/dev/projects/api"
        ).isEmpty)
    }

    func testAnAgentSomewhereElseIsSaidOutLoud() {
        let advisories = UnlockPanelContent.sessionAdvisories(
            session: session(cwd: "/Users/dev/projects/other"),
            projectPath: "/Users/dev/projects/api"
        )
        XCTAssertEqual(advisories.count, 1)
        XCTAssertTrue(advisories[0].contains("/Users/dev/projects/other"))
    }

    func testANeighbourWithASharedPrefixIsNotInsideAnything() {
        // "/a/project-two" starts with "/a/project" and is a different directory.
        XCTAssertEqual(
            UnlockPanelContent.sessionAdvisories(
                session: session(cwd: "/Users/dev/projects/api-two"),
                projectPath: "/Users/dev/projects/api"
            ).count,
            1
        )
    }

    func testThePrivatePrefixAndSymlinksAreNotAnAnomaly() {
        // /tmp is a symlink to /private/tmp on macOS, and the two sides of this
        // comparison reach the same directory by different routes. A panel that
        // cried anomaly over that would be trained away inside a week.
        XCTAssertTrue(UnlockPanelContent.pathIsInside("/private/tmp/work", of: "/tmp/work"))
        XCTAssertTrue(UnlockPanelContent.pathIsInside("/tmp/work/inner", of: "/private/tmp/work"))
        XCTAssertFalse(UnlockPanelContent.pathIsInside("/tmp/other", of: "/tmp/work"))
    }

    func testWithOnlyOneHalfNothingIsSaid() {
        // The agent not saying where it is, is not evidence of anything.
        XCTAssertTrue(UnlockPanelContent.sessionAdvisories(
            session: session(cwd: nil),
            projectPath: "/Users/dev/projects/api"
        ).isEmpty)
        XCTAssertTrue(UnlockPanelContent.sessionAdvisories(
            session: session(cwd: "/Users/dev/projects/other"),
            projectPath: nil
        ).isEmpty)
        XCTAssertTrue(UnlockPanelContent.sessionAdvisories(session: nil, projectPath: "/a").isEmpty)
    }

    func testBothProblemsAreSaidWhenBothAreTrue() {
        let advisories = UnlockPanelContent.sessionAdvisories(
            session: session(kind: "print", cwd: "/Users/dev/projects/other"),
            projectPath: "/Users/dev/projects/api"
        )
        // Nobody watching comes first: it is the one that changes what "this
        // session" means.
        XCTAssertEqual(advisories.count, 2)
        XCTAssertTrue(advisories[0].contains("no person is watching"))
        XCTAssertTrue(advisories[1].contains("not in the project above"))
    }

    func testTheClientsVersionClaimIsCarriedAndLabelled() {
        let content = UnlockPanelContent.build(
            plan: UnlockPlanner.plan(
                requested: [RequestedKey(keyId: "varlock-default")],
                requestedScope: .session,
                existing: [:]
            ),
            requester: PanelRequester(summary: "Requested by varlock"),
            display: UnlockDisplayInfo(varlockVersion: "1.17.1-dev")
        )
        XCTAssertEqual(content.reportedVarlockVersion, "1.17.1-dev")
    }

    func testAVersionThatIsNotOneIsDropped() {
        // Client-supplied, so it is checked for being a version at all rather
        // than drawn because it arrived.
        XCTAssertEqual(
            UnlockDisplayInfo.from(payload: ["display": ["varlockVersion": "1.17.1-dev"]]).varlockVersion,
            "1.17.1-dev"
        )
        XCTAssertNil(
            UnlockDisplayInfo.from(payload: ["display": ["varlockVersion": "1.0 \u{1F600} and a sentence"]])
                .varlockVersion
        )
        XCTAssertNil(
            UnlockDisplayInfo.from(payload: ["display": ["varlockVersion": String(repeating: "9", count: 200)]])
                .varlockVersion
        )
    }
}
