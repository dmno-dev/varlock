import Foundation
import AppKit
import CoreGraphics
import LocalAuthentication
import LocalAuthenticationEmbeddedUI
import SessionScoping

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
        //
        // Made here and used once: a reused or invalidated context is one of the
        // stock explanations for a blank inline view, so the probe rules it out
        // by construction rather than by inspection.
        var checklist = Checklist()
        let context = LAContext()
        checklist.freshContext = true
        let selfFacts = PeerPostureReader().selfFacts()
        checklist.signatureValid = selfFacts.signatureValid
        checklist.hardenedRuntime = selfFacts.hasHardenedRuntime
        checklist.screenScanPermitted = CGPreflightScreenCaptureAccess()
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
        checklist.canEvaluate = canBiometrics
        checklist.canEvaluateError = biometricError?.localizedDescription ?? "<none>"
        guard canBiometrics else {
            return finish(log: log, [
                "verdict": "inconclusive",
                "checklist": checklist.asDictionary,
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
            timeoutSeconds: timeoutSeconds,
            checklist: checklist
        )
        guard scan.authenticated else {
            context.invalidate()
            return finish(log: log, [
                "verdict": scan.armed ? "inconclusive" : "embedded-never-armed",
                "checklist": scan.checklist.asDictionary,
                "reason": scan.error ?? "authentication did not complete",
                "phases": phases,
                "presentation": observedPresentation(scan),
                "inlineViewDrewSomething": scan.inlineDrew,
                "authAgentWindowsSeen": scan.agentWindows,
                "bundleIdentifier": Bundle.main.bundleIdentifier ?? "<none>",
                "interpretation": scan.armed
                    ? "the evaluation was running but nobody completed it"
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

        // Deliberately says nothing about WHERE the prompt appeared. An earlier
        // verdict of "embedded-single-scan" was read as proof of inline rendering
        // when all it ever established was the handoff, and the two came apart in
        // the field: the scan really did carry over, and it really did happen in a
        // separate system alert.
        let presentation = observedPresentation(scan)
        return finish(log: log, [
            "verdict": handoffPassed ? "embedded-handoff-ok" : "embedded-handoff-lost",
            "checklist": scan.checklist.asDictionary,
            "scansRequested": 1,
            "policy": "deviceOwnerAuthenticationWithBiometrics",
            "authenticationMs": scan.durationMs,
            "phases": phases,
            "presentation": presentation,
            "inlineViewDrewSomething": scan.inlineDrew,
            "authAgentWindowsSeen": scan.agentWindows,
            "bundleIdentifier": Bundle.main.bundleIdentifier ?? "<none>",
            "interpretation": handoffPassed
                ? "one scan covered every enclave operation that followed, wherever the prompt was drawn"
                : "the context authenticated by the embedded view did not carry to the enclave; "
                    + "the panel would have to fall back to the system dialog",
            "confirmVisually": presentation == "inline"
                ? "the Touch ID prompt should have been inside the probe window, with no separate dialog"
                : "a separate system authentication dialog is expected to have appeared; "
                    + "the probe window should read as an information card",
        ])
    }

    private static func finish(log: Log, _ result: [String: Any]) -> [String: Any] {
        var output = result
        output["lifecycle"] = log.entries
        return output
    }

    // MARK: - Telling inline apart from the standard alert

    /// On-screen windows owned by one of the system's authentication agents.
    ///
    /// This is the only programmatic signal found for "the standard alert
    /// presented instead of the inline view". The alert is drawn by a separate
    /// process, so it never appears in `NSApp.windows`; what it does do is put a
    /// window on screen under an owner name we can recognise. Window *names* need
    /// screen-recording consent, but owner names do not, which is all this reads.
    ///
    /// Absence is weak evidence (the list of agent names is not guaranteed
    /// complete, and the alert may not have opened yet), so this is reported as
    /// an observation rather than treated as proof either way.
    static func authAgentWindowOwners() -> [String] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let infos = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        let ourPid = ProcessInfo.processInfo.processIdentifier
        var owners = Set<String>()
        for info in infos {
            if let pid = info[kCGWindowOwnerPID as String] as? pid_t, pid == ourPid { continue }
            guard let owner = info[kCGWindowOwnerName as String] as? String else { continue }
            let lowered = owner.lowercased()
            if lowered.contains("auth") || lowered.contains("securityagent") || lowered.contains("biome") {
                owners.insert(owner)
            }
        }
        return owners.sorted()
    }

    /// What the run observed about where the prompt was drawn.
    ///
    /// `inline` needs positive evidence that the view rendered. `system-alert`
    /// needs an authentication agent window on screen while the view stayed empty.
    /// Anything else is `unknown`, and says so rather than guessing, because
    /// guessing here is exactly what produced a verdict that turned out to be
    /// false when somebody finally watched the screen.
    private static func observedPresentation(_ scan: ScanResult) -> String {
        if scan.inlineDrew { return "inline" }
        if !scan.agentWindows.isEmpty { return "system-alert" }
        return "unknown"
    }

    /// Whether the inline view ever drew anything of its own.
    ///
    /// An armed inline prompt has to render its glyph out of some layer or
    /// subview. A view that stays completely empty for the whole evaluation never
    /// engaged, whatever the authentication itself returned.
    static func inlineViewDrewSomething(_ view: NSView) -> Bool {
        return !view.subviews.isEmpty
            || view.layer?.contents != nil
            || !(view.layer?.sublayers ?? []).isEmpty
    }

    // MARK: - The window

    /// Every condition the inline view is supposed to need, answered rather than
    /// assumed.
    ///
    /// The advice for "LAAuthenticationView renders blank" is a list of things to
    /// check, and a list that is merely believed is worth nothing. Each of these
    /// is asserted at the moment it matters and reported per run, so the only
    /// unexplained difference between a working and a non-working run is the one
    /// variable left: the signature.
    struct Checklist {
        /// The embedded-UI framework is linked and its class is really there.
        var embeddedUiLinked = false
        /// The view had real area, full opacity, was not hidden, and was in a
        /// visible key window BEFORE the evaluation started.
        var viewReadyBeforeEvaluate = false
        var viewFrame = "0x0"
        var viewAlpha: Double = 0
        var viewHidden = true
        var windowVisibleAndKey = false
        /// The context was made for this attempt, not reused from an earlier one.
        var freshContext = false
        /// The context evaluated is the same instance the view was built around.
        var sameContextAsView = false
        var canEvaluate = false
        var canEvaluateError = "<none>"
        /// The LAError code when the evaluation failed. 0 when it did not.
        var evaluateErrorCode = 0
        var evaluateErrorDomain = "<none>"
        /// What the kernel says about this build's own hardening, which is the
        /// variable the signing experiment moves.
        var signatureValid = false
        var hardenedRuntime = false
        /// Whether this process may see other applications' windows at all.
        ///
        /// Without screen-recording permission the scan for the system's own
        /// authentication alert can only ever come back empty, which is not the
        /// same as the alert not being there. Saying so turns a misleading "none"
        /// into an honest "cannot tell".
        var screenScanPermitted = false
        /// Which activation policy the probe ran under.
        ///
        /// The daemon is an `.accessory` app (no Dock icon) and the probe has
        /// always been `.regular`. If the inline view behaves differently between
        /// them, that difference belongs to the policy and not to the signature,
        /// which is worth knowing before blaming a certificate.
        var activationPolicy = "regular"

        var asDictionary: [String: Any] {
            return [
                "embeddedUiLinked": embeddedUiLinked,
                "viewReadyBeforeEvaluate": viewReadyBeforeEvaluate,
                "viewFrame": viewFrame,
                "viewAlpha": viewAlpha,
                "viewHidden": viewHidden,
                "windowVisibleAndKey": windowVisibleAndKey,
                "freshContext": freshContext,
                "sameContextAsView": sameContextAsView,
                "canEvaluate": canEvaluate,
                "canEvaluateError": canEvaluateError,
                "evaluateErrorCode": evaluateErrorCode,
                "evaluateErrorDomain": evaluateErrorDomain,
                "signatureValid": signatureValid,
                "hardenedRuntime": hardenedRuntime,
                "screenScanPermitted": screenScanPermitted,
                "activationPolicy": activationPolicy,
            ]
        }
    }

    private struct ScanResult {
        let authenticated: Bool
        /// Whether the inline prompt ever looked usable: a view with real area,
        /// in a visible key window, with the evaluation running.
        let armed: Bool
        /// Whether the inline view ever drew anything of its own. False means the
        /// authentication happened somewhere else, whatever its result.
        let inlineDrew: Bool
        /// Authentication-agent windows seen on screen while evaluating.
        let agentWindows: [String]
        let durationMs: Int
        let error: String?
        var checklist = Checklist()
    }

    /// Give the window a moment to actually become key before doing anything
    /// that depends on it being key.
    ///
    /// `makeKeyAndOrderFront` is a request, not a fact: the window server gets to
    /// it when it gets to it, and a run started from a terminal can be a beat
    /// behind. Polling briefly is the difference between testing the signature
    /// and testing who had focus.
    private static func waitForKeyWindow(
        window: NSWindow,
        app: NSApplication,
        log: Log,
        attemptsLeft: Int = 20,
        then work: @escaping () -> Void
    ) {
        if window.isKeyWindow || attemptsLeft <= 0 {
            log.note("window-key-wait-finished", [
                "isKeyWindow": window.isKeyWindow,
                "attemptsLeft": attemptsLeft,
            ])
            work()
            return
        }
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            waitForKeyWindow(window: window, app: app, log: log, attemptsLeft: attemptsLeft - 1, then: work)
        }
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
        timeoutSeconds: TimeInterval,
        checklist: Checklist
    ) -> ScanResult {
        var checklist = checklist
        let app = NSApplication.shared
        // Overridable so the probe can be run the way the daemon actually runs:
        // an accessory app with no Dock icon.
        let wantsAccessory = ProcessInfo.processInfo.environment["_VARLOCK_PROBE_ACTIVATION"] == "accessory"
        app.setActivationPolicy(wantsAccessory ? .accessory : .regular)
        checklist.activationPolicy = wantsAccessory ? "accessory" : "regular"
        log.note("activation-policy-set", ["policy": checklist.activationPolicy])

        // The window can be built the probe's way or the panel's way, so a
        // bisection can move one axis at a time between an environment where the
        // inline view renders and one where it does not.
        let wantsPanelWindow = ProcessInfo.processInfo.environment["_VARLOCK_PROBE_WINDOW"] == "panel"
        let window: NSWindow = wantsPanelWindow
            ? ApprovalPanelWindow(
                contentRect: NSRect(x: 0, y: 0, width: 460, height: 230),
                styleMask: [.titled, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            : NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 460, height: 230),
                styleMask: [.titled],
                backing: .buffered,
                defer: false
            )
        if wantsPanelWindow {
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.level = .floating
            window.appearance = NSAppearance(named: .darkAqua)
            log.note("window-class", ["class": "ApprovalPanelWindow", "level": "floating"])
        }
        // A run that a person is watching has to say which run it is. Several of
        // these windows look identical, and an experiment whose variants cannot
        // be told apart is not an experiment.
        let variantLabel = ProcessInfo.processInfo.environment["_VARLOCK_PROBE_LABEL"]
        window.title = variantLabel.map { "Varlock probe: \($0)" } ?? "Varlock embedded unlock probe"
        window.level = .floating
        window.center()

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false

        if let variantLabel {
            let banner = NSTextField(labelWithString: variantLabel.uppercased())
            banner.font = NSFont.monospacedSystemFont(ofSize: 15, weight: .bold)
            banner.textColor = .systemPink
            stack.addArrangedSubview(banner)
        }

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

        let boundContext = context
        let authView = LAAuthenticationView(context: boundContext, controlSize: .large)
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
        // The class has to exist at runtime, not just compile: a build that
        // linked the framework and a build that did not look identical in source.
        checklist.embeddedUiLinked = NSClassFromString("LAAuthenticationView") != nil

        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        log.note("window-shown", [
            "isVisible": window.isVisible,
            "isKeyWindow": window.isKeyWindow,
            "appIsActive": app.isActive,
            "occlusion": window.occlusionState.contains(.visible) ? "visible" : "occluded",
        ])

        var result = ScanResult(
            authenticated: false, armed: false, inlineDrew: false, agentWindows: [],
            durationMs: 0,
            error: "the probe window closed before anything happened",
            checklist: checklist
        )
        let start = Date()
        var finished = false
        var evaluateInvoked = false
        // Sampled throughout, because the answer is "did this EVER happen", not
        // whatever happened to be true at the final instant.
        var inlineEverDrew = false
        var agentWindowsSeen = Set<String>()

        let finish: (ScanResult) -> Void = { outcome in
            guard !finished else { return }
            finished = true
            result = outcome
            window.orderOut(nil)
            if ProcessInfo.processInfo.environment["_VARLOCK_PROBE_MODAL"] == "1" {
                NSApp.stopModal()
            } else {
                NSApp.stop(nil)
            }
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
        // screen AND key. Doing it before `run()` was the other ordering suspect,
        // and evaluating into a window that had not become key yet would leave
        // the checklist answering a question nobody asked.
        waitForKeyWindow(window: window, app: app, log: log) {
            log.note("evaluatePolicy-invoked", [
                "policy": "deviceOwnerAuthenticationWithBiometrics",
                "onContext": String(UInt(bitPattern: ObjectIdentifier(context).hashValue), radix: 16),
                "interactionNotAllowed": context.interactionNotAllowed,
                "authViewFrameWidth": authView.frame.width,
                "authViewFrameHeight": authView.frame.height,
                "windowIsKey": window.isKeyWindow,
                "appIsActive": app.isActive,
            ])
            // Everything the view is supposed to need, checked at the last
            // moment before the evaluation rather than taken on trust.
            authView.layoutSubtreeIfNeeded()
            checklist.viewFrame = "\(Int(authView.frame.width))x\(Int(authView.frame.height))"
            checklist.viewAlpha = Double(authView.alphaValue)
            checklist.viewHidden = authView.isHidden
            checklist.windowVisibleAndKey = window.isVisible && window.isKeyWindow
            checklist.viewReadyBeforeEvaluate = authView.frame.width >= 44
                && authView.frame.height >= 44
                && authView.alphaValue == 1
                && !authView.isHidden
                && authView.window != nil
                && checklist.windowVisibleAndKey
            checklist.sameContextAsView = boundContext === context
            log.note("checklist-before-evaluate", checklist.asDictionary)
            // Measured again shortly after the evaluation starts, since the view
            // draws in response to it rather than before.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                log.note("scan-pixels", WindowPixels.sample(authView).asDictionary)
            }

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
                    checklist.evaluateErrorCode = nsError?.code ?? 0
                    checklist.evaluateErrorDomain = nsError?.domain ?? "<none>"
                    inlineEverDrew = inlineEverDrew || inlineViewDrewSomething(authView)
                    agentWindowsSeen.formUnion(authAgentWindowOwners())
                    finish(ScanResult(
                        authenticated: success,
                        armed: true,
                        inlineDrew: inlineEverDrew,
                        agentWindows: agentWindowsSeen.sorted(),
                        durationMs: Int(Date().timeIntervalSince(start) * 1000),
                        error: success ? nil : "authentication did not complete: "
                            + (nsError?.localizedDescription ?? "unknown"),
                        checklist: checklist
                    ))
                }
            }
        }

        // Heartbeat, so a run that stalls still says what the window was doing.
        var heartbeats = 0
        let heartbeat = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            heartbeats += 1
            inlineEverDrew = inlineEverDrew || inlineViewDrewSomething(authView)
            agentWindowsSeen.formUnion(authAgentWindowOwners())
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
                // The standard alert is drawn by another process, so a window
                // belonging to one of the system's authentication agents appearing
                // while we are evaluating means the inline view was bypassed.
                "authAgentWindows": authAgentWindowOwners().joined(separator: ","),
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
                inlineDrew: inlineEverDrew,
                agentWindows: agentWindowsSeen.sorted(),
                durationMs: Int(Date().timeIntervalSince(start) * 1000),
                error: "nobody answered the embedded prompt within \(Int(timeoutSeconds))s"
                    + (hadArea ? "" : "; the inline view had no drawable area, so there was nothing to touch"),
                checklist: checklist
            ))
        }

        // The panel runs its window in a nested modal session; the probe has
        // always used the plain run loop. Which of those the inline view can
        // live with is exactly the sort of thing this probe exists to find out.
        if ProcessInfo.processInfo.environment["_VARLOCK_PROBE_MODAL"] == "1" {
            log.note("run-mode", ["mode": "runModal"])
            _ = app.runModal(for: window)
        } else {
            log.note("run-mode", ["mode": "run"])
            app.run()
        }
        heartbeat.invalidate()
        log.note("run-loop-exited")
        return result
    }
}
