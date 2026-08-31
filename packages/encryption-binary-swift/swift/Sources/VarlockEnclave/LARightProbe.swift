import Foundation
import AppKit
import Security
import LocalAuthentication
import LocalAuthenticationEmbeddedUI

/// Spike: does the `LARight` API give us the inline biometric prompt, and could
/// its key hold our custody wrap?
///
/// Two separate questions, and this answers as much of each as a machine can.
///
/// 1. PRESENTATION. `LAAuthenticationView` pairs with an `LAContext`, and driving
///    that context with `evaluatePolicy` has not produced an inline prompt here:
///    macOS presents its own alert instead. `LARight.authorize` is a different
///    entry point, and the suggestion is that the inline experience belongs to it.
///    The probe drives a right and logs everything, but where the prompt is drawn
///    is not something the process can see. A person has to watch. It also puts an
///    `LAAuthenticationView` on screen next to it, so there is something to watch
///    for: if the glyph animates in OUR window, inline works.
///
/// 2. CUSTODY. Our unwrap is ECIES: ECDH against the device key, then HKDF and
///    AES-GCM. `LAPrivateKey` (from a persisted right) advertises
///    `exchangeKeys(publicKey:algorithm:parameters:)`, which is that ECDH. This
///    part needs no human at all: the key is asked, synchronously, whether it can
///    perform the operations our format needs, and the answer decides whether an
///    `LARight`-backed custody key is even possible.
///
/// Run it with: `varlock-enclave probe-laright [--verbose] [--timeout <s>]`.
/// It creates a right under a throwaway identifier and removes it afterwards.
enum LARightProbe {
    private static let rightIdentifier = "dev.varlock.probe.laright"

    static func run(verbose: Bool, timeoutSeconds: TimeInterval) -> [String: Any] {
        let log = EmbeddedUnlockProbe.Log(verbose: verbose)
        log.note("probe-start", [
            "bundleIdentifier": Bundle.main.bundleIdentifier ?? "<none>",
            "timeoutSeconds": Int(timeoutSeconds),
        ])

        guard UiAvailability.canShowUi() else {
            return finish(log: log, [
                "verdict": "inconclusive",
                "reason": "no window server session; run this from a desktop session",
            ])
        }

        // -- question 2 first, since it needs nobody and can rule the idea out --
        let custody = probeCustodyCapability(log: log)

        // -- question 1: drive a right and let a person watch where it draws --
        let presentation = probePresentation(log: log, timeoutSeconds: timeoutSeconds)

        var verdict = "laright-unusable"
        if custody["canExchangeKeys"] as? Bool == true, presentation["authorized"] as? Bool == true {
            verdict = "laright-viable"
        } else if presentation["authorized"] as? Bool == true {
            verdict = "laright-authorizes-but-no-key-path"
        }

        return finish(log: log, [
            "verdict": verdict,
            "custody": custody,
            "presentation": presentation,
            "confirmVisually": "the question a program cannot answer: did the Touch ID prompt appear "
                + "INSIDE the probe window, or as a separate system dialog?",
        ])
    }

    private static func finish(log: EmbeddedUnlockProbe.Log, _ result: [String: Any]) -> [String: Any] {
        var output = result
        output["lifecycle"] = log.entries
        return output
    }

    // MARK: - Can an LARight key hold our custody wrap?

    /// Asks a right-backed key whether it can do what our wrap format needs.
    ///
    /// Creating the right may itself require authorization, so a failure here is
    /// reported rather than treated as a verdict. The capability answers, when we
    /// get them, are synchronous and need no scan.
    private static func probeCustodyCapability(log: EmbeddedUnlockProbe.Log) -> [String: Any] {
        let requirement = LAAuthenticationRequirement.biometry(
            fallback: LABiometryFallbackRequirement.devicePasscode
        )
        let right = LARight(requirement: requirement)
        log.note("custody-right-built")

        var result: [String: Any] = ["attempted": true]
        let done = DispatchSemaphore(value: 0)

        // A fresh identifier each run, so a leftover from a previous run cannot
        // answer for this one.
        let identifier = "\(rightIdentifier).\(UUID().uuidString.prefix(8))"
        LARightStore.shared.saveRight(right, identifier: identifier) { persisted, error in
            if let error {
                log.note("custody-save-failed", ["error": error.localizedDescription])
                result["saved"] = false
                result["error"] = error.localizedDescription
                done.signal()
                return
            }
            guard let persisted else {
                result["saved"] = false
                done.signal()
                return
            }
            log.note("custody-right-saved", ["identifier": identifier])
            result["saved"] = true

            // The whole question: our unwrap is an ECDH against the device key.
            let key = persisted.key
            let ecdh = key.canExchangeKeys(using: .ecdhKeyExchangeCofactorX963SHA256)
            let ecies = key.canDecrypt(using: .eciesEncryptionStandardVariableIVX963SHA256AESGCM)
            log.note("custody-key-capabilities", [
                "canExchangeKeysECDH": ecdh,
                "canDecryptECIES": ecies,
            ])
            result["canExchangeKeys"] = ecdh
            result["canDecryptECIES"] = ecies

            LARightStore.shared.removeRight(persisted) { removeError in
                if let removeError {
                    log.note("custody-cleanup-failed", ["error": removeError.localizedDescription])
                }
                done.signal()
            }
        }

        if done.wait(timeout: .now() + 20) == .timedOut {
            log.note("custody-timed-out")
            result["timedOut"] = true
        }
        return result
    }

    // MARK: - Where does an LARight draw its prompt?

    private static func probePresentation(
        log: EmbeddedUnlockProbe.Log,
        timeoutSeconds: TimeInterval
    ) -> [String: Any] {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 240),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = "Varlock LARight probe"
        window.level = .floating
        window.center()

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false

        let heading = NSTextField(labelWithString: "LARight authorization")
        heading.font = NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)
        stack.addArrangedSubview(heading)

        let explainer = NSTextField(wrappingLabelWithString:
            "Touch the sensor. WATCH WHERE THE PROMPT APPEARS. If it animates in the "
            + "box below, the inline experience works and we can build on it. If a "
            + "separate system dialog opens instead, it does not.")
        explainer.alignment = .center
        explainer.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        explainer.textColor = .secondaryLabelColor
        stack.addArrangedSubview(explainer)

        // A view bound to its own context, purely as something to watch. The right
        // is not paired to it: nothing in the headers offers that pairing, which is
        // itself part of the finding.
        let watchContext = LAContext()
        let authView = LAAuthenticationView(context: watchContext, controlSize: .large)
        authView.translatesAutoresizingMaskIntoConstraints = false
        let fitting = authView.fittingSize
        NSLayoutConstraint.activate([
            authView.widthAnchor.constraint(equalToConstant: max(fitting.width, 64)),
            authView.heightAnchor.constraint(equalToConstant: max(fitting.height, 64)),
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
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        log.note("window-shown", ["isKeyWindow": window.isKeyWindow, "appIsActive": app.isActive])

        var outcome: [String: Any] = ["authorized": false]
        var finished = false
        let start = Date()

        let stop: ([String: Any]) -> Void = { result in
            guard !finished else { return }
            finished = true
            outcome = result
            window.orderOut(nil)
            NSApp.stop(nil)
            NSApp.postEvent(
                NSEvent.otherEvent(
                    with: .applicationDefined, location: .zero, modifierFlags: [],
                    timestamp: 0, windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0
                )!,
                atStart: true
            )
        }

        let requirement = LAAuthenticationRequirement.biometry(
            fallback: LABiometryFallbackRequirement.devicePasscode
        )
        let right = LARight(requirement: requirement)

        DispatchQueue.main.async {
            right.checkCanAuthorize { error in
                log.note("checkCanAuthorize", ["error": error?.localizedDescription ?? "<none>"])
            }
            log.note("authorize-invoked", ["state": right.state.rawValue])
            right.authorize(localizedReason: "unlock varlock encryption keys") { error in
                DispatchQueue.main.async {
                    let nsError = error as NSError?
                    log.note("authorize-completed", [
                        "error": nsError?.localizedDescription ?? "<none>",
                        "errorCode": nsError?.code ?? 0,
                        "state": right.state.rawValue,
                        "inlineViewDrewSomething": EmbeddedUnlockProbe.inlineViewDrewSomething(authView),
                        "authAgentWindows": EmbeddedUnlockProbe.authAgentWindowOwners().joined(separator: ","),
                    ])
                    stop([
                        "authorized": error == nil,
                        "error": nsError?.localizedDescription ?? NSNull(),
                        "rightState": right.state.rawValue,
                        "durationMs": Int(Date().timeIntervalSince(start) * 1000),
                        "inlineViewDrewSomething": EmbeddedUnlockProbe.inlineViewDrewSomething(authView),
                        "authAgentWindowsSeen": EmbeddedUnlockProbe.authAgentWindowOwners(),
                    ])
                }
            }
        }

        var beats = 0
        let heartbeat = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            beats += 1
            log.note("heartbeat", [
                "n": beats,
                "rightState": right.state.rawValue,
                "inlineViewDrewSomething": EmbeddedUnlockProbe.inlineViewDrewSomething(authView),
                "authAgentWindows": EmbeddedUnlockProbe.authAgentWindowOwners().joined(separator: ","),
            ])
        }
        RunLoop.main.add(heartbeat, forMode: .common)

        DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSeconds) {
            log.note("timed-out", ["rightState": right.state.rawValue])
            stop([
                "authorized": false,
                "error": "nobody answered within \(Int(timeoutSeconds))s",
                "rightState": right.state.rawValue,
                "inlineViewDrewSomething": EmbeddedUnlockProbe.inlineViewDrewSomething(authView),
                "authAgentWindowsSeen": EmbeddedUnlockProbe.authAgentWindowOwners(),
            ])
        }

        app.run()
        heartbeat.invalidate()
        return outcome
    }
}
