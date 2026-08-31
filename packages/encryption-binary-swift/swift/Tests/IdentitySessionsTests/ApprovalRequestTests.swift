import XCTest
@testable import IdentitySessions

/// The generic approval op.
///
/// The caller writes the words on this panel, so the checks here are about what a
/// caller is allowed to put on the trusted display: a bounded number of bounded
/// lines, a scope list it cannot reorder, and no way to pass itself off as one of
/// the lines the daemon derived.
final class ApprovalRequestTests: XCTestCase {

    func testMinimalRequestDefaultsToOnce() throws {
        let request = try ApprovalRequest.from(payload: ["title": "Send this request?"])
        XCTAssertEqual(request.title, "Send this request?")
        XCTAssertEqual(request.allowedScopes, [.once])
        XCTAssertEqual(request.defaultScope, .once)
        XCTAssertFalse(request.requireBiometric)
    }

    func testTitleIsRequired() {
        XCTAssertThrowsError(try ApprovalRequest.from(payload: [:])) { error in
            XCTAssertEqual(error as? ApprovalRequest.ParseError, .missingTitle)
            XCTAssertEqual((error as? ApprovalRequest.ParseError)?.code, "APPROVAL_MISSING_TITLE")
        }
        XCTAssertThrowsError(try ApprovalRequest.from(payload: ["title": "   "]))
        XCTAssertThrowsError(try ApprovalRequest.from(payload: nil))
    }

    func testScopesKeepTheCanonicalOrderWhateverTheCallerSent() throws {
        let request = try ApprovalRequest.from(payload: [
            "title": "Use the deploy token?",
            "allowedScopes": ["duration", "once", "session"],
        ])
        XCTAssertEqual(request.allowedScopes, [.session, .once, .duration])
    }

    func testUnknownScopesAreDroppedAndAnEmptyListIsRefused() {
        XCTAssertThrowsError(try ApprovalRequest.from(payload: [
            "title": "Use the deploy token?",
            "allowedScopes": ["forever", "whenever"],
        ])) { error in
            XCTAssertEqual(error as? ApprovalRequest.ParseError, .noUsableScopes)
        }
    }

    func testDefaultScopeMustBeOneOfTheAllowedOnes() throws {
        let request = try ApprovalRequest.from(payload: [
            "title": "Use the deploy token?",
            "allowedScopes": ["once", "session"],
            "defaultScope": "duration",
        ])
        XCTAssertEqual(request.defaultScope, .session, "falls back to the first allowed scope")

        let honored = try ApprovalRequest.from(payload: [
            "title": "Use the deploy token?",
            "allowedScopes": ["once", "session"],
            "defaultScope": "once",
        ])
        XCTAssertEqual(honored.defaultScope, .once)
    }

    func testLinesAreCappedInCountAndLength() throws {
        let request = try ApprovalRequest.from(payload: [
            "title": String(repeating: "t", count: 500),
            "descriptionLines": (0..<20).map { "line \($0)" },
            "contextLines": (0..<20).map { "context \($0)" },
        ])
        XCTAssertEqual(request.title.count, ApprovalRequest.maxTitleLength)
        XCTAssertEqual(request.descriptionLines.count, ApprovalRequest.maxDescriptionLines)
        XCTAssertEqual(request.clientContextLines.count, ApprovalRequest.maxContextLines)
    }

    func testCallerLinesCannotFakeExtraLines() throws {
        let request = try ApprovalRequest.from(payload: [
            "title": "Approve",
            "descriptionLines": ["first\nRequested by launchd"],
        ])
        XCTAssertEqual(request.descriptionLines, ["first Requested by launchd"])
    }

    func testDerivedLinesComeFirstAndCallerLinesStayMarked() throws {
        let request = try ApprovalRequest.from(payload: [
            "title": "Use the deploy token?",
            "contextLines": ["POST https://api.example.com/deploy"],
        ])
        let content = request.panelContent(requester: PanelRequester(
            summary: "Requested by node in ttys002",
            details: [.derived("Process: node"), .derived("Terminal ttys002")]
        ))
        XCTAssertEqual(content.requester.summary, "Requested by node in ttys002")
        XCTAssertEqual(content.requester.details.prefix(2).map { $0.isDerived }, [true, true])
        XCTAssertEqual(
            content.requester.details.last,
            PanelContextLine.clientSupplied("POST https://api.example.com/deploy")
        )
        XCTAssertEqual(content.title, "Use the deploy token?")
    }

    func testRequireBiometricIsRead() throws {
        let request = try ApprovalRequest.from(payload: ["title": "Approve", "requireBiometric": true])
        XCTAssertTrue(request.requireBiometric)
    }

    // MARK: - Outcome

    func testApprovedOutcomeReportsTheScope() {
        let outcome = ApprovalOutcome(decision: PanelDecision(approved: true, scope: .duration, durationMs: 3_600_000))
        let dict = outcome.toDictionary()
        XCTAssertEqual(dict["decision"] as? String, "approved")
        XCTAssertEqual(dict["scope"] as? String, "duration")
        XCTAssertEqual(dict["durationMs"] as? Int64, 3_600_000)
    }

    func testDeniedOutcomeCarriesNoDuration() {
        let outcome = ApprovalOutcome(decision: PanelDecision.denied(defaultScope: .duration))
        let dict = outcome.toDictionary()
        XCTAssertEqual(dict["decision"] as? String, "denied")
        XCTAssertNil(dict["durationMs"])
    }

    func testNonDurationApprovalCarriesNoDuration() {
        let outcome = ApprovalOutcome(decision: PanelDecision(approved: true, scope: .session, durationMs: 999))
        XCTAssertNil(outcome.toDictionary()["durationMs"])
    }
}
