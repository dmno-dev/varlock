import XCTest
@testable import IdentitySessions

/// The sidecar that `status` reads to answer "does this key need a person?".
///
/// The routing on the other side of that answer is real: a key reported as not
/// needing auth stops going through the daemon at all. So the defaults matter
/// more than the happy path, and that is most of what is pinned here.
final class KeyAuthRecordTests: XCTestCase {
    func testMissingFileIsGatedAndStandard() {
        let record = KeyAuthRecord(json: nil)
        XCTAssertTrue(record.requireAuth)
        XCTAssertEqual(record.policy, .standard)
    }

    func testFileWrittenBeforeRequireAuthExistedReadsAsGated() {
        // the shape the store wrote when it only recorded the every-time policy
        let record = KeyAuthRecord(json: ["version": 1, "authMode": "every-time"])
        XCTAssertTrue(record.requireAuth, "an absent requireAuth must never drop a prompt")
        XCTAssertEqual(record.policy, .everyTime)
    }

    func testNoAuthKeyIsRecordedAsUngated() {
        let record = KeyAuthRecord(json: ["version": 1, "authMode": "standard", "requireAuth": false])
        XCTAssertFalse(record.requireAuth)
        XCTAssertEqual(record.policy, .standard)
    }

    func testUnrecognizedAuthModeFallsBackToStandard() {
        let record = KeyAuthRecord(json: ["version": 1, "authMode": "sometimes", "requireAuth": true])
        XCTAssertEqual(record.policy, .standard)
        XCTAssertTrue(record.requireAuth)
    }

    func testRoundTripsThroughItsJsonForm() throws {
        for original in [
            KeyAuthRecord(policy: .standard, requireAuth: true),
            KeyAuthRecord(policy: .standard, requireAuth: false),
            KeyAuthRecord(policy: .everyTime, requireAuth: true),
        ] {
            // through real serialization, since that is what the sidecar stores
            let data = try JSONSerialization.data(withJSONObject: original.jsonObject)
            let parsed = try XCTUnwrap(
                JSONSerialization.jsonObject(with: data) as? [String: Any]
            )
            XCTAssertEqual(KeyAuthRecord(json: parsed), original)
            XCTAssertEqual(parsed["version"] as? Int, KeyAuthRecord.fileVersion)
        }
    }
}
