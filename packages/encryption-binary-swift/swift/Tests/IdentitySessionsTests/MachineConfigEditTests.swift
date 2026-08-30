import XCTest
@testable import IdentitySessions

/// Editing `sessions.lockOn` from the menu, without eating the rest of the file.
///
/// The config file is shared with telemetry and with whatever varlock adds next,
/// and people edit it by hand. A menu click that dropped a field would be a data
/// loss bug that nobody notices until the setting it lost mattered.
final class MachineConfigEditTests: XCTestCase {

    private func object(_ data: Data) throws -> [String: Any] {
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testWritesTheFieldIntoAnEmptyConfig() throws {
        let written = try MachineConfigEdit.settingLockOn(.screenLock, in: nil)
        let sessions = try XCTUnwrap(object(written)["sessions"] as? [String: Any])
        XCTAssertEqual(sessions["lockOn"] as? String, "screenLock")
    }

    func testKeepsEveryOtherKeyInTheFile() throws {
        let existing = Data(#"""
        {
          "anonymousId": "1a2b3c",
          "telemetryDisabled": true,
          "nested": { "deep": [1, 2, 3] },
          "sessions": { "lockOn": "sleep", "somethingElse": 7 }
        }
        """#.utf8)

        let root = try object(try MachineConfigEdit.settingLockOn(.never, in: existing))
        XCTAssertEqual(root["anonymousId"] as? String, "1a2b3c")
        XCTAssertEqual(root["telemetryDisabled"] as? Bool, true)
        XCTAssertEqual((root["nested"] as? [String: Any])?["deep"] as? [Int], [1, 2, 3])

        let sessions = try XCTUnwrap(root["sessions"] as? [String: Any])
        XCTAssertEqual(sessions["lockOn"] as? String, "none")
        XCTAssertEqual(sessions["somethingElse"] as? Int, 7)
    }

    func testAddsTheSessionsSectionWithoutTouchingTheRest() throws {
        let existing = Data(#"{"anonymousId":"1a2b3c"}"#.utf8)
        let root = try object(try MachineConfigEdit.settingLockOn(.sleep, in: existing))
        XCTAssertEqual(root["anonymousId"] as? String, "1a2b3c")
        XCTAssertEqual((root["sessions"] as? [String: Any])?["lockOn"] as? String, "sleep")
    }

    func testEmptyFileIsTreatedAsNoConfig() throws {
        let root = try object(try MachineConfigEdit.settingLockOn(.sleep, in: Data()))
        XCTAssertEqual(root.count, 1)
    }

    /// Better to tell the user their file is broken than to replace it with a
    /// one-key object and lose whatever they had written.
    func testRefusesToOverwriteAFileItCannotParse() {
        XCTAssertThrowsError(try MachineConfigEdit.settingLockOn(.sleep, in: Data("{ not json".utf8))) { error in
            XCTAssertEqual(error as? MachineConfigEdit.EditError, .unparseable)
        }
    }

    func testRefusesAFileThatIsNotAnObject() {
        XCTAssertThrowsError(try MachineConfigEdit.settingLockOn(.sleep, in: Data("[1,2,3]".utf8))) { error in
            XCTAssertEqual(error as? MachineConfigEdit.EditError, .notAnObject)
        }
    }

    func testOutputIsReadableAndEndsWithANewline() throws {
        let written = try MachineConfigEdit.settingLockOn(.sleep, in: Data(#"{"anonymousId":"x"}"#.utf8))
        let text = try XCTUnwrap(String(data: written, encoding: .utf8))
        XCTAssertTrue(text.hasSuffix("}\n"))
        XCTAssertTrue(text.contains("\n  "), "expected pretty-printed output")
    }

    /// What is written has to be what the resolver reads back, or the menu's
    /// checkmark would disagree with the daemon's behavior.
    func testWhatIsWrittenIsWhatTheResolverReads() throws {
        for policy in SessionLockPolicy.allCases {
            let written = try MachineConfigEdit.settingLockOn(policy, in: nil)
            XCTAssertEqual(
                LockPolicyResolution.machineLockPolicy(fromConfigData: written, warn: { _ in }),
                policy
            )
        }
    }
}

extension MachineConfigEdit.EditError: Equatable {
    public static func == (lhs: MachineConfigEdit.EditError, rhs: MachineConfigEdit.EditError) -> Bool {
        switch (lhs, rhs) {
        case (.unparseable, .unparseable), (.notAnObject, .notAnObject): return true
        default: return false
        }
    }
}
