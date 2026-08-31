import Foundation

/// Setting Touch ID up is not the same act as approving an unlock, and the two
/// must not be satisfied by one finger.
///
/// The first time varlock uses the sensor on a machine (and again after the
/// enrolled fingerprints change) macOS raises its own prompt as soon as the
/// policy is evaluated, and that prompt lands on top of whatever is behind it.
/// When the approval panel was that thing behind it, one scan dismissed both:
/// the setup prompt and the approval, before anybody had read what was being
/// unlocked. An approval nobody could read is not an approval.
///
/// So the setup check runs on its own, with the panel not yet drawn and with
/// wording that says what it is, and the approval is a second, separate scan
/// taken while the panel is on screen. First run costs two scans on purpose.
///
/// The decision itself is here, with no LocalAuthentication in sight, so the
/// rules can be tested without a sensor.
public enum BiometricSetupPolicy {
    /// What the system prompt says during setup.
    ///
    /// Deliberately not approval wording: nothing is being unlocked yet, and a
    /// prompt that says "unlock" while nothing is being unlocked teaches people
    /// to scan without reading. Password managers use the same "setting up"
    /// phrasing for this moment, which is a pattern users already recognise.
    public static let setupReason = "set up Touch ID approvals"

    /// Whether this unlock has to do the setup step first.
    ///
    /// - Parameters:
    ///   - recordedDomainState: the biometric enrolment we last completed setup
    ///     against, or nil when we have never completed one here.
    ///   - currentDomainState: what the system reports now, or nil when it could
    ///     not be read.
    ///
    /// Two cases need it: never having done it, and the enrolment having changed
    /// since (a new finger, a reset), which is the point at which macOS asks
    /// again on its own. Everything else does not, including the case where the
    /// current state cannot be read: an unreadable answer is not evidence of a
    /// change, and inventing a setup scan on every unlock would be worse than the
    /// bug this exists to fix.
    public static func needsSetup(
        recordedDomainState: String?,
        currentDomainState: String?
    ) -> Bool {
        guard let recordedDomainState, !recordedDomainState.isEmpty else { return true }
        guard let currentDomainState, !currentDomainState.isEmpty else { return false }
        return recordedDomainState != currentDomainState
    }
}
