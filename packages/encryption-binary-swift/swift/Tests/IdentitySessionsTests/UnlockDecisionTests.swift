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

    func testEveryWindowIsOfferedAtOnce() {
        // The panel draws all of them as a row, so there is no ordering, no
        // stepping, and nothing that can leave a window unreachable. This just
        // holds the list itself steady.
        XCTAssertEqual(
            DurationPreset.allCases.map { $0.label },
            ["1 hour", "4 hours", "8 hours", "12 hours"]
        )
        // The row says "4h" where the summary sentence says "4 hours": six rungs
        // share one line, and the unit only has to be spelled out in prose.
        XCTAssertEqual(
            DurationPreset.allCases.map { $0.shortLabel },
            ["1h", "4h", "8h", "12h"]
        )
    }

    func testTheWindowLadderRunsFromLeastToMostPermissive() {
        // One question, one control, and an order that is itself information:
        // reading left to right is reading the ladder you are picking a rung on.
        XCTAssertEqual(
            PanelContent.windowOptions(scopes: UnlockPlanner.fullScopes).map { $0.label },
            ["Once", "1h", "4h", "8h", "12h", "This session"]
        )
        // The cap stays the last timed rung, so the panel can never name a
        // window longer than the grant table would honour.
        let timed = PanelContent.windowOptions(scopes: UnlockPlanner.fullScopes)
            .filter { $0.window.scope == .duration }
        XCTAssertEqual(timed.last?.window.durationMs, SessionGrantTable.maxGrantMs)
    }

    func testTheLadderOnlyOffersWhatTheRequestAllows() {
        // A strict key can only be answered once, and a panel drawing rungs it
        // would then clamp would be lying about what approving does.
        XCTAssertEqual(
            PanelContent.windowOptions(scopes: [.once]).map { $0.label },
            ["Once"]
        )
    }

    func testAnAnswerWithNoRungFallsBackToTheNarrowestOne() {
        let options = PanelContent.windowOptions(scopes: UnlockPlanner.fullScopes)
        XCTAssertEqual(
            PanelContent.windowOptionIndex(
                of: GrantWindow(scope: .duration, durationMs: DurationPreset.eightHours.milliseconds),
                in: options
            ),
            3
        )
        // A duration nothing on the row names opens on the shortest timed rung,
        // and an answer off the row entirely opens on the narrowest rung there
        // is. Neither fallback may reach outwards: opening on more than was
        // asked for is the one direction that can hand something away.
        XCTAssertEqual(
            PanelContent.windowOptionIndex(
                of: GrantWindow(scope: .duration, durationMs: 90_000),
                in: options
            ),
            1
        )
        XCTAssertEqual(
            PanelContent.windowOptionIndex(of: GrantWindow(scope: .session), in: [
                PanelWindowOption(window: GrantWindow(scope: .once)),
            ]),
            0
        )
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
                    sources: [UnlockValueSource(
                        path: ".env",
                        entries: [.init(name: "DATABASE_URL"), .init(name: "STRIPE_KEY")]
                    )]
                ),
            ])
        )
        let row = content.keyRows[0]
        XCTAssertEqual(row.valueCountLabel, "2 values")
        XCTAssertTrue(row.isExpandable)
        XCTAssertEqual(row.sources.first?.entries.map { $0.name }, ["DATABASE_URL", "STRIPE_KEY"])
        XCTAssertEqual(row.sources.first?.heading, ".env")
        XCTAssertEqual(row.sources.first?.headingCount, 2)
        XCTAssertEqual(row.sourceFootnote, PanelContent.valueSourceFootnote)
    }

    /// The cache is one of the things the key opens, so it is a line in the same
    /// list the files are in, and the line says which it is.
    func testTheValueCacheIsListedAsASourceLikeAnyOther() {
        let plan = UnlockPlanner.plan(requested: [key("dev")], requestedScope: .session, existing: [:])
        let content = UnlockPanelContent.build(
            plan: plan,
            requester: PanelRequester(summary: ""),
            display: UnlockDisplayInfo(keys: [
                "dev": UnlockKeyDisplay(
                    valueCount: 12,
                    sources: [UnlockValueSource(
                        kind: .cache,
                        entries: [.init(name: "1password", count: 8), .init(name: ".env.local", count: 4)],
                        reportedItemCount: 12
                    )]
                ),
            ])
        )
        let row = content.keyRows[0]
        XCTAssertTrue(row.isExpandable)
        XCTAssertEqual(row.valueCountLabel, "12 values")
        XCTAssertEqual(row.sources.first?.heading, "value cache")
        XCTAssertEqual(row.sources.first?.headingCount, 12)
        XCTAssertEqual(
            row.sources.first?.entries.map { $0.label },
            ["1password \u{00B7} 8", ".env.local \u{00B7} 4"]
        )
        XCTAssertEqual(row.sourceFootnote, "Sources and contents reported by the client")
    }

    /// One request covering both needs no special shape: two sources, one row.
    func testFilesAndTheCacheShareOneRowWhenOneRequestCoversBoth() {
        let plan = UnlockPlanner.plan(requested: [key("dev")], requestedScope: .session, existing: [:])
        let content = UnlockPanelContent.build(
            plan: plan,
            requester: PanelRequester(summary: ""),
            display: UnlockDisplayInfo(keys: [
                "dev": UnlockKeyDisplay(
                    valueCount: 14,
                    sources: [
                        UnlockValueSource(
                            path: ".env",
                            entries: [.init(name: "DATABASE_URL"), .init(name: "S3_KEY")]
                        ),
                        UnlockValueSource(kind: .cache, reportedItemCount: 12),
                    ]
                ),
            ])
        )
        let row = content.keyRows[0]
        XCTAssertEqual(content.keyRows.count, 1, "one key means one row, however many sources it holds")
        XCTAssertEqual(row.sources.map { $0.heading }, [".env", "value cache"])
        // the count sits beside the name as a badge, so a column of sources is
        // compared rather than read
        XCTAssertEqual(row.sources.map { $0.headingCount }, [2, 12])
        // A cache with nothing to chip about still draws: its heading is the
        // fact that matters.
        XCTAssertTrue(row.sources[1].isDrawable)
    }

    /// A badge is a claim about size, so a source of unknown size gets none.
    /// An empty pill would still say something, and a zero would say the wrong
    /// thing.
    func testASourceOfUnknownSizeGetsNoBadge() {
        let unknown = UnlockValueSource(kind: .cache)
        XCTAssertEqual(unknown.heading, "value cache")
        XCTAssertNil(unknown.headingCount)
        XCTAssertTrue(unknown.isDrawable)

        // a file the client did not name has no heading to hang a badge on, and
        // its values are listed under nothing rather than under a guess
        let nameless = UnlockValueSource(entries: [.init(name: "DATABASE_URL")])
        XCTAssertNil(nameless.heading)
        XCTAssertNil(nameless.headingCount)
    }

    /// Every count on the panel is counted the same way, so a badge and the
    /// row's own total can never tell different stories.
    func testABadgeCountsWhatTheSourceSaysItHolds() {
        // enumerated: one per entry
        XCTAssertEqual(
            UnlockValueSource(path: ".env", entries: [.init(name: "A"), .init(name: "B")]).headingCount,
            2
        )
        // summarised: what the client reported, not the number of summary lines
        XCTAssertEqual(
            UnlockValueSource(
                kind: .cache,
                entries: [.init(name: "1password", count: 120), .init(name: "aws", count: 8)],
                reportedItemCount: 128
            ).headingCount,
            128
        )
        // entries that each stand for several, with nothing reported over them
        XCTAssertEqual(
            UnlockValueSource(kind: .cache, entries: [.init(name: "1password", count: 8)]).headingCount,
            8
        )
    }

    /// A caller that said nothing must not leave a blank that reads as "there is
    /// not much in here".
    func testARowWithNoReportedContentsSaysSo() {
        let plan = UnlockPlanner.plan(requested: [key("dev")], requestedScope: .session, existing: [:])
        let content = UnlockPanelContent.build(plan: plan, requester: PanelRequester(summary: ""))
        let row = content.keyRows[0]
        XCTAssertNil(row.valueCountLabel)
        XCTAssertFalse(row.reportsContents)
        XCTAssertEqual(row.contentsLabel, "contents not reported")
        XCTAssertFalse(row.isExpandable)
    }

    func testCacheSourcesAreReadOffTheWire() {
        let display = UnlockDisplayInfo.from(payload: ["display": [
            "keys": [
                "dev": [
                    "valueCount": 12,
                    "sources": [[
                        "kind": "cache",
                        "itemCount": 12,
                        "entries": [["name": "1password", "count": 8], ["name": ".env.local", "count": 4]],
                    ]],
                ],
            ],
        ]])

        let source = display.keys["dev"]?.sources.first
        XCTAssertEqual(source?.kind, .cache)
        XCTAssertEqual(source?.itemCount, 12)
        XCTAssertEqual(source?.entries.map { $0.name }, ["1password", ".env.local"])
        XCTAssertEqual(source?.entries.first?.count, 8)
    }

    /// A source kind this daemon has never heard of is still one of the things
    /// the grant would open, so it is drawn rather than dropped.
    func testAnUnknownSourceKindIsDrawnRatherThanHidden() {
        let display = UnlockDisplayInfo.from(payload: ["display": [
            "keys": ["dev": ["sources": [["kind": "something-new", "entries": [["name": "MYSTERY"]]]]]],
        ]])
        XCTAssertEqual(display.keys["dev"]?.sources.first?.kind, .file)
        XCTAssertEqual(display.keys["dev"]?.sources.first?.entries.map { $0.name }, ["MYSTERY"])
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
                    "sources": [
                        ["path": ".env", "entries": [["name": "DATABASE_URL"], ["name": "STRIPE_KEY"]]],
                        ["path": ".env.local", "entries": [["name": "NGROK_TOKEN"]]],
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
        XCTAssertEqual(display.keys["dev"]?.sources.map { $0.path }, [".env", ".env.local"])
        XCTAssertEqual(
            display.keys["dev"]?.sources.first?.entries.map { $0.name },
            ["DATABASE_URL", "STRIPE_KEY"]
        )
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
                    "sources": (0..<20).map { index in
                        ["path": ".env.\(index)", "entries": manyNames.map { ["name": $0] }]
                    },
                    // not a colour: dropped rather than drawn
                    "vaultColor": "red; drop table",
                ],
            ],
        ]])

        let key = display.keys["dev"]
        XCTAssertNil(key?.valueCount, "a count of zero says nothing, so it is not shown")
        XCTAssertNil(key?.vaultColor)
        XCTAssertLessThanOrEqual(key?.sources.count ?? 0, UnlockKeyDisplay.maxSources)
        XCTAssertEqual(
            key?.sources.reduce(0) { $0 + $1.entries.count },
            UnlockKeyDisplay.maxEntries
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
