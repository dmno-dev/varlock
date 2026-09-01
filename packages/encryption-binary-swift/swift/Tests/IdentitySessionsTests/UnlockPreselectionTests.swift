import XCTest
import SessionScoping
@testable import IdentitySessions

/// Where the panel opens, and why.
///
/// Two properties matter more than any individual rule, and most of these are
/// about them:
///
///   1. nothing can move the preselection outwards. Whatever combination of
///      signals and memory arrives, the answer is never broader than the
///      built-in default.
///   2. memory only ever narrows, and choosing the default again forgets it.
///
/// Together those are why a stale or wrong memory is a nuisance rather than a
/// hole: the worst it can do is cost somebody a panel.
final class UnlockPreselectionTests: XCTestCase {
    private let bothBreadths: [SessionGrantBreadth] = [.listedItems, .wholeKey]
    private let allScopes: [SessionGrantScope] = UnlockPlanner.fullScopes

    private func preselect(
        _ signals: UnlockRiskSignals,
        remembered: UnlockNarrowing? = nil,
        breadths: [SessionGrantBreadth]? = nil,
        scopes: [SessionGrantScope]? = nil
    ) -> UnlockPreselection {
        return UnlockDefaults.preselect(
            signals: signals,
            remembered: remembered,
            offeredBreadths: breadths ?? bothBreadths,
            offeredScopes: scopes ?? allScopes
        )
    }

    // MARK: - The risk ladder

    func testAKnownKeyInItsOwnProjectIsRoutineAndLandsOnTheBroadDefault() {
        let answer = preselect(UnlockRiskSignals(seenBefore: true))
        XCTAssertEqual(answer.risk, .routine)
        XCTAssertEqual(answer.breadth, .wholeKey)
        XCTAssertEqual(answer.window.scope, .session)
        XCTAssertNil(answer.note, "nothing narrowed it, so there is nothing to explain")
    }

    func testFirstContactWithAKeyIsElevated() {
        let answer = preselect(UnlockRiskSignals(seenBefore: false))
        XCTAssertEqual(answer.risk, .elevated)
        XCTAssertEqual(answer.breadth, .listedItems)
        XCTAssertEqual(answer.window.scope, .session)
        XCTAssertEqual(answer.note, "Narrowed: this key has not been approved here before.")
    }

    func testAnAgentSessionIsElevated() {
        let answer = preselect(UnlockRiskSignals(hasAgentSession: true, seenBefore: true))
        XCTAssertEqual(answer.risk, .elevated)
        XCTAssertEqual(answer.breadth, .listedItems)
        XCTAssertEqual(answer.window.scope, .session)
    }

    /// varlock's own JavaScript under a signed interpreter is how most installs
    /// run, so it is deliberately NOT a foreign script and does not raise the
    /// risk on its own. Somebody else's script driving varlock does.
    func testAForeignScriptDrivingVarlockIsElevated() {
        let answer = preselect(UnlockRiskSignals(actorIsForeignScript: true, seenBefore: true))
        XCTAssertEqual(answer.risk, .elevated)
        XCTAssertEqual(answer.breadth, .listedItems)
    }

    func testNobodyWatchingIsUnusual() {
        let answer = preselect(UnlockRiskSignals(hasAgentSession: true, nobodyWatching: true, seenBefore: true))
        XCTAssertEqual(answer.risk, .unusual)
        XCTAssertEqual(answer.breadth, .listedItems)
        XCTAssertEqual(answer.window.scope, .once)
        XCTAssertEqual(answer.note, "Narrowed: no person is watching this session.")
    }

    func testASessionWorkingOutsideTheProjectIsUnusual() {
        let answer = preselect(UnlockRiskSignals(
            hasAgentSession: true,
            sessionOutsideProject: true,
            seenBefore: true
        ))
        XCTAssertEqual(answer.risk, .unusual)
        XCTAssertEqual(answer.window.scope, .once)
        XCTAssertEqual(answer.note, "Narrowed: this session is working outside the project.")
    }

    func testUnverifiedActorCodeIsUnusual() {
        let answer = preselect(UnlockRiskSignals(actorCodeUnverified: true, seenBefore: true))
        XCTAssertEqual(answer.risk, .unusual)
        XCTAssertEqual(answer.breadth, .listedItems)
        XCTAssertEqual(answer.window.scope, .once)
    }

    /// The rules read a fact, not a line of copy. Rewording the advisory the
    /// panel draws must never turn a risk rule off.
    func testTheOutsideProjectSignalIsReadAsAFactRatherThanFromTheAdvisoryText() {
        let session = AgentSession(
            productName: "Claude Code",
            title: nil,
            startTime: nil,
            kind: "interactive",
            workingDirectory: "/code/somewhere-else"
        )
        XCTAssertTrue(UnlockPanelContent.isWorkingOutside(session: session, projectPath: "/code/acme"))
        XCTAssertFalse(UnlockPanelContent.isWorkingOutside(session: session, projectPath: "/code/somewhere-else"))
        // Neither half on its own is evidence of anything.
        XCTAssertFalse(UnlockPanelContent.isWorkingOutside(session: session, projectPath: nil))
        XCTAssertFalse(UnlockPanelContent.isWorkingOutside(session: AgentSession?.none, projectPath: "/code/acme"))
    }

    // MARK: - Nothing may widen

    func testNoCombinationOfSignalsEverLandsBroaderThanTheDefault() {
        // Every combination of the six signals, against a memory and without one.
        for bits in 0..<64 {
            let signals = UnlockRiskSignals(
                hasAgentSession: bits & 1 != 0,
                nobodyWatching: bits & 2 != 0,
                sessionOutsideProject: bits & 4 != 0,
                actorIsForeignScript: bits & 8 != 0,
                actorCodeUnverified: bits & 16 != 0,
                seenBefore: bits & 32 != 0
            )
            for memory in [nil, UnlockNarrowing(breadth: .listedItems, window: GrantWindow(scope: .once))] {
                let answer = preselect(signals, remembered: memory)
                XCTAssertLessThanOrEqual(
                    answer.breadth.restrictiveness,
                    UnlockDefaults.breadth.restrictiveness,
                    "signals \(bits) widened the breadth"
                )
                XCTAssertLessThanOrEqual(
                    answer.window.lifetimeRank,
                    UnlockDefaults.window.lifetimeRank,
                    "signals \(bits) widened the window"
                )
            }
        }
    }

    // MARK: - Memory only narrows

    func testARememberedNarrowingTightensARoutineRequest() {
        let answer = preselect(
            UnlockRiskSignals(seenBefore: true),
            remembered: UnlockNarrowing(breadth: .listedItems, window: GrantWindow(scope: .once), approvedBefore: true)
        )
        XCTAssertEqual(answer.risk, .routine)
        XCTAssertEqual(answer.breadth, .listedItems)
        XCTAssertEqual(answer.window.scope, .once)
        XCTAssertTrue(answer.isRemembered)
        XCTAssertEqual(answer.note, UnlockDefaults.rememberedNote)
    }

    /// The most-restrictive rule, per axis. A memory that is narrower on one
    /// axis and the risk on the other take one half each.
    func testTheNarrowestOfEachAxisWins() {
        let answer = preselect(
            // unusual, so the risk alone wants once + only these
            UnlockRiskSignals(nobodyWatching: true, seenBefore: true),
            // and the memory wants a four hour window, which is longer
            remembered: UnlockNarrowing(
                breadth: .listedItems,
                window: GrantWindow(scope: .duration, durationMs: DurationPreset.fourHours.milliseconds),
                approvedBefore: true
            )
        )
        XCTAssertEqual(answer.window.scope, .once, "the shorter of the two windows wins")
        XCTAssertEqual(answer.breadth, .listedItems)
    }

    func testAMemoryTheRiskHasAlreadyOvertakenIsNotAnnouncedAsRemembered() {
        let answer = preselect(
            UnlockRiskSignals(nobodyWatching: true, seenBefore: true),
            remembered: UnlockNarrowing(breadth: .listedItems, window: GrantWindow(scope: .once), approvedBefore: true)
        )
        XCTAssertFalse(answer.isRemembered, "the risk rules got there on their own")
        XCTAssertEqual(answer.note, "Narrowed: no person is watching this session.")
    }

    // MARK: - Never preselect something the panel does not offer

    func testAPreselectionIsClampedToWhatIsOnOffer() {
        // A batch with nothing to narrow to cannot open on the narrow choice.
        let noItems = preselect(UnlockRiskSignals(nobodyWatching: true), breadths: [.wholeKey])
        XCTAssertEqual(noItems.breadth, .wholeKey)
        XCTAssertEqual(noItems.window.scope, .once, "the other axis still narrows")

        // A strict key offers only `once`, so a remembered window cannot survive.
        let strict = preselect(
            UnlockRiskSignals(seenBefore: true),
            remembered: UnlockNarrowing(
                window: GrantWindow(scope: .duration, durationMs: DurationPreset.oneHour.milliseconds)
            ),
            scopes: [.once]
        )
        XCTAssertEqual(strict.window.scope, .once)
    }

    // MARK: - Writing it down

    func testOnlyANarrowingIsRemembered() {
        let broad = UnlockPreferences.remembering(
            breadth: .wholeKey,
            window: GrantWindow(scope: .session),
            now: 10
        )
        XCTAssertNil(broad.breadth)
        XCTAssertNil(broad.window)
        XCTAssertTrue(broad.approvedBefore, "the pair has still been approved here")
    }

    func testChoosingTheDefaultAgainForgetsAPreviousNarrowing() {
        let key = UnlockPreferences.rowKey(projectPath: "/code/acme", keyId: "varlock-default")
        var rows = UnlockPreferences.apply(
            rows: [:],
            rowKey: key,
            breadth: .listedItems,
            window: GrantWindow(scope: .once),
            now: 1
        )
        XCTAssertEqual(rows[key!]?.breadth, .listedItems)
        XCTAssertEqual(rows[key!]?.window?.scope, .once)

        rows = UnlockPreferences.apply(
            rows: rows,
            rowKey: key,
            breadth: .wholeKey,
            window: GrantWindow(scope: .session),
            now: 2
        )
        XCTAssertNil(rows[key!]?.breadth)
        XCTAssertNil(rows[key!]?.window)
        XCTAssertEqual(rows[key!]?.approvedBefore, true)
    }

    func testOneAxisCanBeForgottenWithoutTheOther() {
        let key = UnlockPreferences.rowKey(projectPath: "/code/acme", keyId: "varlock-default")
        var rows = UnlockPreferences.apply(
            rows: [:], rowKey: key, breadth: .listedItems, window: GrantWindow(scope: .once), now: 1
        )
        rows = UnlockPreferences.apply(
            rows: rows, rowKey: key, breadth: .listedItems, window: GrantWindow(scope: .session), now: 2
        )
        XCTAssertEqual(rows[key!]?.breadth, .listedItems, "still narrowed on breadth")
        XCTAssertNil(rows[key!]?.window, "and back to the default on duration")
    }

    func testARequestWithNoProjectIsNotRemembered() {
        XCTAssertNil(UnlockPreferences.rowKey(projectPath: nil, keyId: "varlock-default"))
        let rows = UnlockPreferences.apply(
            rows: [:], rowKey: nil, breadth: .listedItems, window: GrantWindow(scope: .once), now: 1
        )
        XCTAssertTrue(rows.isEmpty, "one nameless bucket shared by every project would be worse than none")
    }

    // MARK: - The file

    func testAFileRoundTrips() {
        let key = UnlockPreferences.rowKey(projectPath: "/code/acme", keyId: "varlock-default")!
        let rows = [key: UnlockNarrowing(
            breadth: .listedItems,
            window: GrantWindow(scope: .duration, durationMs: DurationPreset.fourHours.milliseconds),
            approvedBefore: true,
            savedAt: 1_700_000_000_000
        )]
        let decoded = UnlockPreferences.decode(UnlockPreferences.encode(rows))
        XCTAssertEqual(decoded, rows)
    }

    /// A hand-edited file must not be able to widen a panel. `breadth: "key"` on
    /// disk is not a narrowing, so it is read as no narrowing at all.
    func testAFileCannotRememberABroadChoice() {
        let json = """
        {"version":1,"projects":{"/code/acme\\u0000varlock-default":
        {"breadth":"key","scope":"session","approvedBefore":true,"savedAt":1}}}
        """
        let decoded = UnlockPreferences.decode(Data(json.utf8))
        let entry = decoded["/code/acme\u{0000}varlock-default"]
        XCTAssertNil(entry?.breadth)
        XCTAssertNil(entry?.window)
        XCTAssertEqual(entry?.approvedBefore, true)
    }

    func testAnUnreadableFileIsTreatedAsEmpty() {
        XCTAssertTrue(UnlockPreferences.decode(Data("not json".utf8)).isEmpty)
        XCTAssertTrue(UnlockPreferences.decode(Data("{\"version\":99}".utf8)).isEmpty)
        XCTAssertTrue(UnlockPreferences.decode(nil).isEmpty)
    }

    func testForgettingScopes() {
        let acme = UnlockPreferences.rowKey(projectPath: "/code/acme", keyId: "varlock-default")!
        let other = UnlockPreferences.rowKey(projectPath: "/code/other", keyId: "varlock-default")!
        let rows = [
            acme: UnlockNarrowing(breadth: .listedItems, approvedBefore: true),
            other: UnlockNarrowing(breadth: .listedItems, approvedBefore: true),
        ]

        let oneProject = UnlockPreferences.forget(rows: rows, projectPath: "/code/acme")
        XCTAssertEqual(oneProject.forgotten, 1)
        XCTAssertEqual(Array(oneProject.rows.keys), [other])

        let everything = UnlockPreferences.forget(rows: rows)
        XCTAssertEqual(everything.forgotten, 2)
        XCTAssertTrue(everything.rows.isEmpty)
    }
}
