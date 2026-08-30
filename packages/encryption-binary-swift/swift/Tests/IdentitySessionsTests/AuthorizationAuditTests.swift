import XCTest
@testable import IdentitySessions

/// The authorization log's two promises: a record that is reported as written is
/// really on disk, and a record that cannot be written is an error rather than a
/// shrug. The second one is what lets the decrypt path treat a failed append as a
/// reason to refuse.
final class AuthorizationAuditTests: XCTestCase {

    private var root: String = ""
    private var auditDir: String { return root + "/audit" }

    override func setUpWithError() throws {
        root = NSTemporaryDirectory() + "varlock-audit-tests-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        // Put permissions back before deleting, or a test that made something
        // read-only would leave the directory behind.
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: auditDir)
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: auditDir + "/" + AuthorizationAuditLog.fileName
        )
        try? FileManager.default.removeItem(atPath: root)
    }

    private func makeLog(timestamp: String = "2026-01-01T00:00:00.000Z") -> AuthorizationAuditLog {
        return AuthorizationAuditLog(directoryPath: auditDir, timestamp: { timestamp })
    }

    private func decryptRecord(payloads: Int = 3) -> AuthorizationRecord {
        return AuthorizationRecord(
            kind: .decrypt,
            sessionId: "tty:ttys004:1700000000",
            keyIds: ["varlock-default"],
            identityId: "default",
            payloadCount: payloads,
            scope: "session",
            requester: "node ← claude ← zsh (ttys004)"
        )
    }

    private func lines() throws -> [String] {
        let contents = try String(contentsOfFile: auditDir + "/" + AuthorizationAuditLog.fileName, encoding: .utf8)
        return contents.split(separator: "\n").map(String.init)
    }

    // MARK: - Writing

    func testAppendWritesOneJsonLinePerRecord() throws {
        let log = makeLog()
        try log.append(decryptRecord())
        try log.append(decryptRecord(payloads: 1))

        let written = try lines()
        XCTAssertEqual(written.count, 2)

        let first = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(written[0].utf8)) as? [String: Any]
        )
        XCTAssertEqual(first["event"] as? String, "decrypt-v2")
        XCTAssertEqual(first["sessionId"] as? String, "tty:ttys004:1700000000")
        XCTAssertEqual(first["keyIds"] as? [String], ["varlock-default"])
        XCTAssertEqual(first["payloadCount"] as? Int, 3)
        XCTAssertEqual(first["scope"] as? String, "session")
        XCTAssertEqual(first["requester"] as? String, "node ← claude ← zsh (ttys004)")
        XCTAssertEqual(first["ts"] as? String, "2026-01-01T00:00:00.000Z")
    }

    func testTheFileOnlyGrows() throws {
        let log = makeLog()
        try log.append(decryptRecord())
        let afterFirst = try lines()

        try log.append(AuthorizationRecord(kind: .unlock, sessionId: "tty:a", keyIds: ["k1"]))
        let afterSecond = try lines()

        XCTAssertEqual(afterSecond.count, 2)
        XCTAssertEqual(afterSecond[0], afterFirst[0])
    }

    func testDirectoryAndFileAreOwnerOnly() throws {
        let log = makeLog()
        try log.append(decryptRecord())

        let dirMode = try FileManager.default.attributesOfItem(atPath: auditDir)[.posixPermissions] as? Int
        let fileMode = try FileManager.default.attributesOfItem(atPath: log.filePath)[.posixPermissions] as? Int
        XCTAssertEqual(dirMode, 0o700)
        XCTAssertEqual(fileMode, 0o600)
    }

    /// The log is meant to be readable by a person and by tooling, so it must not
    /// accumulate anything that would be dangerous to read.
    func testRecordsCarryNoSecretMaterial() throws {
        let log = makeLog()
        try log.append(decryptRecord())

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(try lines()[0].utf8)) as? [String: Any]
        )
        let allowedKeys: Set<String> = [
            "ts", "event", "sessionId", "keyIds", "identityId", "payloadCount", "scope", "requester",
        ]
        XCTAssertTrue(Set(object.keys).isSubset(of: allowedKeys), "unexpected fields: \(object.keys)")
    }

    // MARK: - Failing to write

    func testAppendThrowsWhenTheFileCannotBeOpened() throws {
        let log = makeLog()
        try log.append(decryptRecord())

        // Anything that makes the append fail has to surface: no silent skip, and
        // no success reported for a line that never landed.
        try FileManager.default.setAttributes([.posixPermissions: 0o400], ofItemAtPath: log.filePath)

        XCTAssertThrowsError(try log.append(decryptRecord())) { error in
            XCTAssertEqual((error as? AuthorizationAuditError)?.code, "AUDIT_WRITE_FAILED")
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: log.filePath)
        XCTAssertEqual(try lines().count, 1)
    }

    func testAppendThrowsWhenTheDirectoryCannotBeCreated() {
        // A plain file where the audit directory should be: nothing can be written
        // under it, and the writer must say so rather than carry on.
        FileManager.default.createFile(atPath: auditDir, contents: Data("not a directory".utf8))
        let log = makeLog()

        XCTAssertThrowsError(try log.append(decryptRecord())) { error in
            XCTAssertEqual((error as? AuthorizationAuditError)?.code, "AUDIT_WRITE_FAILED")
        }
    }

    func testAppendThrowsWhenTheDirectoryIsUnwritable() throws {
        try FileManager.default.createDirectory(atPath: auditDir, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: auditDir)
        let log = makeLog()

        XCTAssertThrowsError(try log.append(decryptRecord())) { error in
            XCTAssertEqual((error as? AuthorizationAuditError)?.code, "AUDIT_WRITE_FAILED")
        }
    }

    func testErrorSaysWhySoTheDenialIsExplainable() {
        let error = AuthorizationAuditError.notPersisted("disk is full")
        XCTAssertTrue(error.localizedDescription.contains("disk is full"))
        XCTAssertTrue(error.localizedDescription.contains("Refusing to release secrets"))
    }

    // MARK: - Record shape

    func testInvalidationRecordsUseWildcardsForWholeSweeps() throws {
        let log = makeLog()
        try log.append(AuthorizationRecord(kind: .invalidate, sessionId: "*", keyIds: ["*"]))

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(try lines()[0].utf8)) as? [String: Any]
        )
        XCTAssertEqual(object["event"] as? String, "invalidate-session")
        XCTAssertEqual(object["sessionId"] as? String, "*")
        XCTAssertNil(object["scope"])
        XCTAssertNil(object["requester"])
    }

    func testTimestampsAreUtcIso8601WithMilliseconds() {
        let stamp = AuthorizationAuditLog.iso8601(Date(timeIntervalSince1970: 1_700_000_000.25))
        XCTAssertEqual(stamp, "2023-11-14T22:13:20.250Z")
    }
}
