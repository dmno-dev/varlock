import Foundation
import CryptoKit
import LocalAuthentication
import IdentitySessions

/// Proves, on real hardware, that one biometric scan covers a whole unlock.
///
/// The two-key model only pays for itself if the daemon can drive the biometric
/// itself (`LAContext.evaluatePolicy`) and then hand that authenticated context to
/// the enclave operation without macOS raising a second sheet. That is a claim
/// about this machine and this OS version, not something a unit test can settle,
/// so it gets a probe.
///
/// The probe does not ask a human to count sheets. `LAContext.interactionNotAllowed`
/// makes any operation that still wants UI fail instead of showing it, so a second
/// prompt turns into an error we can report. Exactly one scan is requested, in phase B.
///
///   phase A (control): unauthenticated context, no interaction allowed
///                      -> must FAIL, which is what proves the key is presence gated
///   phase B (handoff):  authenticate once, then unwrap twice under that context
///                      with no interaction allowed -> must SUCCEED
///   phase C (session):  ephemeral no-presence session key -> must SUCCEED silently
///
/// Run it with: `varlock-enclave probe-session-unlock [--key-id <id>]`
/// See the "Checking the single-scan unlock" section of the package README.
enum SessionUnlockProbe {

    struct PhaseResult {
        let name: String
        let expectation: String
        let succeeded: Bool
        let passed: Bool
        let durationMs: Int
        let error: String?

        var dictionary: [String: Any] {
            var dict: [String: Any] = [
                "phase": name,
                "expected": expectation,
                "operationSucceeded": succeeded,
                "passed": passed,
                "durationMs": durationMs,
            ]
            if let error { dict["error"] = error }
            return dict
        }
    }

    /// Sample plaintext standing in for the identity private key, so the probe needs
    /// no identity file and touches no real key material.
    private static let probePlaintext = Data("varlock-session-unlock-probe".utf8)

    static func run(keyId: String) -> [String: Any] {
        guard SecureEnclaveManager.keyExists(keyId: keyId) else {
            return [
                "verdict": "inconclusive",
                "reason": "no Secure Enclave key \"\(keyId)\" on this machine; create one with generate-key first",
            ]
        }

        let wrapped: Data
        do {
            wrapped = try SecureEnclaveManager.encrypt(plaintext: probePlaintext, keyId: keyId)
        } catch {
            return ["verdict": "inconclusive", "reason": "could not encrypt probe payload: \(error.localizedDescription)"]
        }

        var phases: [PhaseResult] = []

        // Phase A: control. A presence-gated key must refuse an unauthenticated,
        // non-interactive context. If this SUCCEEDS the key has no presence
        // requirement (e.g. it was made with --no-auth) and the probe proves nothing.
        let unauthenticated = LAContext()
        unauthenticated.interactionNotAllowed = true
        let phaseA = measure(name: "control-unauthenticated", expectation: "fail") {
            _ = try SecureEnclaveManager.decrypt(payload: wrapped, keyId: keyId, context: unauthenticated)
        }
        phases.append(PhaseResult(
            name: phaseA.name, expectation: phaseA.expectation,
            succeeded: phaseA.succeeded, passed: !phaseA.succeeded,
            durationMs: phaseA.durationMs, error: phaseA.error
        ))
        unauthenticated.invalidate()

        if phaseA.succeeded {
            return [
                "verdict": "inconclusive",
                "reason": "key \"\(keyId)\" does not require user presence, so a handoff cannot be observed; "
                    + "re-run against a key created without --no-auth",
                "phases": phases.map(\.dictionary),
            ]
        }

        // Phase B: the handoff itself. One scan, then two enclave operations under
        // the same authenticated context with UI refused.
        let context = LAContext()
        var policyName = "deviceOwnerAuthenticationWithBiometrics"
        var policy: LAPolicy = .deviceOwnerAuthenticationWithBiometrics
        var canEvaluateError: NSError?
        if !context.canEvaluatePolicy(policy, error: &canEvaluateError) {
            policy = .deviceOwnerAuthentication
            policyName = "deviceOwnerAuthentication"
            var fallbackError: NSError?
            guard context.canEvaluatePolicy(policy, error: &fallbackError) else {
                return [
                    "verdict": "inconclusive",
                    "reason": "no usable authentication policy: "
                        + (fallbackError?.localizedDescription ?? "unknown"),
                    "phases": phases.map(\.dictionary),
                ]
            }
        }

        let authStart = Date()
        let semaphore = DispatchSemaphore(value: 0)
        var evalError: Error?
        context.evaluatePolicy(
            policy,
            localizedReason: IdentitySessionManager.unlockReason(
                identityId: IdentityStore.defaultIdentityId,
                keyIds: [keyId]
            )
        ) { success, error in
            if !success { evalError = error }
            semaphore.signal()
        }
        if semaphore.wait(timeout: .now() + IdentitySessionManager.biometricTimeoutSeconds) == .timedOut {
            context.invalidate()
            return [
                "verdict": "inconclusive",
                "reason": "the biometric prompt timed out; nobody answered it",
                "phases": phases.map(\.dictionary),
            ]
        }
        if let evalError {
            context.invalidate()
            let nsError = evalError as NSError
            return [
                "verdict": "inconclusive",
                "reason": "authentication did not complete: \(evalError.localizedDescription)",
                "authErrorCode": nsError.code,
                "authErrorDomain": nsError.domain,
                "hint": laErrorHint(code: nsError.code),
                "phases": phases.map(\.dictionary),
            ]
        }
        let authMs = Int(Date().timeIntervalSince(authStart) * 1000)

        // No further UI from here: a second sheet becomes an error instead.
        context.interactionNotAllowed = true

        for attempt in 1...2 {
            let result = measure(name: "handoff-unwrap-\(attempt)", expectation: "succeed") {
                _ = try SecureEnclaveManager.decrypt(payload: wrapped, keyId: keyId, context: context)
            }
            phases.append(PhaseResult(
                name: result.name, expectation: result.expectation,
                succeeded: result.succeeded, passed: result.succeeded,
                durationMs: result.durationMs, error: result.error
            ))
        }
        context.invalidate()

        // Phase C: the session key. No presence flag, no context, no prompt.
        let phaseC = measure(name: "session-key-silent-unwrap", expectation: "succeed") {
            let sessionKey = try SecureEnclaveManager.createEphemeralSessionKey()
            let sessionWrapped = try Ecies.encrypt(
                plaintext: probePlaintext,
                to: sessionKey.publicKey,
                version: Ecies.devicePayloadVersion
            )
            let reloaded = try SecureEnclave.P256.KeyAgreement.PrivateKey(
                dataRepresentation: sessionKey.dataRepresentation
            )
            let opened = try Ecies.decrypt(
                payload: sessionWrapped,
                using: reloaded,
                acceptedVersions: [Ecies.devicePayloadVersion]
            )
            guard opened == probePlaintext else {
                throw EnclaveError.decryptionFailed("session key round trip returned different bytes")
            }
        }
        phases.append(PhaseResult(
            name: phaseC.name, expectation: phaseC.expectation,
            succeeded: phaseC.succeeded, passed: phaseC.succeeded,
            durationMs: phaseC.durationMs, error: phaseC.error
        ))

        let allPassed = phases.allSatisfy(\.passed)
        let handoffPassed = phases.filter { $0.name.hasPrefix("handoff-") }.allSatisfy(\.passed)

        return [
            "verdict": allPassed ? "single-scan" : (handoffPassed ? "partial" : "double-prompt"),
            "scansRequested": 1,
            "policy": policyName,
            "authenticationMs": authMs,
            "phases": phases.map(\.dictionary),
            "interpretation": allPassed
                ? "one scan covered the authentication and every enclave operation that followed"
                : "an enclave operation still wanted its own prompt; see the failing phase",
        ]
    }

    // MARK: - Helpers

    /// Tell "the machine said no" apart from "nothing could show the prompt here".
    /// A probe run over ssh, or from a process with no window server session, gets
    /// cancelled without any human involved, and that is not evidence about the
    /// handoff either way.
    private static func laErrorHint(code: Int) -> String {
        switch code {
        case LAError.userCancel.rawValue:
            return "the person dismissed the prompt; run it again and authenticate"
        case LAError.systemCancel.rawValue, LAError.appCancel.rawValue:
            return "the system withdrew the prompt, which usually means this process has no "
                + "window server session (ssh, a headless agent shell). Re-run from a normal "
                + "Terminal window logged into the desktop."
        case LAError.notInteractive.rawValue:
            return "this context refuses interaction entirely"
        case LAError.biometryNotEnrolled.rawValue:
            return "no biometrics enrolled on this Mac"
        case LAError.biometryLockout.rawValue:
            return "biometrics are locked out; unlock with the device password first"
        default:
            return "see LAError code \(code)"
        }
    }

    private struct Measured {
        let name: String
        let expectation: String
        let succeeded: Bool
        let durationMs: Int
        let error: String?
    }

    private static func measure(name: String, expectation: String, _ body: () throws -> Void) -> Measured {
        let start = Date()
        do {
            try body()
            return Measured(
                name: name, expectation: expectation, succeeded: true,
                durationMs: Int(Date().timeIntervalSince(start) * 1000), error: nil
            )
        } catch {
            return Measured(
                name: name, expectation: expectation, succeeded: false,
                durationMs: Int(Date().timeIntervalSince(start) * 1000),
                error: error.localizedDescription
            )
        }
    }
}
