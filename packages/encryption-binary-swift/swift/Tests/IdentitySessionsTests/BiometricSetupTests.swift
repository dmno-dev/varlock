import XCTest
@testable import IdentitySessions

/// When setting Touch ID up has to happen on its own, before the panel exists.
///
/// The bug this encodes: on first use the system's sheet appeared over the
/// approval panel, and one finger satisfied both, so secrets were released
/// against a panel nobody had read. Setup is now its own scan with its own
/// wording, and the approval is a second one taken while the panel is on screen.
final class BiometricSetupTests: XCTestCase {
    func testFirstUseNeedsSetup() {
        XCTAssertTrue(BiometricSetupPolicy.needsSetup(recordedDomainState: nil, currentDomainState: "a"))
        XCTAssertTrue(BiometricSetupPolicy.needsSetup(recordedDomainState: "", currentDomainState: "a"))
    }

    func testAChangedEnrolmentNeedsSetupAgain() {
        // A new finger is the point where macOS starts asking for itself again,
        // which is exactly when the setup step has to be repeated.
        XCTAssertTrue(BiometricSetupPolicy.needsSetup(recordedDomainState: "a", currentDomainState: "b"))
    }

    func testTheSameEnrolmentDoesNot() {
        XCTAssertFalse(BiometricSetupPolicy.needsSetup(recordedDomainState: "a", currentDomainState: "a"))
    }

    func testAnUnreadableEnrolmentIsNotTreatedAsAChange() {
        // Not knowing is not evidence of a change, and a setup scan on every
        // unlock would be worse than the bug this exists to fix.
        XCTAssertFalse(BiometricSetupPolicy.needsSetup(recordedDomainState: "a", currentDomainState: nil))
        XCTAssertFalse(BiometricSetupPolicy.needsSetup(recordedDomainState: "a", currentDomainState: ""))
        // With nothing recorded either, setup still has to happen: a machine
        // with no biometrics has nothing to set up and will fail the check
        // honestly rather than skipping it.
        XCTAssertTrue(BiometricSetupPolicy.needsSetup(recordedDomainState: nil, currentDomainState: nil))
    }

    func testTheSetupPromptSaysWhatItIs() {
        // Not approval wording: nothing is being unlocked yet, and a prompt that
        // says "unlock" while nothing is unlocked teaches people to scan without
        // reading.
        XCTAssertEqual(BiometricSetupPolicy.setupReason, "varlock is setting up Touch ID approvals")
    }
}
