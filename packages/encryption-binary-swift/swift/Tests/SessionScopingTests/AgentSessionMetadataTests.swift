import XCTest
@testable import SessionScoping

/// Reading an agent's own record of the session a request came from.
///
/// The panel says "Claude Code, 'vault panel redesign', started 2:14 PM" only
/// when it can say it truthfully. These cover the ways that record can be wrong
/// (a recycled pid, a session that has ended, a name that is really an id) and
/// assert that each of them costs the row its title rather than putting somebody
/// else's session on the panel.
final class AgentSessionMetadataTests: XCTestCase {
    private var home: URL!

    override func setUpWithError() throws {
        home = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("varlock-agent-metadata-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: home.appendingPathComponent(".claude/sessions"),
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: home)
    }

    private func writeSession(pid: pid_t, _ record: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: record)
        try data.write(to: home.appendingPathComponent(".claude/sessions/\(pid).json"))
    }

    private var reader: LiveAgentSessionMetadataReader {
        return LiveAgentSessionMetadataReader(homeDirectory: home.path)
    }

    func testTheSessionsOwnNameAndStartAreRead() throws {
        try writeSession(pid: 4242, [
            "pid": 4242,
            "sessionId": "9cfa3fb6-c97f-4c5d-8f63-cc0bc6c46557",
            "startedAt": 1_700_000_000_000,
            "name": "vault panel redesign",
        ])

        let metadata = reader.metadata(for: .claudeCode, pid: 4242, processStartTime: 1_700_000_000)
        XCTAssertEqual(metadata?.title, "vault panel redesign")
        XCTAssertEqual(metadata?.startTime, 1_700_000_000)
    }

    func testARecordLeftBehindByAnotherProcessIsRefused() throws {
        // Same pid, but the process running under it now started hours later:
        // the record belongs to whatever held this pid before.
        try writeSession(pid: 4242, [
            "pid": 4242,
            "startedAt": 1_700_000_000_000,
            "name": "somebody elses session",
        ])

        XCTAssertNil(reader.metadata(for: .claudeCode, pid: 4242, processStartTime: 1_700_050_000))
    }

    func testAMismatchedPidInTheRecordIsRefused() throws {
        try writeSession(pid: 4242, ["pid": 9999, "name": "not ours"])
        XCTAssertNil(reader.metadata(for: .claudeCode, pid: 4242, processStartTime: 0))
    }

    func testAnIdIsNeverShownAsATitle() throws {
        try writeSession(pid: 4242, [
            "pid": 4242,
            "name": "9cfa3fb6-c97f-4c5d-8f63-cc0bc6c46557",
        ])
        // The agent falls back to the session id when it has no better name. A
        // uuid is not something a person can check anything against, so the row
        // goes without a title instead.
        XCTAssertNil(reader.metadata(for: .claudeCode, pid: 4242, processStartTime: 0)?.title)
    }

    func testATitleIsFlattenedAndCapped() throws {
        try writeSession(pid: 4242, [
            "pid": 4242,
            "name": "  first\nsecond \(String(repeating: "x", count: 200))  ",
        ])
        let title = try XCTUnwrap(reader.metadata(for: .claudeCode, pid: 4242, processStartTime: 0)?.title)
        XCTAssertFalse(title.contains("\n"))
        XCTAssertTrue(title.hasPrefix("first second"))
        XCTAssertLessThanOrEqual(title.count, 64)
    }

    func testNoRecordAtAllIsNotAFailure() {
        XCTAssertNil(reader.metadata(for: .claudeCode, pid: 1234, processStartTime: 0))
    }

    func testCodexHasNoRecordToReadYet() throws {
        // Codex keys its rollouts by time and directory rather than by pid, so
        // there is nothing to look up without guessing. Detection and the start
        // time still work; only the title is missing.
        XCTAssertNil(reader.metadata(for: .codex, pid: 4242, processStartTime: 0))
    }
}
