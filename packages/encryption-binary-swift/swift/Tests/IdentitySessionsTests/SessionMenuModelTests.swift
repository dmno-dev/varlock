import XCTest
import SessionScoping
@testable import IdentitySessions

/// What the menu bar says about live sessions, checked without a window server.
///
/// The menu itself is a thin translation of these rows into `NSMenuItem`s, so
/// everything worth getting wrong (grouping, wording, rounding, which session a
/// Lock item belongs to) is decided here.
final class SessionMenuModelTests: XCTestCase {

    private let hour: Int64 = 60 * 60 * 1000

    private func grant(
        session: String,
        key: String,
        scope: SessionGrantScope = .session,
        remaining: Int64? = nil,
        sessionRemaining: Int64 = 12 * 60 * 60 * 1000,
        lockOn: SessionLockPolicy = .sleep
    ) -> SessionGrantInfo {
        return SessionGrantInfo(
            sessionId: session,
            keyId: key,
            identityId: "default",
            scope: scope,
            grantedAt: 1_700_000_000_000,
            expiresAt: 1_700_000_000_000 + (remaining ?? sessionRemaining),
            remainingMs: remaining ?? sessionRemaining,
            lastUsedAt: nil,
            sessionUnlockedAt: 1_700_000_000_000,
            sessionExpiresAt: 1_700_000_000_000 + sessionRemaining,
            sessionRemainingMs: sessionRemaining,
            lockOn: lockOn,
            useCount: 0
        )
    }

    // MARK: - Grouping

    func testNoGrantsMeansNoRows() {
        let model = SessionMenuModel.build(from: [])
        XCTAssertTrue(model.isEmpty)
        XCTAssertEqual(model.sessionCount, 0)
    }

    func testKeysAreGroupedUnderTheirSession() {
        let model = SessionMenuModel.build(from: [
            grant(session: "tty:ttys004:100", key: "dev"),
            grant(session: "tty:ttys004:100", key: "prod", scope: .once),
            grant(session: "ptree:900:100", key: "dev"),
        ])

        XCTAssertEqual(model.sessionCount, 2)
        XCTAssertEqual(model.rows[0].sessionId, "tty:ttys004:100")
        XCTAssertEqual(model.rows[0].keys.map(\.keyId), ["dev", "prod"])
        XCTAssertEqual(model.rows[1].keys.map(\.keyId), ["dev"])
    }

    func testRowOrderFollowsTheGrantTable() {
        let model = SessionMenuModel.build(from: [
            grant(session: "ptree:900:100", key: "dev"),
            grant(session: "tty:ttys004:100", key: "dev"),
        ])
        XCTAssertEqual(model.rows.map(\.sessionId), ["ptree:900:100", "tty:ttys004:100"])
    }

    /// The Lock item on a row has to invalidate that row's session and no other,
    /// so the id travels with it rather than being re-derived from the title.
    func testEveryRowCarriesItsSessionId() {
        let model = SessionMenuModel.build(from: [
            grant(session: "tty:ttys004:100", key: "dev"),
            grant(session: "tty:ttys009:100", key: "dev"),
        ])
        XCTAssertEqual(model.rows.map(\.sessionId), ["tty:ttys004:100", "tty:ttys009:100"])
        XCTAssertEqual(model.rows.map(\.title), ["Terminal ttys004", "Terminal ttys009"])
    }

    // MARK: - Wording

    func testKeyLineNamesTheKeyScopeAndTimeLeft() {
        let model = SessionMenuModel.build(from: [
            grant(session: "tty:ttys004:100", key: "varlock-default", scope: .session, remaining: 9 * hour),
        ])
        XCTAssertEqual(model.rows[0].keys[0].title, "varlock-default: this session, 9h left")
    }

    func testScopeLabelsAreSpelledOut() {
        XCTAssertEqual(SessionMenuModel.scopeLabel(.once), "single use")
        XCTAssertEqual(SessionMenuModel.scopeLabel(.session), "this session")
        XCTAssertEqual(SessionMenuModel.scopeLabel(.duration), "timed")
    }

    func testCapLineComparesAgainstTheTwelveHourLimit() {
        let model = SessionMenuModel.build(from: [
            grant(session: "tty:ttys004:100", key: "dev", remaining: hour, sessionRemaining: 9 * hour),
        ])
        XCTAssertEqual(model.rows[0].capLine, "12h limit: 9h left")
        // The key's own window is shorter, and says so separately.
        XCTAssertEqual(model.rows[0].keys[0].remainingLabel, "1h left")
    }

    func testLockLineNamesTheSessionsOwnPolicy() {
        for (policy, expected) in [
            (SessionLockPolicy.screenLock, "Locks on screen lock"),
            (SessionLockPolicy.sleep, "Locks on sleep"),
            (SessionLockPolicy.never, "Stays unlocked until it expires"),
        ] {
            let model = SessionMenuModel.build(from: [
                grant(session: "tty:ttys004:100", key: "dev", lockOn: policy),
            ])
            XCTAssertEqual(model.rows[0].lockLine, expected)
        }
    }

    func testLockPolicySettingLabels() {
        XCTAssertEqual(SessionMenuModel.lockPolicyMenuLabel(.screenLock), "Screen lock")
        XCTAssertEqual(SessionMenuModel.lockPolicyMenuLabel(.sleep), "Sleep")
        XCTAssertEqual(SessionMenuModel.lockPolicyMenuLabel(.never), "Only manually")
    }

    // MARK: - Rounding

    /// Coarse and rounded down. The menu is rebuilt when it opens rather than
    /// ticking, so it must never promise time that has already gone.
    func testRemainingTimeRoundsDown() {
        XCTAssertEqual(SessionMenuModel.coarseRemaining(9 * hour + 59 * 60_000), "9h left")
        XCTAssertEqual(SessionMenuModel.coarseRemaining(hour), "1h left")
        XCTAssertEqual(SessionMenuModel.coarseRemaining(hour - 1), "59m left")
        XCTAssertEqual(SessionMenuModel.coarseRemaining(90_000), "1m left")
        XCTAssertEqual(SessionMenuModel.coarseRemaining(59_000), "under a minute left")
        XCTAssertEqual(SessionMenuModel.coarseRemaining(0), "expired")
        XCTAssertEqual(SessionMenuModel.coarseRemaining(-5), "expired")
    }

    // MARK: - Session labels

    func testSessionLabelsReadAsPlaces() {
        XCTAssertEqual(SessionLabel.describe(sessionId: "tty:ttys004:1700000000"), "Terminal ttys004")
        XCTAssertEqual(SessionLabel.describe(sessionId: "ptree:41234:1700000000"), "Process 41234")
        XCTAssertEqual(
            SessionLabel.describe(sessionId: "tty:ttys004:1700000000:TMUX=/tmp/tmux-501/default,88,0"),
            "Terminal ttys004 (tmux)"
        )
        XCTAssertEqual(
            SessionLabel.describe(sessionId: "tty:ttys004:1700000000:ZELLIJ=1"),
            "Terminal ttys004 (zellij)"
        )
    }

    /// An agent session id carries a UUID that identifies the session. It belongs
    /// in the grant table, not on screen.
    func testAgentSessionLabelsDropTheIdentifierValue() {
        let label = SessionLabel.describe(
            sessionId: "env:CLAUDE_CODE_SESSION_ID:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0|tty:ttys004:1700000000"
        )
        XCTAssertEqual(label, "Terminal ttys004, Claude Code session")
        XCTAssertFalse(label.contains("0f1e2d3c"))

        let anchorless = SessionLabel.describe(sessionId: "env:CODEX_THREAD_ID:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0")
        XCTAssertEqual(anchorless, "Codex session")
        XCTAssertFalse(anchorless.contains("0f1e2d3c"))
    }

    func testUnrecognisedSessionIdIsTruncatedRatherThanDropped() {
        let label = SessionLabel.describe(sessionId: String(repeating: "z", count: 60))
        XCTAssertTrue(label.hasSuffix("..."))
        XCTAssertLessThan(label.count, 40)
    }
}
