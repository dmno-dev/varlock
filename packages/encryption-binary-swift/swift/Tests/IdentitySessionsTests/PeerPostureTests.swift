import XCTest
import SessionScoping
@testable import IdentitySessions

/// Which peers the daemon will talk to, decided on facts rather than on a live
/// socket, so the whole matrix runs headlessly.
///
/// The gating is the delicate part. A development daemon has to keep working
/// while being driven by an unhardened `bun` from a working tree, and a signed
/// release one must not quietly stop checking. These tests pin both ends of that.
final class PeerPostureTests: XCTestCase {

    private func facts(
        traced: Bool = false,
        hardened: Bool = true,
        valid: Bool = true,
        readable: Bool = true
    ) -> PeerPostureFacts {
        return PeerPostureFacts(
            isTraced: traced,
            hasHardenedRuntime: hardened,
            signatureValid: valid,
            isReadable: readable
        )
    }

    private func config(_ value: String) -> Data {
        return Data(#"{"anonymousId":"abc","sessions":{"peerPosture":"\#(value)"}}"#.utf8)
    }

    // MARK: - Evaluating

    func testCleanPeerPassesEverything() {
        let outcome = PeerPostureEvaluator.evaluate(facts: facts(), requirements: .strict)
        XCTAssertEqual(outcome, .clean)
        XCTAssertTrue(outcome.isAllowed)
    }

    func testTracedPeerIsRejectedWhenTheCheckBites() {
        let outcome = PeerPostureEvaluator.evaluate(facts: facts(traced: true), requirements: .signedRelease)
        XCTAssertEqual(outcome.rejection, .debuggerAttached)
        XCTAssertFalse(outcome.isAllowed)
    }

    func testUnhardenedPeerIsRejectedOnlyUnderStrict() {
        let unhardened = facts(hardened: false)
        XCTAssertEqual(
            PeerPostureEvaluator.evaluate(facts: unhardened, requirements: .strict).rejection,
            .hardenedRuntimeMissing
        )

        let lenient = PeerPostureEvaluator.evaluate(facts: unhardened, requirements: .signedRelease)
        XCTAssertNil(lenient.rejection)
        XCTAssertEqual(lenient.warnings, [.hardenedRuntimeMissing])
    }

    /// A debugger is the more useful thing to be told about, so it is the one
    /// reported when a peer fails both checks at once.
    func testDebuggerIsNamedAheadOfTheHardeningCheck() {
        let outcome = PeerPostureEvaluator.evaluate(
            facts: facts(traced: true, hardened: false),
            requirements: .strict
        )
        XCTAssertEqual(outcome.rejection, .debuggerAttached)
    }

    func testUnreadablePostureTakesTheHardeningSeverity() {
        let unknown = facts(readable: false)
        XCTAssertEqual(
            PeerPostureEvaluator.evaluate(facts: unknown, requirements: .strict).rejection,
            .postureUnreadable
        )

        let lenient = PeerPostureEvaluator.evaluate(facts: unknown, requirements: .signedRelease)
        XCTAssertNil(lenient.rejection)
        XCTAssertEqual(lenient.warnings, [.postureUnreadable])
    }

    func testWarningsAreStillCollectedWhenSomethingElseRejects() {
        let outcome = PeerPostureEvaluator.evaluate(
            facts: facts(traced: true, hardened: false),
            requirements: PeerPostureRequirements(debugger: .reject, hardenedRuntime: .warn)
        )
        XCTAssertEqual(outcome.rejection, .debuggerAttached)
        XCTAssertEqual(outcome.warnings, [.hardenedRuntimeMissing])
    }

    // MARK: - What each build demands

    /// The allowance dev builds run under. A `swift build` daemon is ad-hoc
    /// signed, so it never refuses a peer on posture, and the repo keeps working
    /// when driven by an unhardened runtime.
    func testDevelopmentDaemonRefusesNobody() {
        let requirements = PeerPostureEvaluator.resolve(
            selfFacts: facts(hardened: false),
            machineConfigData: nil,
            warn: { _ in }
        )
        XCTAssertEqual(requirements, .development)

        let outcome = PeerPostureEvaluator.evaluate(
            facts: facts(traced: true, hardened: false),
            requirements: requirements
        )
        XCTAssertNil(outcome.rejection)
        XCTAssertEqual(outcome.warnings, [.debuggerAttached, .hardenedRuntimeMissing])
    }

    /// And the release build does not inherit that allowance.
    func testSignedReleaseDaemonStillRejectsTracedPeers() {
        let requirements = PeerPostureEvaluator.resolve(
            selfFacts: facts(hardened: true),
            machineConfigData: nil,
            warn: { _ in }
        )
        XCTAssertEqual(requirements, .signedRelease)
        XCTAssertEqual(requirements.debugger, .reject)
    }

    // MARK: - Config

    func testStrictConfigTightensADevelopmentDaemon() {
        let requirements = PeerPostureEvaluator.resolve(
            selfFacts: facts(hardened: false),
            machineConfigData: config("strict"),
            warn: { _ in }
        )
        XCTAssertEqual(requirements, .strict)
    }

    func testWarnConfigLoosensAReleaseDaemon() {
        let requirements = PeerPostureEvaluator.resolve(
            selfFacts: facts(hardened: true),
            machineConfigData: config("warn"),
            warn: { _ in }
        )
        XCTAssertEqual(requirements, .warnOnly)
    }

    func testDefaultConfigValueKeepsTheBuildDefault() {
        XCTAssertEqual(
            PeerPostureEvaluator.resolve(
                selfFacts: facts(hardened: true),
                machineConfigData: config("default"),
                warn: { _ in }
            ),
            .signedRelease
        )
    }

    func testInvalidConfigValueIsReportedAndIgnored() {
        var warnings: [String] = []
        let requirements = PeerPostureEvaluator.resolve(
            selfFacts: facts(hardened: true),
            machineConfigData: config("whatever"),
            warn: { warnings.append($0) }
        )
        XCTAssertEqual(requirements, .signedRelease)
        XCTAssertEqual(warnings.count, 1)
        XCTAssertTrue(warnings[0].contains("peerPosture"))
    }

    func testMissingOrUnparseableConfigIsNotAnError() {
        var warnings: [String] = []
        XCTAssertEqual(
            PeerPostureEvaluator.resolve(selfFacts: facts(), machineConfigData: nil, warn: { warnings.append($0) }),
            .signedRelease
        )
        XCTAssertEqual(
            PeerPostureEvaluator.resolve(
                selfFacts: facts(),
                machineConfigData: Data(#"{"sessions":{"lockOn":"sleep"}}"#.utf8),
                warn: { warnings.append($0) }
            ),
            .signedRelease
        )
        XCTAssertTrue(warnings.isEmpty)

        XCTAssertEqual(
            PeerPostureEvaluator.resolve(
                selfFacts: facts(),
                machineConfigData: Data("{ not json".utf8),
                warn: { warnings.append($0) }
            ),
            .signedRelease
        )
        XCTAssertEqual(warnings.count, 1)
    }

    // MARK: - Reporting

    func testEachCheckHasItsOwnCodeAndLine() {
        let all: [PeerPostureViolation] = [.debuggerAttached, .hardenedRuntimeMissing, .postureUnreadable]
        let codes = all.map(\.code)
        XCTAssertEqual(Set(codes).count, all.count)
        XCTAssertEqual(codes, [
            "PEER_DEBUGGER_ATTACHED",
            "PEER_HARDENED_RUNTIME_MISSING",
            "PEER_POSTURE_UNREADABLE",
        ])

        let lines = all.map { $0.stderrLine(pid: 42, path: "/usr/local/bin/node", severity: .reject) }
        XCTAssertEqual(Set(lines).count, all.count)
        for line in lines {
            XCTAssertTrue(line.contains("pid=42"))
            XCTAssertTrue(line.contains("/usr/local/bin/node"))
            XCTAssertTrue(line.hasSuffix("\n"))
        }
    }

    func testWarnLinesSayTheConnectionWasServed() {
        let rejected = PeerPostureViolation.debuggerAttached.stderrLine(pid: 1, path: "x", severity: .reject)
        let warned = PeerPostureViolation.debuggerAttached.stderrLine(pid: 1, path: "x", severity: .warn)
        XCTAssertTrue(rejected.contains("rejected"))
        XCTAssertTrue(warned.contains("allowed"))
    }

    // MARK: - Live reader

    /// The reader has to work against a real process, so it is checked against the
    /// one process a test can be sure about: itself, untraced.
    func testReaderDescribesThisProcess() {
        let selfFacts = PeerPostureReader().selfFacts()
        XCTAssertTrue(selfFacts.isReadable)
        XCTAssertFalse(selfFacts.isTraced)
    }

    func testReaderReportsAnUnknownPidAsUnreadable() {
        // A pid that cannot exist, so csops has nothing to answer about.
        XCTAssertEqual(PeerPostureReader().facts(forPid: -1), .unreadable)
    }
}
