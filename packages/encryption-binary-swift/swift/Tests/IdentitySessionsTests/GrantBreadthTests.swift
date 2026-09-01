import XCTest
@testable import IdentitySessions

/// The breadth axis: what an item-scoped grant covers, and what it refuses.
///
/// The point of these is that item scope is ENFORCEMENT and not description. A
/// grant either opens a ciphertext or it does not, and the answer comes from a
/// digest the daemon computed rather than from anything a caller said about it.
final class GrantBreadthTests: XCTestCase {
    private let sessionId = "tty:ttys004"
    private let keyId = "varlock-default"
    private var ref: SessionGrantRef { SessionGrantRef(sessionId: sessionId, keyId: keyId) }

    private func digest(_ text: String) -> String {
        return GrantItemDigest.of(Data(text.utf8))
    }

    // MARK: - Enforcement

    func testItemScopedGrantServesTheCiphertextsItWasApprovedOver() throws {
        let table = SessionGrantTable()
        let approved = Set([digest("a"), digest("b")])
        table.grant(ref: ref, identityId: "default", scope: .session, coveredItems: approved)

        let served = try table.consume(ref: ref, itemDigests: [digest("a"), digest("b")])
        XCTAssertEqual(served.info.breadth, .listedItems)
        XCTAssertEqual(served.info.coveredItemCount, 2)
    }

    func testItemScopedGrantRefusesACiphertextItWasNotApprovedOver() {
        let table = SessionGrantTable()
        table.grant(ref: ref, identityId: "default", scope: .session, coveredItems: [digest("a")])

        XCTAssertThrowsError(try table.consume(ref: ref, itemDigests: [digest("a"), digest("smuggled")])) { error in
            guard let error = error as? SessionGrantError else { return XCTFail("wrong error type") }
            XCTAssertEqual(error.code, "GRANT_ITEM_NOT_COVERED")
        }
    }

    /// A refusal must leave the grant exactly as it was. Charging it would spend
    /// a `once` grant on a batch that returned nothing, and the caller's next
    /// move (ask again) would then be answered with "there is no grant" instead
    /// of the delta prompt it was supposed to raise.
    func testARefusalNeitherChargesNorDropsTheGrant() throws {
        let table = SessionGrantTable()
        table.grant(ref: ref, identityId: "default", scope: .once, coveredItems: [digest("a")])

        XCTAssertThrowsError(try table.consume(ref: ref, itemDigests: [digest("b")]))

        let still = try table.consume(ref: ref, itemDigests: [digest("a")])
        XCTAssertEqual(still.info.useCount, 1, "the refused batch must not have been charged")
    }

    func testAWholeKeyGrantOpensAnythingOnThatKey() throws {
        let table = SessionGrantTable()
        table.grant(ref: ref, identityId: "default", scope: .session)

        let served = try table.consume(ref: ref, itemDigests: [digest("anything at all")])
        XCTAssertEqual(served.info.breadth, .wholeKey)
        XCTAssertNil(served.info.coveredItemCount)
    }

    /// Breadth and duration are independent. A narrow grant that has been given
    /// a window keeps both halves of what it was given: it still runs out on
    /// time, and it still refuses a ciphertext outside its set while it lives.
    func testItemScopeSurvivesADurationGrant() throws {
        var now: Int64 = 1_000_000
        var monotonic: Int64 = 500
        let table = SessionGrantTable(clock: { now }, monotonicClock: { monotonic })
        table.grant(
            ref: ref,
            identityId: "default",
            scope: .duration,
            durationMs: 60_000,
            coveredItems: [digest("a")]
        )

        // Inside the window: the listed item opens, an unlisted one does not.
        now += 30_000
        monotonic += 30_000
        XCTAssertNoThrow(try table.consume(ref: ref, itemDigests: [digest("a")]))
        XCTAssertThrowsError(try table.consume(ref: ref, itemDigests: [digest("b")])) { error in
            XCTAssertEqual((error as? SessionGrantError)?.code, "GRANT_ITEM_NOT_COVERED")
        }

        // Past the window: even the listed item is gone, and the reason given is
        // the expiry rather than the breadth.
        now += 40_000
        monotonic += 40_000
        XCTAssertThrowsError(try table.consume(ref: ref, itemDigests: [digest("a")])) { error in
            XCTAssertEqual((error as? SessionGrantError)?.code, "SESSION_GRANT_EXPIRED")
        }
    }

    /// The value cache is never item scoped. A ciphertext the daemon verified
    /// against varlock's own cache file is admitted even by a narrow grant, and
    /// remembered so the same entry does not re-check on every read.
    func testAStructurallyCoveredCiphertextIsAdmittedAndRemembered() throws {
        let table = SessionGrantTable()
        table.grant(ref: ref, identityId: "default", scope: .session, coveredItems: [digest("listed")])
        let cached = digest("cache entry")

        var cacheReads = 0
        let served = try table.consume(ref: ref, itemDigests: [cached], alsoCovered: {
            cacheReads += 1
            return [cached]
        })
        XCTAssertEqual(served.info.coveredItemCount, 2, "the admitted entry joins the covered set")

        // Second read: covered outright, so the cache file is not consulted again.
        _ = try table.consume(ref: ref, itemDigests: [cached], alsoCovered: {
            cacheReads += 1
            return []
        })
        XCTAssertEqual(cacheReads, 1)
    }

    func testStructuralCoverDoesNotExcuseAnUnrelatedCiphertext() {
        let table = SessionGrantTable()
        table.grant(ref: ref, identityId: "default", scope: .session, coveredItems: [digest("listed")])

        XCTAssertThrowsError(
            try table.consume(
                ref: ref,
                itemDigests: [digest("somebody else's secret")],
                alsoCovered: { [self.digest("cache entry")] }
            )
        ) { error in
            XCTAssertEqual((error as? SessionGrantError)?.code, "GRANT_ITEM_NOT_COVERED")
        }
    }

    // MARK: - Planning

    /// A batch carrying something a live narrow grant never covered goes back
    /// through the panel, on the same path a brand-new key takes.
    func testAnUncoveredCiphertextRaisesADeltaPrompt() {
        let live = ExistingGrantSnapshot(
            scope: .session,
            remainingMs: 4 * 60 * 60 * 1000,
            coveredItems: [digest("a")]
        )
        let plan = UnlockPlanner.plan(
            requested: [RequestedKey(keyId: keyId, itemDigests: [digest("a"), digest("b")])],
            requestedScope: .session,
            existing: [keyId: live]
        )
        XCTAssertTrue(plan.requiresPrompt)
        XCTAssertEqual(plan.refreshKeys.map { $0.keyId }, [keyId])
    }

    func testACoveredCiphertextCostsNoPanel() {
        let live = ExistingGrantSnapshot(
            scope: .session,
            remainingMs: 4 * 60 * 60 * 1000,
            coveredItems: [digest("a"), digest("b")]
        )
        let plan = UnlockPlanner.plan(
            requested: [RequestedKey(keyId: keyId, itemDigests: [digest("a")])],
            requestedScope: .session,
            existing: [keyId: live]
        )
        XCTAssertFalse(plan.requiresPrompt)
        XCTAssertEqual(plan.coveredKeys.map { $0.keyId }, [keyId])
    }

    func testAWholeKeyGrantCoversAnythingTheBatchBrings() {
        let live = ExistingGrantSnapshot(scope: .session, remainingMs: 4 * 60 * 60 * 1000)
        let plan = UnlockPlanner.plan(
            requested: [RequestedKey(keyId: keyId, itemDigests: [digest("never seen before")])],
            requestedScope: .session,
            existing: [keyId: live]
        )
        XCTAssertFalse(plan.requiresPrompt)
    }

    // MARK: - What the panel may offer

    func testTheNarrowChoiceIsOfferedOnlyWhenEveryKeyBroughtItems() {
        let withItems = UnlockPlanner.plan(
            requested: [
                RequestedKey(keyId: "a", itemDigests: [digest("1")]),
                RequestedKey(keyId: "b", itemDigests: [digest("2")]),
            ],
            requestedScope: .session,
            existing: [:]
        )
        XCTAssertEqual(withItems.offeredBreadths, [.listedItems, .wholeKey])
        XCTAssertEqual(withItems.listedItemCount, 2)

        // One key with nothing to narrow to would get a grant that opens nothing.
        let mixed = UnlockPlanner.plan(
            requested: [
                RequestedKey(keyId: "a", itemDigests: [digest("1")]),
                RequestedKey(keyId: "b"),
            ],
            requestedScope: .session,
            existing: [:]
        )
        XCTAssertEqual(mixed.offeredBreadths, [.wholeKey])
        XCTAssertFalse(mixed.offersBreadthChoice)
    }

    // MARK: - Reading the request

    func testDigestsAreComputedFromPayloadsAndNotTakenFromTheCaller() {
        let payload = Data("ciphertext bytes".utf8)
        let parsed = UnlockRequestItems.from(payload: [
            "items": ["varlock-default": [payload.base64EncodedString()]],
        ])
        XCTAssertEqual(parsed["varlock-default"], [GrantItemDigest.of(payload)])
    }

    func testUnparseableItemsAreDroppedRatherThanTrusted() {
        let parsed = UnlockRequestItems.from(payload: [
            "items": ["varlock-default": ["not base64 !!!", 42, Data("ok".utf8).base64EncodedString()]],
        ])
        XCTAssertEqual(parsed["varlock-default"]?.count, 1)
    }

    func testItemsAreCappedSoOneRequestCannotBindAnUnboundedSet() {
        let many = (0..<(UnlockRequestItems.maxItemsPerKey + 50)).map {
            Data("payload \($0)".utf8).base64EncodedString()
        }
        let parsed = UnlockRequestItems.from(payload: ["items": ["varlock-default": many]])
        XCTAssertEqual(parsed["varlock-default"]?.count, UnlockRequestItems.maxItemsPerKey)
    }

    // MARK: - What the panel says

    /// The narrow label carries the number, which is what makes it obviously the
    /// smaller of the two without a legend.
    func testTheLabelsSayWhichIsNarrower() {
        XCTAssertEqual(PanelContent.breadthLabel(.listedItems, itemCount: 12), "Only these 12")
        XCTAssertEqual(PanelContent.breadthLabel(.wholeKey, itemCount: 12), "Anything on this key")
        XCTAssertEqual(
            PanelContent.breadthLabel(.wholeKey, itemCount: 12, keyCount: 2),
            "Anything on these keys"
        )
    }

    func testTheSummarySaysBothAxesInOneSentence() {
        XCTAssertEqual(
            PanelContent.selectionSummary(
                breadth: .listedItems, itemCount: 12, scope: .session, durationLabel: nil
            ),
            "Opens the 12 values listed above, until this session ends."
        )
        XCTAssertEqual(
            PanelContent.selectionSummary(
                breadth: .wholeKey, itemCount: 12, scope: .once, durationLabel: nil
            ),
            "Opens anything this key can decrypt, for this one read."
        )
        XCTAssertEqual(
            PanelContent.selectionSummary(
                breadth: .listedItems, itemCount: 1, scope: .duration, durationLabel: "4 hours"
            ),
            "Opens the 1 value listed above, for 4 hours."
        )
    }

    /// A person picking the narrow option must not walk away believing they
    /// restricted the value cache, so the caveat is drawn next to the choice.
    func testTheCacheCaveatIsDrawnWhereTheChoiceIs() {
        let cacheKey = UnlockKeyDisplay(
            valueCount: 12,
            sources: [
                UnlockValueSource(kind: .file, path: ".env.local", entries: [.init(name: "A")]),
                UnlockValueSource(kind: .cache, reportedItemCount: 4),
            ]
        )
        let display = UnlockDisplayInfo(keys: [keyId: cacheKey])
        let plan = UnlockPlanner.plan(
            requested: [RequestedKey(
                keyId: keyId,
                itemDigests: [digest("a")],
                hasUnlistableSource: true
            )],
            requestedScope: .session,
            existing: [:]
        )
        let content = UnlockPanelContent.build(
            plan: plan,
            requester: PanelRequester(summary: "a test"),
            display: display
        )
        XCTAssertTrue(content.hasUnlistableSource)
        XCTAssertTrue(PanelContent.unlistableSourceNote.contains("value cache"))
    }

    func testNoCaveatWhenThereIsNoChoiceToQualify() {
        // Nothing to narrow to, so no narrow option, so nothing to caveat.
        let plan = UnlockPlanner.plan(
            requested: [RequestedKey(keyId: keyId, hasUnlistableSource: true)],
            requestedScope: .session,
            existing: [:]
        )
        let content = UnlockPanelContent.build(plan: plan, requester: PanelRequester(summary: "a test"))
        XCTAssertFalse(content.hasUnlistableSource)
        XCTAssertEqual(content.breadths, [.wholeKey])
    }

    /// The count on the narrow label is the daemon's own, not the client's.
    func testTheNarrowCountComesFromDigestsAndNotFromTheClientsClaim() {
        let display = UnlockDisplayInfo(keys: [keyId: UnlockKeyDisplay(valueCount: 999)])
        let plan = UnlockPlanner.plan(
            requested: [RequestedKey(keyId: keyId, itemDigests: [digest("a"), digest("b")])],
            requestedScope: .session,
            existing: [:]
        )
        let content = UnlockPanelContent.build(
            plan: plan,
            requester: PanelRequester(summary: "a test"),
            display: display
        )
        XCTAssertEqual(content.listedItemCount, 2)
    }

    // MARK: - The rule that cannot drift

    func testItemScopeReachesFilesAndNeverTheValueCache() {
        XCTAssertTrue(UnlockValueSource.Kind.file.isItemScopable)
        XCTAssertFalse(UnlockValueSource.Kind.cache.isItemScopable)
    }
}
