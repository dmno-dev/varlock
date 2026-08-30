import XCTest
@testable import IdentitySessions

/// What ends an unlock session, and who gets to decide.
///
/// The resolution order is per-session override, then machine config, then the
/// built-in default. A bad value anywhere is reported and skipped rather than
/// failing the unlock: a typo in a config file must never lock someone out of
/// their own secrets, and it must never silently make sessions live LONGER than
/// they asked for either, which is why a rejected value falls through to the next
/// source rather than to `none`.
final class SessionLockPolicyTests: XCTestCase {

    private func configData(_ json: String) -> Data {
        return Data(json.utf8)
    }

    private func collectingWarnings() -> (warn: (String) -> Void, read: () -> [String]) {
        var warnings: [String] = []
        return ({ warnings.append($0) }, { warnings })
    }

    // MARK: - The policy itself

    func testDefaultIsSleep() {
        XCTAssertEqual(SessionLockPolicy.builtInDefault, .sleep)
    }

    func testScreenLockPolicyErasesOnBothEvents() {
        XCTAssertTrue(SessionLockPolicy.screenLock.erases(on: .screenLock))
        XCTAssertTrue(SessionLockPolicy.screenLock.erases(on: .sleep))
    }

    func testSleepPolicySurvivesScreenLock() {
        XCTAssertFalse(SessionLockPolicy.sleep.erases(on: .screenLock))
        XCTAssertTrue(SessionLockPolicy.sleep.erases(on: .sleep))
    }

    func testNonePolicySurvivesEverything() {
        XCTAssertFalse(SessionLockPolicy.never.erases(on: .screenLock))
        XCTAssertFalse(SessionLockPolicy.never.erases(on: .sleep))
    }

    func testWireValues() {
        XCTAssertEqual(SessionLockPolicy(wireValue: "screenLock"), .screenLock)
        XCTAssertEqual(SessionLockPolicy(wireValue: "sleep"), .sleep)
        XCTAssertEqual(SessionLockPolicy(wireValue: "none"), .never)
        XCTAssertEqual(SessionLockPolicy.never.rawValue, "none")
        XCTAssertNil(SessionLockPolicy(wireValue: "never"))
        XCTAssertNil(SessionLockPolicy(wireValue: nil))
    }

    // MARK: - Resolution order

    func testFallsBackToBuiltInDefault() {
        let resolved = LockPolicyResolution.resolve(overrideWireValue: nil, machineConfigData: nil)
        XCTAssertEqual(resolved.policy, .sleep)
        XCTAssertEqual(resolved.source, .builtInDefault)
    }

    func testMachineConfigBeatsTheDefault() {
        let resolved = LockPolicyResolution.resolve(
            overrideWireValue: nil,
            machineConfigData: configData(#"{"sessions":{"lockOn":"none"}}"#)
        )
        XCTAssertEqual(resolved.policy, .never)
        XCTAssertEqual(resolved.source, .machineConfig)
    }

    func testSessionOverrideBeatsMachineConfig() {
        let resolved = LockPolicyResolution.resolve(
            overrideWireValue: "screenLock",
            machineConfigData: configData(#"{"sessions":{"lockOn":"none"}}"#)
        )
        XCTAssertEqual(resolved.policy, .screenLock)
        XCTAssertEqual(resolved.source, .sessionOverride)
    }

    func testEmptyOverrideIsTreatedAsAbsent() {
        let resolved = LockPolicyResolution.resolve(
            overrideWireValue: "",
            machineConfigData: configData(#"{"sessions":{"lockOn":"screenLock"}}"#)
        )
        XCTAssertEqual(resolved.policy, .screenLock)
        XCTAssertEqual(resolved.source, .machineConfig)
    }

    // MARK: - Tolerating a config file that is missing or partial

    func testMissingConfigFileIsSilent() {
        let (warn, warnings) = collectingWarnings()
        let resolved = LockPolicyResolution.resolve(overrideWireValue: nil, machineConfigData: nil, warn: warn)
        XCTAssertEqual(resolved.policy, .sleep)
        XCTAssertEqual(warnings(), [])
    }

    func testConfigWithoutASessionsSectionIsSilent() {
        let (warn, warnings) = collectingWarnings()
        let resolved = LockPolicyResolution.resolve(
            overrideWireValue: nil,
            // the keys varlock already keeps in this file
            machineConfigData: configData(#"{"anonymousId":"abc","telemetryDisabled":true}"#),
            warn: warn
        )
        XCTAssertEqual(resolved.policy, .sleep)
        XCTAssertEqual(resolved.source, .builtInDefault)
        XCTAssertEqual(warnings(), [])
    }

    func testSessionsSectionWithoutLockOnIsSilent() {
        let (warn, warnings) = collectingWarnings()
        let resolved = LockPolicyResolution.resolve(
            overrideWireValue: nil,
            machineConfigData: configData(#"{"sessions":{"somethingElse":1}}"#),
            warn: warn
        )
        XCTAssertEqual(resolved.policy, .sleep)
        XCTAssertEqual(warnings(), [])
    }

    func testEmptyConfigFileIsSilent() {
        let (warn, warnings) = collectingWarnings()
        _ = LockPolicyResolution.resolve(overrideWireValue: nil, machineConfigData: Data(), warn: warn)
        XCTAssertEqual(warnings(), [])
    }

    // MARK: - Rejecting values that are present and wrong

    func testInvalidConfigValueWarnsAndFallsBackToDefault() {
        let (warn, warnings) = collectingWarnings()
        let resolved = LockPolicyResolution.resolve(
            overrideWireValue: nil,
            machineConfigData: configData(#"{"sessions":{"lockOn":"forever"}}"#),
            warn: warn
        )
        XCTAssertEqual(resolved.policy, .sleep)
        XCTAssertEqual(resolved.source, .builtInDefault)
        XCTAssertEqual(warnings().count, 1)
        XCTAssertTrue(warnings()[0].contains("forever"), warnings()[0])
        XCTAssertTrue(warnings()[0].contains("screenLock"), "the warning should list the valid values")
    }

    func testNonStringConfigValueWarns() {
        let (warn, warnings) = collectingWarnings()
        let resolved = LockPolicyResolution.resolve(
            overrideWireValue: nil,
            machineConfigData: configData(#"{"sessions":{"lockOn":true}}"#),
            warn: warn
        )
        XCTAssertEqual(resolved.policy, .sleep)
        XCTAssertEqual(warnings().count, 1)
    }

    func testUnparseableConfigWarnsAndDoesNotThrow() {
        let (warn, warnings) = collectingWarnings()
        let resolved = LockPolicyResolution.resolve(
            overrideWireValue: nil,
            machineConfigData: configData("{not json at all"),
            warn: warn
        )
        XCTAssertEqual(resolved.policy, .sleep)
        XCTAssertEqual(warnings().count, 1)
    }

    /// A bad override must not discard a good machine config: it falls through to
    /// the next source in the order, not past it.
    func testInvalidOverrideFallsThroughToMachineConfig() {
        let (warn, warnings) = collectingWarnings()
        let resolved = LockPolicyResolution.resolve(
            overrideWireValue: "sometimes",
            machineConfigData: configData(#"{"sessions":{"lockOn":"screenLock"}}"#),
            warn: warn
        )
        XCTAssertEqual(resolved.policy, .screenLock)
        XCTAssertEqual(resolved.source, .machineConfig)
        XCTAssertEqual(warnings().count, 1)
    }

    // MARK: - Per-session divergence, as the observers see it

    private func table() -> SessionGrantTable {
        return SessionGrantTable(clock: { 1_700_000_000_000 })
    }

    private func ref(_ session: String) -> SessionGrantRef {
        return SessionGrantRef(sessionId: session, keyId: "k1")
    }

    /// Three sessions, three policies, one screen lock: only the strict one goes.
    func testScreenLockErasesOnlySessionsThatOptedIn() {
        let table = self.table()
        table.grant(ref: ref("strict"), identityId: "default", scope: .session, lockOn: .screenLock)
        table.grant(ref: ref("default"), identityId: "default", scope: .session, lockOn: .sleep)
        table.grant(ref: ref("relaxed"), identityId: "default", scope: .session, lockOn: .never)

        let change = table.invalidate(onLockEvent: .screenLock)
        XCTAssertEqual(change.dropped, 1)
        XCTAssertEqual(change.closedSessions, ["strict"])
        XCTAssertEqual(table.liveSessionIds(), ["default", "relaxed"])
    }

    /// The same three, one sleep: the default policy goes too, `none` survives.
    func testSleepErasesEverythingExceptNone() {
        let table = self.table()
        table.grant(ref: ref("strict"), identityId: "default", scope: .session, lockOn: .screenLock)
        table.grant(ref: ref("default"), identityId: "default", scope: .session, lockOn: .sleep)
        table.grant(ref: ref("relaxed"), identityId: "default", scope: .session, lockOn: .never)

        let change = table.invalidate(onLockEvent: .sleep)
        XCTAssertEqual(change.dropped, 2)
        XCTAssertEqual(change.closedSessions, ["default", "strict"])
        XCTAssertEqual(table.liveSessionIds(), ["relaxed"])
    }

    /// Whatever the policy, an explicit lock takes everything.
    func testExplicitInvalidateIgnoresLockPolicy() {
        let table = self.table()
        table.grant(ref: ref("relaxed"), identityId: "default", scope: .session, lockOn: .never)
        table.grant(ref: ref("also-relaxed"), identityId: "default", scope: .session, lockOn: .never)

        let change = table.invalidate()
        XCTAssertEqual(change.dropped, 2)
        XCTAssertFalse(table.hasLiveSessions())
    }

    func testLockEventDropsEveryGrantInAnAffectedSession() {
        let table = self.table()
        table.grant(ref: SessionGrantRef(sessionId: "s", keyId: "k1"), identityId: "default", scope: .session, lockOn: .screenLock)
        table.grant(ref: SessionGrantRef(sessionId: "s", keyId: "k2"), identityId: "default", scope: .session, lockOn: .screenLock)

        let change = table.invalidate(onLockEvent: .screenLock)
        XCTAssertEqual(change.dropped, 2)
        XCTAssertEqual(change.closedSessions, ["s"])
    }

    func testDefaultPolicyAppliesWhenGrantDoesNotNameOne() {
        let table = self.table()
        table.grant(ref: ref("s"), identityId: "default", scope: .session)
        XCTAssertEqual(table.lockPolicy(forSession: "s"), .sleep)
        XCTAssertEqual(table.invalidate(onLockEvent: .screenLock).dropped, 0)
        XCTAssertEqual(table.invalidate(onLockEvent: .sleep).dropped, 1)
    }

    /// Re-unlocking is how a session changes its mind about its lock policy.
    func testRegrantingUpdatesTheSessionPolicy() {
        let table = self.table()
        table.grant(ref: ref("s"), identityId: "default", scope: .session, lockOn: .screenLock)
        XCTAssertEqual(table.lockPolicy(forSession: "s"), .screenLock)

        table.grant(ref: ref("s"), identityId: "default", scope: .session, lockOn: .never)
        XCTAssertEqual(table.lockPolicy(forSession: "s"), .never)
        XCTAssertEqual(table.invalidate(onLockEvent: .sleep).dropped, 0)
    }

    func testPolicyIsReportedInTheWireDictionary() {
        let table = self.table()
        let info = table.grant(ref: ref("s"), identityId: "default", scope: .session, lockOn: .never)
        XCTAssertEqual(info.lockOn, .never)
        XCTAssertEqual(info.toDictionary()["lockOn"] as? String, "none")
    }

    func testListReportsEachSessionsOwnPolicy() {
        let table = self.table()
        table.grant(ref: ref("a"), identityId: "default", scope: .session, lockOn: .screenLock)
        table.grant(ref: ref("b"), identityId: "default", scope: .session, lockOn: .never)

        let byId = Dictionary(uniqueKeysWithValues: table.list().map { ($0.sessionId, $0.lockOn) })
        XCTAssertEqual(byId["a"], .screenLock)
        XCTAssertEqual(byId["b"], .never)
    }
}
