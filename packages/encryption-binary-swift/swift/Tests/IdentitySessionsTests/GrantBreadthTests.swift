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

    /// The label says what you get, in vaults, not what it switches off.
    func testTheCheckboxLabelIsWordedInWhatItCovers() {
        XCTAssertEqual(
            PanelContent.breadthCheckboxLabel(vaultCount: 1),
            "Cover anything this vault can open"
        )
        XCTAssertEqual(
            PanelContent.breadthCheckboxLabel(vaultCount: 3),
            "Cover anything these vaults can open"
        )
    }

    /// The whole point of the wording. A broad approval is over the VAULT, and
    /// the list is what it covers right now rather than what defines it, so a
    /// person who reads only this line is not surprised by a thirteenth value
    /// later. The narrow sentence gets to say "only", because there the list
    /// really is the definition and the daemon enforces it.
    func testTheBroadSummaryFramesTheListRatherThanFollowingIt() {
        let broad = PanelContent.selectionSummary(
            breadth: .wholeKey, itemCount: 12, scope: .session, durationLabel: nil
        )
        XCTAssertEqual(
            broad,
            "Covers anything this vault can open, not just the 12 listed above, until this session ends."
        )
        XCTAssertTrue(broad.contains("not just"), "the list must not read as the definition of the grant")
        XCTAssertFalse(broad.contains("only"))
    }

    func testTheNarrowSummarySaysOnly() {
        XCTAssertEqual(
            PanelContent.selectionSummary(
                breadth: .listedItems, itemCount: 12, scope: .session, durationLabel: nil
            ),
            "Covers only the 12 values listed above, until this session ends."
        )
        XCTAssertEqual(
            PanelContent.selectionSummary(
                breadth: .listedItems, itemCount: 1, scope: .duration, durationLabel: "4 hours"
            ),
            "Covers only the 1 value listed above, for 4 hours."
        )
    }

    func testTheSummarySpeaksInVaultsAndCarriesTheWindow() {
        XCTAssertEqual(
            PanelContent.selectionSummary(
                breadth: .wholeKey, itemCount: 5, vaultCount: 2, scope: .once, durationLabel: nil
            ),
            "Covers anything these vaults can open, not just the 5 listed above, for this one read."
        )
        // Nothing listed, so nothing to frame.
        XCTAssertEqual(
            PanelContent.selectionSummary(
                breadth: .wholeKey, itemCount: 0, scope: .session, durationLabel: nil
            ),
            "Covers anything this vault can open, until this session ends."
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
        // True in every state, including `once`, where the grant is narrow and
        // there is no checkbox on screen to point at.
        XCTAssertFalse(
            PanelContent.unlistableSourceNote.lowercased().contains("tick"),
            "the caveat must not refer to a control that is sometimes not drawn"
        )
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

    // MARK: - "once" implies narrow

    /// The panel draws no breadth checkbox under `once`, and the grant is narrow
    /// whatever the hidden control was last set to.
    func testOnceGrantsNarrowWhateverTheCheckboxSaid() {
        var flow = ApprovalFlow(defaultScope: .session, presenceMode: .embedded, defaultBreadth: .wholeKey)
        XCTAssertEqual(flow.effectiveBreadth, .wholeKey)

        flow.select(scope: .once, breadth: .wholeKey)
        XCTAssertEqual(flow.effectiveBreadth, .listedItems, "once is narrow, ticked box or not")

        // ...and moving back off `once` returns breadth to what it was, rather
        // than leaving it stuck narrow because of a choice about time.
        flow.select(scope: .session, breadth: .wholeKey)
        XCTAssertEqual(flow.effectiveBreadth, .wholeKey)
    }

    func testAnApprovalUnderOnceRecordsNoBreadthChoice() {
        var flow = ApprovalFlow(defaultScope: .once, presenceMode: .embedded, defaultBreadth: .wholeKey)
        guard case .finish(let decision) = flow.apply(.scanSucceeded) else {
            return XCTFail("a scan should finish the flow")
        }
        XCTAssertEqual(decision.breadth, .listedItems, "the grant is narrow")
        XCTAssertNil(decision.chosenBreadth, "and the user expressed no opinion about breadth")
    }

    func testAnApprovalUnderASessionRecordsTheChoiceThatWasMade() {
        var flow = ApprovalFlow(defaultScope: .session, presenceMode: .embedded, defaultBreadth: .wholeKey)
        flow.select(scope: .session, breadth: .listedItems)
        guard case .finish(let decision) = flow.apply(.scanSucceeded) else {
            return XCTFail("a scan should finish the flow")
        }
        XCTAssertEqual(decision.breadth, .listedItems)
        XCTAssertEqual(decision.chosenBreadth, .listedItems)
    }

    /// The summary has to say what the grant covers even where no control is
    /// drawn, so `once` is not hidden state.
    func testTheSummaryStatesTheBreadthEvenWithNoCheckboxOnScreen() {
        XCTAssertEqual(
            PanelContent.selectionSummary(
                breadth: .listedItems, itemCount: 12, scope: .once, durationLabel: nil
            ),
            "Covers only the 12 values listed above, for this one read."
        )
    }

    /// Narrow never means an empty set. A `once` approval on a key that brought
    /// no digests still opens the read it was approved for, rather than refusing
    /// everything on a technicality.
    func testANarrowGrantWithNothingToNarrowToStillOpensItsRead() throws {
        let table = SessionGrantTable()
        // What the manager does for a key with no digests, whatever the breadth.
        table.grant(ref: ref, identityId: "default", scope: .once, coveredItems: nil)
        XCTAssertNoThrow(try table.consume(ref: ref, itemDigests: [digest("whatever was in the batch")]))
    }

    func testOnceIsNarrowEvenWhenThePanelOfferedNoBreadthAtAll() {
        // A batch where one key brought no digests offers no breadth control,
        // but `once` still grants narrow: the clamp guards a panel ANSWER, and
        // under once there was none to clamp.
        let decision = PanelDecision(approved: true, scope: .once, breadth: .listedItems)
        let granted = UnlockBreadthSelection.granted(by: decision, offered: [.wholeKey])
        XCTAssertEqual(granted.breadth(forVault: "local"), .listedItems)
    }

    func testAnAnswerOnTheOtherScopesIsStillClampedToWhatWasOffered() {
        let decision = PanelDecision(
            approved: true, scope: .session, breadth: .listedItems, chosenBreadth: .listedItems
        )
        XCTAssertEqual(
            UnlockBreadthSelection.granted(by: decision, offered: [.wholeKey]).breadth(forVault: "local"),
            .wholeKey
        )
        XCTAssertEqual(
            UnlockBreadthSelection
                .granted(by: decision, offered: [.listedItems, .wholeKey])
                .breadth(forVault: "local"),
            .listedItems
        )
    }

    // MARK: - The vault boundary

    /// Not a control. However broad the approval, it stops at the vaults the
    /// panel showed: a key in a vault nobody was shown is a key nobody said yes
    /// to. Today every key is in one implicit local vault, so this mostly holds
    /// trivially, but it is written as a vault rule because that is the only
    /// version that stays defensible once a second vault exists.
    func testABroadGrantDoesNotReachAVaultThatWasNotShown() {
        let live = ExistingGrantSnapshot(
            scope: .session,
            remainingMs: 4 * 60 * 60 * 1000,
            coveredItems: nil,
            vaultId: "local"
        )
        let sameVault = UnlockPlanner.plan(
            requested: [RequestedKey(keyId: keyId, vaultId: "local")],
            requestedScope: .session,
            existing: [keyId: live]
        )
        XCTAssertFalse(sameVault.requiresPrompt)

        let crossedVault = UnlockPlanner.plan(
            requested: [RequestedKey(keyId: keyId, vaultId: "team-production")],
            requestedScope: .session,
            existing: [keyId: live]
        )
        XCTAssertTrue(crossedVault.requiresPrompt, "crossing a vault always asks")
        XCTAssertEqual(crossedVault.refreshKeys.map { $0.keyId }, [keyId])
    }

    func testTheVaultBoundaryHoldsWhateverTheBreadthWas() {
        // The broadest, longest grant there is.
        let live = ExistingGrantSnapshot(
            scope: .session,
            remainingMs: SessionGrantTable.maxGrantMs,
            coveredItems: nil,
            vaultId: "local"
        )
        XCTAssertFalse(UnlockPlanner.covers(
            live: live,
            requestedScope: .once,
            requestedDurationMs: nil,
            requestedVaultId: "team-production"
        ))
        XCTAssertFalse(VaultBoundary.covers(approvedVaultId: nil, requestedVaultId: "local"))
        XCTAssertTrue(VaultBoundary.covers(approvedVaultId: "local", requestedVaultId: "local"))
    }

    func testAGrantRemembersTheVaultItWasApprovedOver() {
        let table = SessionGrantTable()
        table.grant(ref: ref, identityId: "default", scope: .session, vaultId: "team-production")
        XCTAssertEqual(table.vaultId(ref: ref), "team-production")
        XCTAssertEqual(table.liveGrant(ref: ref)?.vaultId, "team-production")
    }

    /// A key with no vault of its own is in the one implicit local vault, and a
    /// caller that names only a label still gets a boundary between labels.
    func testAVaultIdFallsBackToTheLabelAndThenToTheLocalVault() {
        XCTAssertEqual(UnlockKeyDisplay().vaultId, VaultBoundary.localVaultId)
        XCTAssertEqual(UnlockKeyDisplay(vaultLabel: "Production").vaultId, "label:production")
        XCTAssertEqual(UnlockKeyDisplay(vaultLabel: "Production", vaultId: "v_42").vaultId, "v_42")
    }

    // MARK: - One control, per-vault resolution

    /// The checkbox sets every vault today. What reads it asks per vault anyway,
    /// so a per-vault control later is a change to the panel and nothing else.
    func testOneAnswerResolvesForEveryVault() {
        let broad = UnlockBreadthSelection.uniform(.wholeKey)
        XCTAssertEqual(broad.breadth(forVault: "local"), .wholeKey)
        XCTAssertEqual(broad.breadth(forVault: "team-production"), .wholeKey)
        XCTAssertEqual(broad.narrowest, .wholeKey)

        let narrow = UnlockBreadthSelection.uniform(.listedItems)
        XCTAssertEqual(narrow.breadth(forVault: "anything"), .listedItems)
        XCTAssertEqual(narrow.narrowest, .listedItems)
    }

    func testAPerVaultAnswerIsAlreadyHonouredWhereOneIsGiven() {
        // Not reachable from the panel yet, and deliberately supported by the
        // model: broad on your own local vault, narrow on a shared one.
        let mixed = UnlockBreadthSelection(
            fallback: .wholeKey,
            byVault: ["team-production": .listedItems]
        )
        XCTAssertEqual(mixed.breadth(forVault: "local"), .wholeKey)
        XCTAssertEqual(mixed.breadth(forVault: "team-production"), .listedItems)
        XCTAssertEqual(mixed.narrowest, .listedItems, "a summary must never claim less caution than was applied")
    }

    func testAnAnswerIsClampedToWhatThePanelOffered() {
        let clamped = UnlockBreadthSelection
            .uniform(.listedItems)
            .clamped(to: [.wholeKey])
        XCTAssertEqual(clamped.breadth(forVault: "local"), .wholeKey)
    }

    func testThePlanCountsTheVaultsItIsOver() {
        let plan = UnlockPlanner.plan(
            requested: [
                RequestedKey(keyId: "a", itemDigests: [digest("1")], vaultId: "local"),
                RequestedKey(keyId: "b", itemDigests: [digest("2")], vaultId: "team-production"),
            ],
            requestedScope: .session,
            existing: [:]
        )
        XCTAssertEqual(plan.vaultIds, ["local", "team-production"])
    }

    // MARK: - The rule that cannot drift

    func testItemScopeReachesFilesAndNeverTheValueCache() {
        XCTAssertTrue(UnlockValueSource.Kind.file.isItemScopable)
        XCTAssertFalse(UnlockValueSource.Kind.cache.isItemScopable)
    }
}
