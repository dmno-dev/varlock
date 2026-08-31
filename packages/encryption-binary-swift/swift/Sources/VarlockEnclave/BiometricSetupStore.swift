import Foundation
import CryptoKit
import LocalAuthentication
import IdentitySessions

/// Remembers that Touch ID has been set up for varlock on this machine, and
/// against which enrolment.
///
/// The record is a hash of `evaluatedPolicyDomainState`, which macOS changes
/// whenever the enrolled fingerprints do. That is exactly when the system starts
/// raising its own prompts again, and therefore exactly when the setup step has
/// to be repeated. Storing the hash rather than the state itself keeps a
/// biometric-derived blob off disk for no loss: all we ever do is compare it.
///
/// It lives next to the key store, so it is scoped by `XDG_CONFIG_HOME` the same
/// way keys are, and a scratch config home behaves like a fresh machine.
enum BiometricSetupStore {
    static var statePath: String {
        let keyStore = SecureEnclaveManager.keyStorePath
        let parent = (keyStore as NSString).deletingLastPathComponent
        return parent + "/.biometric-setup.json"
    }

    /// The enrolment we last completed setup against, if any.
    static func recordedDomainState() -> String? {
        guard let data = FileManager.default.contents(atPath: statePath),
              let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return nil
        }
        let state = record["domainState"] as? String
        return (state?.isEmpty ?? true) ? nil : state
    }

    /// Record that setup has just been completed against the current enrolment.
    static func record(domainState: String?) {
        let record: [String: Any] = [
            "version": 1,
            "domainState": domainState ?? "",
            "recordedAt": ISO8601DateFormatter().string(from: Date()),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: record) else { return }
        let directory = (statePath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try? data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }

    /// What the system says the enrolment is right now, hashed.
    ///
    /// `evaluatedPolicyDomainState` is only populated once a policy has been
    /// evaluated for availability, hence the `canEvaluatePolicy` call. Machines
    /// with no biometrics report nothing, which is not a failure: there is no
    /// enrolment to notice changes in.
    static func currentDomainState() -> String? {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error),
              let state = context.evaluatedPolicyDomainState else {
            context.invalidate()
            return nil
        }
        context.invalidate()
        return SHA256.hash(data: state).map { String(format: "%02x", $0) }.joined()
    }

    /// Overrides the decision, for tests and for anyone the detection misjudges.
    ///
    /// Same shape as `_VARLOCK_EMBEDDED_PROMPT`: `0` says the setup step has
    /// happened, `1` forces it. Nothing here weakens the check itself; the setup
    /// scan is a user-experience step, and the approval scan is the one that
    /// actually opens anything.
    static let overrideEnvVar = "_VARLOCK_BIOMETRIC_SETUP"

    /// Whether this unlock has to do the setup scan before anything is drawn.
    static func needsSetup() -> Bool {
        switch ProcessInfo.processInfo.environment[overrideEnvVar]?.lowercased() {
        case "0", "false": return false
        case "1", "true": return true
        default: break
        }
        return BiometricSetupPolicy.needsSetup(
            recordedDomainState: recordedDomainState(),
            currentDomainState: currentDomainState()
        )
    }

    /// Remember the enrolment the setup scan was completed against.
    static func markSetupComplete() {
        record(domainState: currentDomainState())
    }
}
