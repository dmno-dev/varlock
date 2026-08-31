import Foundation
import AppKit
import LocalAuthentication
import LocalAuthenticationEmbeddedUI

/// Proves, on real hardware, that the panel's inline Touch ID prompt actually
/// arms, and that a context authenticated through it can still open the custody
/// key without a second prompt.
///
/// `probe-session-unlock` settled the handoff question for `evaluatePolicy` and its
/// floating system dialog. The embedded prompt is a different mechanism:
/// `LAAuthenticationView` is bound to a context, and evaluating that context is
/// supposed to render into the view instead of raising the standard dialog. Two
/// separate things can go wrong there, so the probe reports on both:
///
///   1. does the inline prompt arm at all (is there a glyph, does the sensor
///      respond), and
///   2. once scanned, does that context still open the enclave key silently.
///
/// The first one has already failed in the field once, with the view drawing
/// nothing and the sensor doing nothing, so this probe logs every step of the
/// lifecycle with timestamps. `--verbose` streams that log to stderr as it
/// happens, and it is always included in the JSON, so a run that stalls says
/// where it stalled rather than just timing out.
///
///   phase A (control): unauthenticated context, no interaction allowed
///                      -> must FAIL, proving the key is presence gated
///   phase B (embedded): one scan in the probe's own window -> must SUCCEED
///   phase C (handoff):  two unwraps under that context, no interaction allowed
///                      -> must SUCCEED
///
/// Run it with:
///   `varlock-enclave probe-embedded-unlock [--key-id <id>] [--verbose] [--timeout <s>]`
enum EmbeddedUnlockProbe {
    private static let probePlaintext = Data("varlock-embedded-unlock-probe".utf8)

    // MARK: - Lifecycle log

    /// Timestamped record of what the probe did and what the system said back.
    /// This is the actual deliverable when the prompt does not arm.
    final class Log {
        private let start = Date()
        private let verbose: Bool
        private(set) var entries: [[String: Any]] = []

        init(verbose: Bool) {
            self.verbose = verbose
        }

        func note(_ event: String, _ detail: [String: Any] = [:]) {
            let atMs = Int(Date().timeIntervalSince(start) * 1000)
            var entry: [String: Any] = ["atMs": atMs, "event": event]
            for (key, value) in detail { entry[key] = value }
            entries.append(entry)
            guard verbose else { return }
            let rendered = detail.isEmpty
                ? ""
                : " " + detail.keys.sorted().map { "\($0)=\(detail[$0] ?? "")" }.joined(separator: " ")
            FileHandle.standardError.write(Data("[\(atMs)ms] \(event)\(rendered)\n".utf8))
        }
    }

    static func run(keyId: String, verbose: Bool, timeoutSeconds: TimeInterval) -> [String: Any] {
        let log = Log(verbose: verbose)
        log.note("probe-start", [
            "keyId": keyId,
            "timeoutSeconds": Int(timeoutSeconds),
            // A bare SwiftPM executable has no bundle and no identifier. Some
            // AppKit and LocalAuthentication behaviour depends on being a real
            // bundled app, so this is worth knowing before blaming the code.
            "bundleIdentifier": Bundle.main.bundleIdentifier ?? "<none>",
            "bundlePath": Bundle.main.bundlePath,
            "executable": Bundle.main.executablePath ?? "<unknown>",
        ])

        guard SecureEnclaveManager.keyExists(keyId: keyId) else {
            return finish(log: log, [
                "verdict": "inconclusive",
                "reason": "no Secure Enclave key \"\(keyId)\" on this machine; create one with generate-key first",
            ])
        }
        guard UiAvailability.canShowUi() else {
            return finish(log: log, [
                "verdict": "inconclusive",
                "reason": "no window server session, so there is nowhere to draw the embedded view; "
                    + "run this from a normal Terminal window logged into the desktop",
            ])
        }

        let wrapped: Data
        do {
            wrapped = try SecureEnclaveManager.encrypt(plaintext: probePlaintext, keyId: keyId)
        } catch {
            return finish(log: log, [
                "verdict": "inconclusive",
                "reason": "could not encrypt probe payload: \(error.localizedDescription)",
            ])
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
            log.note("control-refused-as-expected", ["error": error.localizedDescription])
            phases.append([
                "phase": "control-unauthenticated",
                "expected": "fail",
                "passed": true,
                "error": error.localizedDescription,
            ])
        }
        unauthenticated.invalidate()

        if controlSucceeded {
            log.note("control-succeeded-unexpectedly")
            return finish(log: log, [
                "verdict": "inconclusive",
                "reason": "key \"\(keyId)\" does not require user presence, so a handoff cannot be observed; "
                    + "re-run against a key created without --no-auth",
            ])
        }

        // Phase B: authenticate through the embedded view.
        let context = LAContext()
        log.note("context-created", [
            "instance": String(UInt(bitPattern: ObjectIdentifier(context).hashValue), radix: 16),
            // A leaked `interactionNotAllowed` would suppress the UI while the
            // surrounding labels still drew, which looks exactly like the field
            // report, so it is asserted rather than assumed.
            "interactionNotAllowed": context.interactionNotAllowed,
        ])

        var biometricError: NSError?
        let canBiometrics = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &biometricError)
        log.note("canEvaluatePolicy", [
            "policy": "deviceOwnerAuthenticationWithBiometrics",
            "result": canBiometrics,
            "error": biometricError?.localizedDescription ?? "<none>",
            "errorCode": biometricError?.code ?? 0,
            // Populated by canEvaluatePolicy. 0 = none, 1 = Touch ID, 2 = Face ID.
            "biometryType": context.biometryType.rawValue,
        ])
        guard canBiometrics else {
            return finish(log: log, [
                "verdict": "inconclusive",
                "reason": "biometrics are not available here, and the embedded view only drives biometrics: "
                    + (biometricError?.localizedDescription ?? "unknown"),
                "hint": "the panel falls back to the system dialog in exactly this case",
                "phases": phases,
            ])
        }

        let scan = presentEmbeddedScan(
            context: context,
            keyId: keyId,
            log: log,
            timeoutSeconds: timeoutSeconds
        )
        guard scan.authenticated else {
            context.invalidate()
            return finish(log: log, [
                "verdict": scan.armed ? "inconclusive" : "embedded-never-armed",
                "reason": scan.error ?? "authentication did not complete",
                "phases": phases,
                "interpretation": scan.armed
                    ? "the prompt was armed but nobody completed it"
                    : "the inline prompt never became usable; see the lifecycle log for where it stopped",
            ])
        }
        phases.append([
            "phase": "embedded-authenticate",
            "expected": "succeed",
            "passed": true,
            "durationMs": scan.durationMs,
        ])

        // Phase C: the handoff. No further UI allowed, so a second prompt becomes
        // an error we can report instead of something a human has to notice.
        context.interactionNotAllowed = true
        var handoffPassed = true
        for attempt in 1...2 {
            let start = Date()
            do {
                _ = try SecureEnclaveManager.decrypt(payload: wrapped, keyId: keyId, context: context)
                log.note("handoff-unwrap-ok", ["attempt": attempt])
                phases.append([
                    "phase": "handoff-unwrap-\(attempt)",
                    "expected": "succeed",
                    "passed": true,
                    "durationMs": Int(Date().timeIntervalSince(start) * 1000),
                ])
            } catch {
                handoffPassed = false
                log.note("handoff-unwrap-failed", ["attempt": attempt, "error": error.localizedDescription])
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

        return finish(log: log, [
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
        ])
    }

    private static func finish(log: Log, _ result: [String: Any]) -> [String: Any] {
        var output = result
        output["lifecycle"] = log.entries
        return output
    }

    // MARK: - The window

    private struct ScanResult {
        let authenticated: Bool
        /// Whether the inline prompt ever looked usable: a view with real area,
        /// in a visible key window, with the evaluation running.
        let armed: Bool
        let durationMs: Int
        let error: String?
    }

    /// Put an `LAAuthenticationView` on screen, bound to `context`, and evaluate.
    ///
    /// Binding is the whole mechanism: with a view paired to this context in a
    /// visible window, `evaluatePolicy` renders into that view instead of raising
    /// the standard authentication alert. The ordering matters, so it is explicit
    /// here: build the view, install it, put the window on screen and make it key,
    /// activate the app, and only then evaluate, from inside the running run loop.
    private static func presentEmbeddedScan(
        context: LAContext,
        keyId: String,
        log: Log,
        timeoutSeconds: TimeInterval
    ) -> ScanResult {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        log.note("activation-policy-set", ["policy": "regular"])

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 230),
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
            "Touch the sensor. The prompt should appear inside this window, with no "
            + "separate system dialog. If you see no fingerprint icon below, the inline "
            + "prompt did not arm: quit with Cmd+Q and send the lifecycle log.")
        explainer.alignment = .center
        explainer.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        explainer.textColor = .secondaryLabelColor
        stack.addArrangedSubview(explainer)

        let authView = LAAuthenticationView(context: context, controlSize: .large)
        log.note("auth-view-created", [
            "boundToContext": String(UInt(bitPattern: ObjectIdentifier(authView.context).hashValue), radix: 16),
            "sameInstanceAsEvaluated": authView.context === context,
            "intrinsicWidth": authView.intrinsicContentSize.width,
            "intrinsicHeight": authView.intrinsicContentSize.height,
            "fittingWidth": authView.fittingSize.width,
            "fittingHeight": authView.fittingSize.height,
        ])

        // A view with no area draws no glyph and catches no touch, which is exactly
        // what the field report described. Never let auto layout collapse it: take
        // the intrinsic size when there is one and fall back to a sane square.
        authView.translatesAutoresizingMaskIntoConstraints = false
        let intrinsic = authView.intrinsicContentSize
        let width = intrinsic.width > 0 ? intrinsic.width : 64
        let height = intrinsic.height > 0 ? intrinsic.height : 64
        NSLayoutConstraint.activate([
            authView.widthAnchor.constraint(greaterThanOrEqualToConstant: width),
            authView.heightAnchor.constraint(greaterThanOrEqualToConstant: height),
        ])
        stack.addArrangedSubview(authView)

        let content = NSView(frame: window.contentRect(forFrameRect: window.frame))
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])
        window.contentView = content
        content.layoutSubtreeIfNeeded()
        log.note("auth-view-installed", [
            "frameWidth": authView.frame.width,
            "frameHeight": authView.frame.height,
            "isHidden": authView.isHidden,
            "hasWindow": authView.window != nil,
        ])

        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        log.note("window-shown", [
            "isVisible": window.isVisible,
            "isKeyWindow": window.isKeyWindow,
            "appIsActive": app.isActive,
            "occlusion": window.occlusionState.contains(.visible) ? "visible" : "occluded",
        ])

        var result = ScanResult(
            authenticated: false, armed: false, durationMs: 0,
            error: "the probe window closed before anything happened"
        )
        let start = Date()
        var finished = false
        var evaluateInvoked = false

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

        // Evaluate from inside the running loop, once the window is genuinely on
        // screen. Doing it before `run()` was the other ordering suspect.
        DispatchQueue.main.async {
            log.note("evaluatePolicy-invoked", [
                "policy": "deviceOwnerAuthenticationWithBiometrics",
                "onContext": String(UInt(bitPattern: ObjectIdentifier(context).hashValue), radix: 16),
                "interactionNotAllowed": context.interactionNotAllowed,
                "authViewFrameWidth": authView.frame.width,
                "authViewFrameHeight": authView.frame.height,
                "windowIsKey": window.isKeyWindow,
                "appIsActive": app.isActive,
            ])
            evaluateInvoked = true
            context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: "unlock varlock encryption key \(keyId)"
            ) { success, error in
                let nsError = error as NSError?
                DispatchQueue.main.async {
                    log.note("evaluatePolicy-completed", [
                        "success": success,
                        "error": nsError?.localizedDescription ?? "<none>",
                        "errorDomain": nsError?.domain ?? "<none>",
                        "errorCode": nsError?.code ?? 0,
                    ])
                    finish(ScanResult(
                        authenticated: success,
                        armed: true,
                        durationMs: Int(Date().timeIntervalSince(start) * 1000),
                        error: success ? nil : "authentication did not complete: "
                            + (nsError?.localizedDescription ?? "unknown")
                    ))
                }
            }
        }

        // Heartbeat, so a run that stalls still says what the window was doing.
        var heartbeats = 0
        let heartbeat = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            heartbeats += 1
            log.note("heartbeat", [
                "n": heartbeats,
                "authViewFrameWidth": authView.frame.width,
                "authViewFrameHeight": authView.frame.height,
                "windowIsKey": window.isKeyWindow,
                "windowIsVisible": window.isVisible,
                "appIsActive": app.isActive,
                "evaluateInvoked": evaluateInvoked,
                // An armed inline prompt has to draw its glyph out of something.
                // An empty view with no layer content is the difference between
                // "waiting for a finger" and "never engaged at all", which is the
                // one thing a run with nobody present cannot otherwise tell apart.
                "authViewSubviews": authView.subviews.count,
                "authViewHasLayerContents": authView.layer?.contents != nil,
                "authViewSublayers": authView.layer?.sublayers?.count ?? 0,
            ])
        }
        RunLoop.main.add(heartbeat, forMode: .common)

        DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSeconds) {
            let hadArea = authView.frame.width > 0 && authView.frame.height > 0
            log.note("timed-out", [
                "evaluateInvoked": evaluateInvoked,
                "authViewHadArea": hadArea,
            ])
            finish(ScanResult(
                authenticated: false,
                // "Armed" means the prompt was genuinely presentable. Saying so
                // honestly is what tells a stalled run from an unanswered one.
                armed: evaluateInvoked && hadArea,
                durationMs: Int(Date().timeIntervalSince(start) * 1000),
                error: "nobody answered the embedded prompt within \(Int(timeoutSeconds))s"
                    + (hadArea ? "" : "; the inline view had no drawable area, so there was nothing to touch")
            ))
        }

        app.run()
        heartbeat.invalidate()
        log.note("run-loop-exited")
        return result
    }
}
