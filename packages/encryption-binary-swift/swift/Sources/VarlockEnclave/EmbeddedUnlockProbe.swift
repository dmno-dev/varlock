import Foundation
import AppKit
import LocalAuthentication
import LocalAuthenticationEmbeddedUI

/// Proves that a context authenticated through the EMBEDDED Touch ID view can
/// still open the custody key without a second prompt.
///
/// `probe-session-unlock` settled the same question for `evaluatePolicy` and its
/// floating system sheet. The panel now arms an `LAAuthenticationView` instead, so
/// the scan happens inside our own window, and the handoff has to be re-proved for
/// that path: it is the assumption the whole one-gesture design rests on. If a
/// context authenticated this way did not carry over, the unlock would cost a scan
/// in the panel and then a second sheet from the enclave, which is worse than what
/// it replaced.
///
/// The probe cannot assert "no separate sheet appeared" from inside the process, so
/// that half is what the human watching confirms. What it can assert is the part
/// that matters most, using the same trick as the original probe:
/// `interactionNotAllowed` turns any operation that still wants UI into an error
/// rather than a prompt, so a lost handoff shows up as a failed phase.
///
///   phase A (control): unauthenticated context, no interaction allowed
///                      -> must FAIL, proving the key is presence gated
///   phase B (embedded): one scan in the panel's own window -> must SUCCEED
///   phase C (handoff):  two unwraps under that context, no interaction allowed
///                      -> must SUCCEED
///
/// Run it with: `varlock-enclave probe-embedded-unlock [--key-id <id>]`.
/// It needs a real Mac, an enrolled finger, and a desktop session to draw in.
enum EmbeddedUnlockProbe {
    private static let probePlaintext = Data("varlock-embedded-unlock-probe".utf8)

    /// How long the window waits for a finger before giving up.
    private static let scanTimeoutSeconds: TimeInterval = 60

    static func run(keyId: String) -> [String: Any] {
        guard SecureEnclaveManager.keyExists(keyId: keyId) else {
            return [
                "verdict": "inconclusive",
                "reason": "no Secure Enclave key \"\(keyId)\" on this machine; create one with generate-key first",
            ]
        }
        guard UiAvailability.canShowUi() else {
            return [
                "verdict": "inconclusive",
                "reason": "no window server session, so there is nowhere to draw the embedded view; "
                    + "run this from a normal Terminal window logged into the desktop",
            ]
        }

        let wrapped: Data
        do {
            wrapped = try SecureEnclaveManager.encrypt(plaintext: probePlaintext, keyId: keyId)
        } catch {
            return [
                "verdict": "inconclusive",
                "reason": "could not encrypt probe payload: \(error.localizedDescription)",
            ]
        }

        var phases: [[String: Any]] = []

        // Phase A: control. A presence-gated key must refuse an unauthenticated,
        // non-interactive context, or the probe proves nothing.
        let unauthenticated = LAContext()
        unauthenticated.interactionNotAllowed = true
        var controlSucceeded = false
        do {
            _ = try SecureEnclaveManager.decrypt(payload: wrapped, keyId: keyId, context: unauthenticated)
            controlSucceeded = true
        } catch {
            phases.append([
                "phase": "control-unauthenticated",
                "expected": "fail",
                "passed": true,
                "error": error.localizedDescription,
            ])
        }
        unauthenticated.invalidate()

        if controlSucceeded {
            return [
                "verdict": "inconclusive",
                "reason": "key \"\(keyId)\" does not require user presence, so a handoff cannot be observed; "
                    + "re-run against a key created without --no-auth",
            ]
        }

        // Phase B: authenticate through the embedded view.
        let context = LAContext()
        var canEvaluateError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &canEvaluateError) else {
            return [
                "verdict": "inconclusive",
                "reason": "biometrics are not available here, and the embedded view only drives biometrics: "
                    + (canEvaluateError?.localizedDescription ?? "unknown"),
                "hint": "the panel falls back to the system dialog in exactly this case",
            ]
        }

        let scan = presentEmbeddedScan(context: context, keyId: keyId)
        guard scan.authenticated else {
            context.invalidate()
            return [
                "verdict": "inconclusive",
                "reason": scan.error ?? "authentication did not complete",
                "phases": phases,
            ]
        }
        phases.append([
            "phase": "embedded-authenticate",
            "expected": "succeed",
            "passed": true,
            "durationMs": scan.durationMs,
        ])

        // Phase C: the handoff. No further UI allowed, so a second sheet becomes
        // an error we can report instead of something a human has to notice.
        context.interactionNotAllowed = true
        var handoffPassed = true
        for attempt in 1...2 {
            let start = Date()
            do {
                _ = try SecureEnclaveManager.decrypt(payload: wrapped, keyId: keyId, context: context)
                phases.append([
                    "phase": "handoff-unwrap-\(attempt)",
                    "expected": "succeed",
                    "passed": true,
                    "durationMs": Int(Date().timeIntervalSince(start) * 1000),
                ])
            } catch {
                handoffPassed = false
                phases.append([
                    "phase": "handoff-unwrap-\(attempt)",
                    "expected": "succeed",
                    "passed": false,
                    "durationMs": Int(Date().timeIntervalSince(start) * 1000),
                    "error": error.localizedDescription,
                ])
            }
        }
        context.invalidate()

        return [
            "verdict": handoffPassed ? "embedded-single-scan" : "embedded-handoff-lost",
            "scansRequested": 1,
            "policy": "deviceOwnerAuthenticationWithBiometrics",
            "authenticationMs": scan.durationMs,
            "phases": phases,
            "interpretation": handoffPassed
                ? "one scan inside our own window covered every enclave operation that followed"
                : "the context authenticated by the embedded view did not carry to the enclave; "
                    + "the panel would have to fall back to the system dialog",
            "confirmVisually": "no separate system authentication dialog should have appeared; "
                + "the Touch ID prompt should have been inside the probe window",
        ]
    }

    // MARK: - The window

    private struct ScanResult {
        let authenticated: Bool
        let durationMs: Int
        let error: String?
    }

    /// Put an `LAAuthenticationView` on screen, bound to `context`, and evaluate.
    ///
    /// Binding is the whole mechanism: with a view paired to this context in a
    /// visible window, `evaluatePolicy` renders into that view instead of raising
    /// the standard authentication alert.
    private static func presentEmbeddedScan(context: LAContext, keyId: String) -> ScanResult {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 190),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = "Varlock embedded unlock probe"
        window.level = .floating
        window.center()

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false

        let heading = NSTextField(labelWithString: "Unlock varlock encryption key \(keyId)")
        heading.font = NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)
        stack.addArrangedSubview(heading)

        let explainer = NSTextField(wrappingLabelWithString:
            "Touch the sensor below. The prompt should appear inside this window, "
            + "with no separate system dialog. That is what this probe is checking.")
        explainer.alignment = .center
        explainer.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        explainer.textColor = .secondaryLabelColor
        stack.addArrangedSubview(explainer)

        let authView = LAAuthenticationView(context: context)
        authView.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(authView)

        let content = NSView(frame: window.contentRect(forFrameRect: window.frame))
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)

        var result = ScanResult(authenticated: false, durationMs: 0, error: "the probe window closed before anything happened")
        let start = Date()
        var finished = false

        let finish: (ScanResult) -> Void = { outcome in
            guard !finished else { return }
            finished = true
            result = outcome
            window.orderOut(nil)
            NSApp.stop(nil)
            // stop(_:) only takes effect once the loop processes another event.
            NSApp.postEvent(
                NSEvent.otherEvent(
                    with: .applicationDefined, location: .zero, modifierFlags: [],
                    timestamp: 0, windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0
                )!,
                atStart: true
            )
        }

        context.evaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics,
            localizedReason: "unlock varlock encryption key \(keyId)"
        ) { success, error in
            DispatchQueue.main.async {
                finish(ScanResult(
                    authenticated: success,
                    durationMs: Int(Date().timeIntervalSince(start) * 1000),
                    error: success ? nil : "authentication did not complete: "
                        + (error?.localizedDescription ?? "unknown")
                ))
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + scanTimeoutSeconds) {
            finish(ScanResult(
                authenticated: false,
                durationMs: Int(Date().timeIntervalSince(start) * 1000),
                error: "nobody answered the embedded prompt within \(Int(scanTimeoutSeconds))s"
            ))
        }

        app.run()
        return result
    }
}
