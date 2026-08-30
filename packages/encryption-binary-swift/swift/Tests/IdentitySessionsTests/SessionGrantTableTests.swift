import XCTest
@testable import IdentitySessions

/// Lifetime rules for unlock sessions, on a clock the test controls.
///
/// These encode the promises the daemon makes about how long it may hold an
/// identity key: a grant belongs to one (session x key) pair, a `once` grant
/// serves exactly one call, nothing outlives the 12h cap measured from the
/// session's first unlock, and the last grant leaving a session is what tells
/// the daemon to crypto-erase that session's key.
final class SessionGrantTableTests: XCTestCase {

    private var now: Int64 = 1_700_000_000_000

    private func makeTable() -> SessionGrantTable {
        return SessionGrantTable(clock: { [unowned self] in self.now })
    }

    private func ref(_ session: String, _ key: String) -> SessionGrantRef {
        return SessionGrantRef(sessionId: session, keyId: key)
    }

    private func advance(hours: Double) {
        now += Int64(hours * 60 * 60 * 1000)
    }

    // MARK: - Granting

    func testGrantIsScopedToSessionAndKey() throws {
        let table = makeTable()
        table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .session)

        XCTAssertNoThrow(try table.consume(ref: ref("tty:a", "k1")))
        // same key, different session
        XCTAssertThrowsError(try table.consume(ref: ref("tty:b", "k1")))
        // same session, different key
        XCTAssertThrowsError(try table.consume(ref: ref("tty:a", "k2")))
    }

    func testSessionScopedGrantSurvivesRepeatedUse() throws {
        let table = makeTable()
        table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .session)

        for expectedCount in 1...5 {
            let result = try table.consume(ref: ref("tty:a", "k1"))
            XCTAssertEqual(result.info.useCount, expectedCount)
            XCTAssertEqual(result.info.lastUsedAt, now)
        }
        XCTAssertTrue(table.isSessionLive("tty:a"))
    }

    func testOnceGrantIsSpentAfterASingleCall() throws {
        let table = makeTable()
        table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .once)

        let result = try table.consume(ref: ref("tty:a", "k1"))
        XCTAssertEqual(result.info.useCount, 1)
        XCTAssertEqual(result.change.dropped, 1)
        XCTAssertEqual(result.change.closedSessions, ["tty:a"])

        XCTAssertThrowsError(try table.consume(ref: ref("tty:a", "k1")))
        XCTAssertFalse(table.isSessionLive("tty:a"))
    }

    func testOnceGrantDoesNotCloseSessionThatStillHoldsAnotherKey() throws {
        let table = makeTable()
        table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .once)
        table.grant(ref: ref("tty:a", "k2"), identityId: "default", scope: .session)

        let result = try table.consume(ref: ref("tty:a", "k1"))
        XCTAssertEqual(result.change.closedSessions, [])
        XCTAssertTrue(table.isSessionLive("tty:a"))
    }

    // MARK: - Expiry

    func testDurationGrantExpiresAtItsWindow() throws {
        let table = makeTable()
        let info = table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .duration, durationMs: 60_000)
        XCTAssertEqual(info.expiresAt, now + 60_000)

        now += 59_000
        XCTAssertNoThrow(try table.consume(ref: ref("tty:a", "k1")))

        now += 2_000
        XCTAssertThrowsError(try table.consume(ref: ref("tty:a", "k1"))) { error in
            XCTAssertEqual((error as? SessionGrantError)?.code, "SESSION_GRANT_EXPIRED")
        }
        XCTAssertFalse(table.isSessionLive("tty:a"))
    }

    func testDurationLongerThanCapIsClamped() {
        let table = makeTable()
        let info = table.grant(
            ref: ref("tty:a", "k1"),
            identityId: "default",
            scope: .duration,
            durationMs: 48 * 60 * 60 * 1000
        )
        XCTAssertEqual(info.expiresAt, now + SessionGrantTable.maxGrantMs)
    }

    func testSessionScopedGrantStillDiesAtTheHardCap() throws {
        let table = makeTable()
        table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .session)

        advance(hours: 11.9)
        XCTAssertNoThrow(try table.consume(ref: ref("tty:a", "k1")))

        advance(hours: 0.2)
        XCTAssertThrowsError(try table.consume(ref: ref("tty:a", "k1")))
        XCTAssertFalse(table.hasLiveSessions())
    }

    /// Re-granting must not let a caller ratchet a session past its cap: the cap is
    /// measured from the first unlock, not from the latest grant.
    func testRegrantingDoesNotExtendTheSessionCap() throws {
        let table = makeTable()
        let opened = now
        table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .session)

        advance(hours: 6)
        let second = table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .session)
        XCTAssertEqual(second.sessionUnlockedAt, opened)
        XCTAssertEqual(second.expiresAt, opened + SessionGrantTable.maxGrantMs)

        advance(hours: 6.1)
        XCTAssertThrowsError(try table.consume(ref: ref("tty:a", "k1")))
    }

    func testExpiredSessionCanBeUnlockedAgainWithAFreshCap() throws {
        let table = makeTable()
        table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .session)
        advance(hours: 13)
        XCTAssertFalse(table.hasLiveSessions())

        let reopened = table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .session)
        XCTAssertEqual(reopened.sessionUnlockedAt, now)
        XCTAssertNoThrow(try table.consume(ref: ref("tty:a", "k1")))
    }

    // MARK: - Invalidation

    func testInvalidateOneGrant() {
        let table = makeTable()
        table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .session)
        table.grant(ref: ref("tty:a", "k2"), identityId: "default", scope: .session)

        let change = table.invalidate(sessionId: "tty:a", keyId: "k1")
        XCTAssertEqual(change.dropped, 1)
        XCTAssertEqual(change.closedSessions, [])
        XCTAssertTrue(table.isSessionLive("tty:a"))
    }

    func testInvalidateOneSession() {
        let table = makeTable()
        table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .session)
        table.grant(ref: ref("tty:a", "k2"), identityId: "default", scope: .session)
        table.grant(ref: ref("tty:b", "k1"), identityId: "default", scope: .session)

        let change = table.invalidate(sessionId: "tty:a")
        XCTAssertEqual(change.dropped, 2)
        XCTAssertEqual(change.closedSessions, ["tty:a"])
        XCTAssertFalse(table.isSessionLive("tty:a"))
        XCTAssertTrue(table.isSessionLive("tty:b"))
    }

    func testInvalidateEverything() {
        let table = makeTable()
        table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .session)
        table.grant(ref: ref("tty:b", "k1"), identityId: "default", scope: .session)

        let change = table.invalidate()
        XCTAssertEqual(change.dropped, 2)
        XCTAssertEqual(change.closedSessions, ["tty:a", "tty:b"])
        XCTAssertFalse(table.hasLiveSessions())
        XCTAssertEqual(table.liveSessionIds(), [])
    }

    // MARK: - Listing

    func testListReportsLiveGrantsOldestSessionFirst() {
        let table = makeTable()
        table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .session)
        advance(hours: 1)
        table.grant(ref: ref("tty:b", "k2"), identityId: "work", scope: .duration, durationMs: 60_000)

        let listed = table.list()
        XCTAssertEqual(listed.map(\.sessionId), ["tty:a", "tty:b"])
        XCTAssertEqual(listed.map(\.scope), [.session, .duration])
        XCTAssertEqual(listed.map(\.identityId), ["default", "work"])
    }

    func testListOmitsExpiredGrants() {
        let table = makeTable()
        table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .duration, durationMs: 1_000)
        table.grant(ref: ref("tty:b", "k1"), identityId: "default", scope: .session)

        now += 2_000
        XCTAssertEqual(table.list().map(\.sessionId), ["tty:b"])
    }

    func testWireDictionaryCarriesRemainingTtl() {
        let table = makeTable()
        let info = table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .duration, durationMs: 90_000)
        let dict = info.toDictionary(now: now + 30_000)
        XCTAssertEqual(dict["expiresInMs"] as? Int64, 60_000)
        XCTAssertEqual(dict["scope"] as? String, "duration")
        XCTAssertNil(dict["lastUsedAt"])
    }

    // MARK: - Daemon lifetime

    func testDaemonSeesNoLiveSessionsUntilAGrantExists() {
        let table = makeTable()
        XCTAssertFalse(table.hasLiveSessions())

        table.grant(ref: ref("tty:a", "k1"), identityId: "default", scope: .session)
        XCTAssertTrue(table.hasLiveSessions())

        table.invalidate()
        XCTAssertFalse(table.hasLiveSessions())
    }

    func testScopeParsingRejectsUnknownWireValues() {
        XCTAssertEqual(SessionGrantScope(wireValue: "once"), .once)
        XCTAssertEqual(SessionGrantScope(wireValue: "session"), .session)
        XCTAssertEqual(SessionGrantScope(wireValue: "duration"), .duration)
        XCTAssertNil(SessionGrantScope(wireValue: "forever"))
        XCTAssertNil(SessionGrantScope(wireValue: nil))
    }
}
