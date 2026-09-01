import AppKit
import LocalAuthentication
import LocalAuthenticationEmbeddedUI
import IdentitySessions
import SessionScoping

/// The panel the daemon draws when someone has to say yes.
///
/// It answers three questions in the order a person asks them: what is being
/// unlocked, who is asking, and for how long. Then it offers one gesture. The
/// scan IS the approval: the presence check is armed as the panel opens, so on a
/// machine with Touch ID there is nothing to click in the common case.
///
/// It is a window we draw ourselves rather than an `NSAlert`, because the layout
/// is the message: a key box that opens to say what the caller gets, and a
/// vertical chain that shows the line of processes leading to them with the one
/// hop that matters emphasised. An alert can hold text and buttons, and none of
/// that would fit inside one.
///
/// The scan happens inside this window. `LAAuthenticationView`, bound to the
/// context this approval will run under, sits on its own above the buttons;
/// touching the sensor while the panel is up is the approval, and no system
/// alert appears over the top of it.
///
/// It has to stand on its own. Inside the approve button it drew nothing, which
/// is the same blankness that got the view written off in the first place: every
/// place it has ever rendered (the probe window, and here) has had it as a plain
/// sibling view, unclipped and owning its own area, rather than nested in a
/// control that does its own drawing.
///
/// That view was believed not to work. An earlier arc concluded it rendered
/// blank on macOS 26 and shipped a drawn glyph plus the system's alert instead.
/// The cause was never the view, the signature, the bundle, the window class, or
/// the modal session: `scripts/render-bisect.ts` measured all of them by
/// photographing the pixels, and the one axis that flipped rendering was HOW THE
/// PANEL IS PRESENTED FROM THE IPC THREAD.
///
///   panel presented inside `DispatchQueue.main.sync`   1 distinct grey (blank)
///   same panel presented via `RunLoop.main.perform`   51 distinct greys (drawn)
///
/// The daemon answers IPC on a background queue, so the panel used to be drawn
/// from inside a main-QUEUE work item that stays in flight for as long as the
/// modal is up. LocalAuthentication needs the main queue to render into the view
/// it was bound to, and a blocked main queue starves it: the view stays empty
/// forever, and because a bound view suppresses the system alert, nothing
/// anywhere asks for a finger. That is the same starvation that once stopped the
/// check from arming at all, which is why `MainLoop` exists; the presentation
/// itself was the last place still doing it the old way.
///
/// So: present through the run loop, never through the main queue.
///
/// The fallback is still there for the machines that cannot embed (no biometrics
/// enrolled, or the sensor locked out), and for `_VARLOCK_EMBEDDED_PROMPT=0`.
///
/// This file is view only. What the panel says, which scopes it may offer, and
/// what a given answer means are decided in `IdentitySessions`
/// (`UnlockDecision.swift`, `PanelContent.swift`, `ApprovalFlow.swift`), so the
/// rules stay testable without a window server.
///
/// It is drawn by the daemon on purpose. The daemon is the process that holds
/// the keys and the one that verified the peer, so it is the only party in a
/// position to say truthfully who is asking. A panel drawn by the caller would
/// be a panel the caller can lie on.
final class ApprovalPanel: NSObject {
    /// How long the whole interaction may take before it counts as a refusal.
    /// Below the client's 5 minute interactive timeout, so the caller gets a real
    /// answer rather than a dead socket.
    static let timeoutSeconds: TimeInterval = 120

    /// How long the panel must have been on screen and in front before the scan
    /// is armed.
    ///
    /// This used to be most of a second, for a good reason that has since gone
    /// away: arming summoned the system's own sheet, which covered the panel, so
    /// the delay was the only thing standing between a user and approving
    /// something they never got to read. The scan happens inside the panel now.
    /// There is nothing to occlude, so the wait buys nothing and costs the user a
    /// sensor that lights up late. What is left is one frame's grace for the
    /// window to finish coming up.
    static let armingDelaySeconds: TimeInterval = 0.12

    /// How long to keep waiting for the panel to actually be frontmost before
    /// arming anyway. Something else stealing focus must not cost the user their
    /// unlock.
    static let readinessTimeoutSeconds: TimeInterval = 3

    /// Ends the modal when the flow produced an answer, rather than when a
    /// button's own handling did.
    private static let flowFinishedResponse = NSApplication.ModalResponse(rawValue: 9001)

    /// What the panel answered, and the presence check that answered it.
    struct Outcome {
        let decision: PanelDecision
        /// Present only when a presence check approved this. Handing this exact
        /// context to the enclave is what keeps one scan covering the whole unlock.
        let proof: IdentitySessionManager.PresenceProof?
    }

    private var window: ApprovalPanelWindow?
    private var scopeControl: PanelSegmentedControl?
    private var confirmButton: PanelButton?
    private var passwordLink: PanelButton?
    private var hintLabel: NSTextField?
    private var statusLabel: NSTextField?
    private var contentColumn: NSStackView?
    /// Apple's scan surface, when this panel is on the embedded path. Owned by
    /// the primary control; kept here so the panel can photograph it.
    private var embeddedScanView: NSView?
    /// The primary control on a machine that can scan: the button that is also
    /// the sensor.
    private var scanButton: PanelScanButton?

    private var scopes: [SessionGrantScope] = []
    private var duration: DurationPreset = .default
    private var timedOut = false
    private var flow: ApprovalFlow!
    private var attempt: IdentitySessionManager.PresenceAttempt?
    /// Bumped whenever the presence attempt is replaced, so a callback from an
    /// attempt we walked away from cannot rewrite the panel's state.
    private var attemptGeneration = 0
    private var presenceReason = ""
    private var proof: IdentitySessionManager.PresenceProof?
    /// Why the last check ended, which is what the hint line is about.
    private var lastFailure: IdentitySessionManager.PresenceFailure.Kind = .failed
    /// Guards against a presence callback arriving after the modal has ended.
    private var modalRunning = false
    /// The panel arms itself once, ever. Every later scan is a button press.
    private var hasAutoArmed = false

    /// Show a panel and wait for the answer.
    ///
    /// Returns nil when the panel could not be drawn at all, which the caller
    /// reports as `NO_UI`. A refusal comes back as a decision with `approved`
    /// false, so callers can tell "the user said no" from "nobody could be asked".
    ///
    /// With an `attempt`, the panel carries a presence check: embedded (armed as
    /// the panel opens, the scan is the answer) or the system dialog fallback
    /// (raised by the approve button). Without one it is a plain button panel.
    static func present(
        content: PanelContent,
        presenceReason: String = "",
        attempt: IdentitySessionManager.PresenceAttempt? = nil
    ) -> Outcome? {
        guard UiAvailability.canShowUi() else { return nil }

        PanelDebug.note("present-called", [
            "mode": String(describing: attempt?.mode ?? .none),
            "onMainThread": Thread.isMainThread,
        ])
        var outcome: Outcome?
        let work = {
            let panel = ApprovalPanel()
            outcome = panel.run(content: content, presenceReason: presenceReason, attempt: attempt)
        }
        if Thread.isMainThread {
            work()
        } else {
            // Handed to the main thread's RUN LOOP, never wrapped in
            // `DispatchQueue.main.sync`. That distinction is the whole reason the
            // inline Touch ID view works at all; see the note at the top of this
            // file. The IPC thread still waits here for the answer, which is what
            // keeps the socket call synchronous.
            let done = DispatchSemaphore(value: 0)
            MainLoop.perform {
                work()
                done.signal()
            }
            done.wait()
        }
        PanelDebug.note("present-returned", ["approved": outcome?.decision.approved ?? false])
        return outcome
    }

    /// Draw the panel to a PNG without showing it or asking anyone anything.
    ///
    /// The panel is the one part of this daemon whose correctness is visual, and
    /// a screen it takes over is an awkward thing to inspect: it floats, it is
    /// modal, and on a headless or remote session it cannot be looked at at all.
    /// This renders the very same view tree the modal would put on screen, so a
    /// layout can be checked by looking at the picture. Nothing is unlocked and
    /// no presence check is started.
    static func previewPng(
        content: PanelContent,
        mode: ApprovalPresenceMode,
        expandChain: Bool = false
    ) -> Data? {
        let panel = ApprovalPanel()
        panel.scopes = content.scopes
        panel.flow = ApprovalFlow(content: content, presenceMode: mode)
        let window = panel.buildWindow(content: content, mode: mode, expandChain: expandChain)
        guard let view = window.contentView else { return nil }
        // Icons fill themselves in from the run loop, which a command that never
        // runs one would never give them. Pump it briefly so the picture shows
        // what the panel actually shows.
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        return rep.representation(using: .png, properties: [:])
    }

    // MARK: - Running

    private func run(
        content: PanelContent,
        presenceReason: String,
        attempt: IdentitySessionManager.PresenceAttempt?
    ) -> Outcome {
        SecureInputDialog.ensureEditMenu()
        scopes = content.scopes
        self.attempt = attempt
        self.presenceReason = presenceReason
        let mode = attempt?.mode ?? .none
        flow = ApprovalFlow(content: content, presenceMode: mode)
        if let attempt {
            PanelDebug.note("presence-attempt", [
                "mode": String(describing: mode),
                "contextInstance": String(UInt(bitPattern: ObjectIdentifier(attempt.context).hashValue), radix: 16),
                "interactionNotAllowed": attempt.context.interactionNotAllowed,
            ])
        }

        let window = buildWindow(content: content, mode: mode)
        self.window = window

        // Float above whatever the user was looking at, and take focus, so an
        // approval never ends up hidden behind an editor window.
        window.level = .floating
        positionOnScreen(window)
        NSApp.activate(ignoringOtherApps: true)
        PanelDebug.note("panel-shown", [
            "isVisible": window.isVisible,
            "appIsActive": NSApp.isActive,
            "mode": String(describing: mode),
        ])

        // Everything below is scheduled through `MainLoop`, never
        // `DispatchQueue.main.async`. The daemon reaches this code from a
        // background IPC thread via `DispatchQueue.main.sync`, so the main queue
        // has a work item in flight for as long as the panel is up, and anything
        // posted back to that queue would not run until the panel had already
        // closed. That is what silently stopped the presence check from ever being
        // armed: a panel with a glyph, a dead sensor, and no prompt anywhere.
        timedOut = false
        let deadline = MainLoop.after(Self.timeoutSeconds) { [weak self] in
            guard let self, !self.timedOut, self.modalRunning else { return }
            self.timedOut = true
            PanelDebug.note("timed-out")
            NSApp.abortModal()
        }

        // Arm the prompt once the modal loop is running, so it has a live window.
        modalRunning = true
        MainLoop.perform { [weak self] in
            guard let self else { return }
            // The modal is up now, so take the front for real. If the system puts
            // its own alert over us it is welcome to, but when that closes this
            // panel has to be what the user is looking at, not something buried
            // behind the window that stole focus.
            self.bringToFront()
            self.armWhenReadable(deadline: Date().addingTimeInterval(Self.readinessTimeoutSeconds))
        }

        let heartbeat = PanelDebug.isEnabled ? MainLoop.every(2) { [weak self] in
            guard let self, let window = self.window else { return }
            PanelDebug.note("heartbeat", [
                "state": String(describing: self.flow.state),
                "isKeyWindow": window.isKeyWindow,
                "isVisible": window.isVisible,
                "appIsActive": NSApp.isActive,
                "authAgentWindows": EmbeddedUnlockProbe.authAgentWindowOwners().joined(separator: ","),
            ])
        } : nil

        _ = NSApp.runModal(for: window)
        modalRunning = false
        deadline.cancel()
        heartbeat?.cancel()
        window.orderOut(nil)
        self.window = nil

        // The flow is the authority on what was answered, not the button code.
        if timedOut {
            _ = flow.apply(.timedOut)
        } else if case .finished = flow.state {
            // already answered, through the flow
        } else {
            _ = flow.apply(.cancelPressed)
        }

        guard case .finished(let decision) = flow.state, decision.approved else {
            invalidateProof()
            return Outcome(decision: PanelDecision.denied(defaultScope: content.defaultScope), proof: nil)
        }
        return Outcome(decision: decision, proof: proof)
    }

    /// Arm the scan only once the panel is genuinely readable.
    ///
    /// "Readable" is the whole point: on screen, in front, and there long enough
    /// to have been read. The system's biometric sheet lands on top of us the
    /// moment we evaluate, so anything armed before that is a question asked
    /// behind a curtain.
    private func armWhenReadable(deadline: Date) {
        guard modalRunning, !hasAutoArmed else { return }
        guard let window else { return }

        let readable = window.isVisible && window.isKeyWindow && NSApp.isActive
        guard readable || Date() >= deadline else {
            // Polled tightly: every tick here is a tick the sensor is not live.
            _ = MainLoop.after(0.02) { [weak self] in self?.armWhenReadable(deadline: deadline) }
            return
        }

        // The conditions the inline view is supposed to need, asserted at the
        // moment they matter rather than assumed. `sign-probe.ts` checks the same
        // list; a panel that quietly fails one of these would look exactly like
        // the bug this feature spent an arc chasing.
        let scanView = embeddedScanView
        PanelDebug.note("panel-readable", [
            "isKeyWindow": window.isKeyWindow,
            "isVisible": window.isVisible,
            "waitedForFront": readable,
            "embeddedView": scanView != nil,
            "embeddedFrame": scanView.map { "\(Int($0.frame.width))x\(Int($0.frame.height))" } ?? "-",
            // Both frames, because a view with a fine size of its own can still
            // be somewhere useless in the window, and that difference is exactly
            // what nesting it in a button turned out to be.
            "embeddedFrameInWindow": scanView.map {
                let inWindow = $0.convert($0.bounds, to: nil)
                return "\(Int(inWindow.origin.x)),\(Int(inWindow.origin.y)) \(Int(inWindow.width))x\(Int(inWindow.height))"
            } ?? "-",
            "embeddedAttached": scanView?.window != nil,
            "embeddedVisible": scanView.map { !$0.isHidden && $0.alphaValue == 1 } ?? false,
        ])
        _ = MainLoop.after(Self.armingDelaySeconds) { [weak self] in
            guard let self, self.modalRunning, !self.hasAutoArmed else { return }
            self.hasAutoArmed = true
            PanelDebug.note("arming-after-delay", ["seconds": Self.armingDelaySeconds])
            self.perform(effect: self.flow.start())
        }
    }

    /// Roughly how much of the middle of the screen macOS takes for its own
    /// biometric sheet. Its exact size is not ours to know, so this is a
    /// deliberate over-estimate: being too careful costs a little screen, being
    /// too optimistic costs the user their view of what they are approving.
    static let systemSheetHalfHeight: CGFloat = 190

    /// Margin kept above the panel, and between the panel and the sheet.
    static let screenMargin: CGFloat = 44

    /// Put the panel where the system's own sheet cannot cover what matters.
    ///
    /// macOS centres its biometric sheet, and it lands on top of us: a panel
    /// centred too was a panel the user could not read while the scan they were
    /// answering was live. So the panel is anchored high instead, and the layout
    /// puts everything that decides an answer (what is being unlocked, and who
    /// is asking) above everything that merely takes it (scope, buttons). What
    /// the sheet covers is the bottom of the panel.
    ///
    /// A panel too tall to clear the sheet entirely still sits as high as it
    /// fits, so the top of it stays readable.
    private func positionOnScreen(_ window: NSWindow) {
        guard let screen = NSScreen.main else { return }
        let frame = window.frame
        let visible = screen.visibleFrame

        // As high as the screen allows.
        let topAnchored = visible.maxY - Self.screenMargin - frame.height
        // Or lower, if the panel is short enough to sit clear of the sheet and
        // still be near the middle where the eye is.
        let clearOfSheet = visible.midY + Self.systemSheetHalfHeight + Self.screenMargin
        let y = max(min(topAnchored, clearOfSheet), visible.minY + Self.screenMargin)

        window.setFrameOrigin(NSPoint(x: visible.midX - frame.width / 2, y: y))
        PanelDebug.note("panel-positioned", [
            "y": Int(y),
            "height": Int(frame.height),
            "clearsSystemSheet": y >= clearOfSheet,
        ])
    }

    /// Take the front, so the panel is what the user sees.
    ///
    /// Called once the modal is running, and again whenever a presence check ends
    /// without an answer: the system's own alert steals focus while it is up, and
    /// when it goes away the panel underneath has to come back rather than sit
    /// behind whatever was in front before.
    private func bringToFront() {
        guard let window else { return }
        window.level = .floating
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        PanelDebug.note("brought-to-front", [
            "isKeyWindow": window.isKeyWindow,
            "isVisible": window.isVisible,
            "appIsActive": NSApp.isActive,
        ])
    }

    /// A context nobody is going to use must not be left alive.
    private func invalidateProof() {
        proof?.context.invalidate()
        proof = nil
    }

    // MARK: - Flow

    private func perform(effect: ApprovalFlowEffect) {
        PanelDebug.note("flow-effect", [
            "effect": String(describing: effect),
            "state": String(describing: flow.state),
            "scope": flow.scope.rawValue,
        ])
        updateGlyph()
        switch effect {
        case .beginScan:
            setStatus(flow.presenceMode == .embedded
                ? "Touch the sensor to approve."
                : "Waiting for your password.")
            confirmButton?.isEnabled = flow.presenceMode != .embedded
            beginScan()
            watchForSystemAlert()
        case .showControls:
            confirmButton?.isEnabled = true
            setStatus(failureHint())
            // A check that just ended may have had a system alert over us.
            if flow.failedScans > 0 { bringToFront() }
        case .finish(let decision):
            let code: NSApplication.ModalResponse = decision.approved
                ? Self.flowFinishedResponse
                : .cancel
            // Let an approval land before the window goes. Closing on the same
            // frame as the scan reads as the panel vanishing rather than as the
            // unlock completing, and the glyph has just turned green to say so.
            if decision.approved, glyphShowsSuccessAnimation {
                _ = MainLoop.after(TouchIDGlyphView.successHoldSeconds) {
                    NSApp.stopModal(withCode: code)
                }
            } else {
                NSApp.stopModal(withCode: code)
            }
        }
    }

    /// Watch for the system drawing its own alert while the embedded view is
    /// armed, which is the failure this path exists to avoid.
    ///
    /// Only under panel debugging: it costs a window-list scan per sample, and
    /// its only reader is the end-to-end check that asserts the alert stays away.
    private func watchForSystemAlert() {
        guard PanelDebug.isEnabled, flow.presenceMode == .embedded else { return }
        for delay in [0.4, 1.2, 2.5] {
            _ = MainLoop.after(delay) { [weak self] in
                guard let self, self.modalRunning else { return }
                PanelDebug.note("auth-agent-scan", [
                    "afterSeconds": delay,
                    "windows": EmbeddedUnlockProbe.authAgentWindowOwners().joined(separator: ","),
                ])
                // And whether anything was actually drawn where the scan is
                // supposed to be. A blank inline view with no system alert is the
                // worst of the three outcomes: nothing anywhere is listening for
                // a finger, and it looks like a working panel.
                guard let scanView = self.embeddedScanView else { return }
                PanelDebug.note("scan-pixels", WindowPixels.sample(scanView).asDictionary)
            }
        }
    }

    /// Whether an approval is going to be animated, which is the only reason to
    /// hold the panel open a moment longer.
    private var glyphShowsSuccessAnimation: Bool {
        // The system's own view animates its success too, and closing on the same
        // frame as the scan would cut that off just as our drawn glyph's pop was
        // being cut off before.
        guard confirmButton?.glyphView != nil || embeddedScanView != nil else { return false }
        return PanelGlyph.effect(
            for: .approved,
            reduceMotion: TouchIDGlyphView.reduceMotion
        ).isAnimated
    }

    /// Push the flow's current glyph state to the view.
    private func updateGlyph() {
        guard let glyphView = confirmButton?.glyphView else { return }
        let effect = PanelGlyph.effect(
            for: flow.glyphState,
            reduceMotion: TouchIDGlyphView.reduceMotion
        )
        PanelDebug.note("glyph", [
            "glyphState": String(describing: flow.glyphState),
            "effect": String(describing: effect),
        ])
        glyphView.apply(effect)
    }

    private func beginScan() {
        guard let attempt else {
            PanelDebug.note("begin-scan-skipped", ["reason": "no presence attempt"])
            return
        }
        PanelDebug.note("evaluatePolicy-invoked", [
            "mode": String(describing: attempt.mode),
            "contextInstance": String(UInt(bitPattern: ObjectIdentifier(attempt.context).hashValue), radix: 16),
            "reason": presenceReason,
        ])
        let generation = attemptGeneration
        attempt.evaluate(reason: presenceReason) { [weak self] result in
            switch result {
            case .success:
                PanelDebug.note("evaluatePolicy-completed", ["success": true])
            case .failure(let error):
                PanelDebug.note("evaluatePolicy-completed", [
                    "success": false,
                    "error": error.localizedDescription,
                ])
            }
            guard let self, self.modalRunning, generation == self.attemptGeneration else {
                if case .success(let proof) = result { proof.context.invalidate() }
                return
            }
            switch result {
            case .success(let proof):
                self.proof = proof
                // Read the controls now, not when the panel opened: nothing was
                // modal over them, so what is selected at this instant is what the
                // user meant to approve.
                self.syncSelectionIntoFlow()
                self.perform(effect: self.flow.apply(.scanSucceeded))
            case .failure(let error):
                // Not a refusal, and never re-armed on its own: the panel goes
                // back to resting, and only a click asks the system again.
                let failure = error as? IdentitySessionManager.PresenceFailure
                self.lastFailure = failure?.kind ?? .failed
                if failure?.kind == .wantsPassword {
                    // The user asked for the password from inside the sheet.
                    // Move the panel onto that path, but do not present anything:
                    // the next sheet is the one they click for.
                    self.switchToPassword(present: false)
                }
                self.perform(effect: self.flow.apply(.scanFailed))
            }
        }
    }

    /// What the panel says after a check ended without an answer.
    ///
    /// Dismissing the sheet is the common one and is not a failure of anything:
    /// it says so plainly and points at the button, because that button is the
    /// only thing that will ask again.
    private func failureHint() -> String {
        guard flow.failedScans > 0 else { return "" }
        let button = scanButton?.isHidden == false ? "Approve with Touch ID" : (confirmButton?.title ?? "Approve")
        // Once the approval has moved onto the password there is no scan to talk
        // about, and a hint about Touch ID would be describing a control that is
        // no longer on the panel.
        let onPassword = flow.presenceMode != .embedded
        switch lastFailure {
        case .cancelled:
            return onPassword
                ? "Password canceled. Click \(button) to try again, or Deny to refuse."
                : "Touch ID canceled. Click \(button) to scan again, or Deny to refuse."
        case .wantsPassword:
            return "Click \(button) to enter your password, or Deny to refuse."
        case .failed:
            return flow.failedScans > 1
                ? "Still not verified. Adjust how long to allow if you want, then click \(button), or Deny to refuse."
                : "Not verified. Click \(button) to try again, or Deny to refuse."
        }
    }

    private func setStatus(_ text: String) {
        statusLabel?.stringValue = text
        statusLabel?.isHidden = text.isEmpty
        relayout()
    }

    // MARK: - Controls

    @objc private func confirmPressed(_ sender: Any) {
        syncSelectionIntoFlow()
        perform(effect: flow.apply(.confirmPressed))
    }

    @objc private func denyPressed(_ sender: Any) {
        perform(effect: flow.apply(.cancelPressed))
    }

    /// The way out for a finger the sensor will not read.
    ///
    /// Not a second panel and not a second question: the same approval, checked
    /// the other way. One click gets a password field, with no fingerprint asked
    /// for on the way there; how that is arranged is `passwordFallback`'s note.
    /// The biometric attempt is dropped first so the machine is never listening
    /// on two contexts at once, and the callback from the one we walked away from
    /// is ignored by generation.
    @objc private func usePasswordPressed(_ sender: Any) {
        // A click on the link is an invitation, so this one does present.
        switchToPassword(present: true)
    }

    /// Move this approval onto the device-password check.
    ///
    /// `present` says whether to raise the system sheet now. It is only ever true
    /// for a click: the panel does not put a sheet on screen that nobody asked
    /// for, however the biometric check ended.
    private func switchToPassword(present: Bool) {
        guard let fallback = attempt?.passwordFallback() else {
            if present { setStatus("This Mac has no password check available.") }
            return
        }
        PanelDebug.note("switch-to-password", ["present": present])
        attemptGeneration += 1
        attempt?.context.invalidate()
        attempt = fallback

        let scope = flow.scope
        let durationMs = flow.durationMs
        flow = ApprovalFlow(defaultScope: scope, presenceMode: .systemDialog)
        flow.select(scope: scope, durationMs: durationMs)

        // The scan control goes with the scan: leaving Apple's sensor on screen
        // while a password is being asked for would invite a finger that nothing
        // is listening for. The plain button was built for this moment.
        scanButton?.isHidden = true
        confirmButton?.isHidden = false
        confirmButton?.title = "Approve with password"
        confirmButton?.glyphView?.isHidden = true
        passwordLink?.isHidden = true
        hintLabel?.stringValue = ""
        relayout()
        guard present else {
            perform(effect: .showControls)
            return
        }
        perform(effect: flow.apply(.confirmPressed))
    }

    private func scopeChanged(_ index: Int) {
        syncSelectionIntoFlow()
        // The duration segment's label changes with what was picked, so the
        // control can want a different width. Re-fit rather than clip.
        relayout()
    }

    /// Offer the windows. Called when the duration segment is chosen and again
    /// whenever it is clicked, so changing your mind costs one click.
    ///
    /// A menu that cannot be drawn must not leave the control dead: the fallback
    /// steps to the next window, which keeps every option reachable by clicking.
    private func showDurationMenu(from view: NSView) {
        let menu = NSMenu()
        for preset in DurationPreset.allCases {
            let item = NSMenuItem(
                title: "For \(preset.label)",
                action: #selector(durationChosen(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = NSNumber(value: preset.milliseconds)
            item.state = preset == duration ? .on : .off
            menu.addItem(item)
        }
        let shown = menu.popUp(
            positioning: menu.items.first { ($0.representedObject as? NSNumber)?.int64Value == duration.milliseconds },
            at: NSPoint(x: 0, y: view.bounds.height + 4),
            in: view
        )
        if !shown { apply(duration: duration.next) }
    }

    @objc private func durationChosen(_ sender: NSMenuItem) {
        guard let ms = (sender.representedObject as? NSNumber)?.int64Value,
              let preset = DurationPreset(rawValue: ms) else { return }
        apply(duration: preset)
    }

    /// Take a chosen window: say it on the segment, and put it in the answer.
    private func apply(duration preset: DurationPreset) {
        duration = preset
        if let index = scopes.firstIndex(of: .duration) {
            scopeControl?.setTitle(scopeLabel(.duration, chosen: true), at: index)
            scopeControl?.select(index: index, notify: false)
        }
        syncSelectionIntoFlow()
        relayout()
        PanelDebug.note("duration-chosen", ["ms": Int(preset.milliseconds), "label": preset.label])
    }

    /// Copy the controls' current state into the flow, so what a scan approves is
    /// what the panel is showing.
    private func syncSelectionIntoFlow() {
        let scope = selectedScope(fallback: flow.scope)
        flow.select(scope: scope, durationMs: scope == .duration ? duration.milliseconds : nil)
    }

    private func selectedScope(fallback: SessionGrantScope) -> SessionGrantScope {
        guard let index = scopeControl?.selectedIndex, index >= 0, index < scopes.count else {
            return fallback
        }
        return scopes[index]
    }

    /// Re-fit the window after something opened or closed. The panel grows and
    /// shrinks with its disclosures rather than scrolling, so the window has to
    /// follow its content.
    private func relayout() {
        guard let window, let contentColumn else { return }
        contentColumn.layoutSubtreeIfNeeded()
        let height = contentColumn.fittingSize.height + PanelStyle.contentInset * 2
        let width = PanelStyle.contentWidth + PanelStyle.contentInset * 2
        var frame = window.frame
        let topEdge = frame.maxY
        frame.size = window.frameRect(forContentRect: NSRect(x: 0, y: 0, width: width, height: height)).size
        // Grow downward from where the panel already is, so an expanding row does
        // not move the buttons out from under the pointer.
        frame.origin.y = topEdge - frame.height
        // Unless growing downward would push it off the screen, in which case it
        // climbs instead: the top of the panel is the part that has to stay.
        if let visible = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame {
            let lowest = visible.minY + Self.screenMargin
            if frame.origin.y < lowest {
                frame.origin.y = min(lowest, visible.maxY - Self.screenMargin - frame.height)
            }
        }
        window.setFrame(frame, display: true, animate: false)
    }

    // MARK: - Building the view

    private func buildWindow(
        content: PanelContent,
        mode: ApprovalPresenceMode,
        expandChain: Bool = false
    ) -> ApprovalPanelWindow {
        let column = PanelStyle.column(spacing: 0)
        column.translatesAutoresizingMaskIntoConstraints = false
        contentColumn = column

        column.addArrangedSubview(topBar(content))
        column.setCustomSpacing(14, after: column.arrangedSubviews.last!)

        let hero = PanelStyle.heading(content.titleSegments, size: 17)
        column.addArrangedSubview(centred(hero))
        if let subtitle = content.subtitle {
            let sub = PanelStyle.label(subtitle, size: 12, color: PanelStyle.inkSecondary)
            sub.alignment = .center
            column.setCustomSpacing(3, after: hero.superview ?? hero)
            column.addArrangedSubview(centred(sub))
        }

        if !content.keyRows.isEmpty {
            let box = PanelKeyBoxView(rows: content.keyRows) { [weak self] in self?.relayout() }
            box.translatesAutoresizingMaskIntoConstraints = false
            column.setCustomSpacing(13, after: column.arrangedSubviews.last!)
            column.addArrangedSubview(box)
            box.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth).isActive = true
        }

        for note in content.notes {
            let label = PanelStyle.label(note, size: 11, color: PanelStyle.inkTertiary)
            label.lineBreakMode = .byWordWrapping
            label.maximumNumberOfLines = 3
            label.preferredMaxLayoutWidth = PanelStyle.contentWidth
            column.setCustomSpacing(8, after: column.arrangedSubviews.last!)
            column.addArrangedSubview(label)
        }

        let chain = PanelChainView(
            chain: content.requester.chain ?? .empty,
            fallbackSummary: content.requester.summary,
            invocationMode: content.invocationMode,
            startExpanded: expandChain
        ) { [weak self] in self?.relayout() }
        chain.translatesAutoresizingMaskIntoConstraints = false
        column.setCustomSpacing(14, after: column.arrangedSubviews.last!)
        column.addArrangedSubview(chain)
        chain.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth).isActive = true

        if content.scopes.count > 1 {
            let control = PanelSegmentedControl(
                labels: content.scopes.map { scopeLabel($0, chosen: $0 == content.defaultScope) },
                selectedIndex: content.scopes.firstIndex(of: content.defaultScope) ?? 0,
                onChange: { [weak self] index in
                    self?.scopeChanged(index)
                    guard let self, index < self.scopes.count, self.scopes[index] == .duration else { return }
                    // Choosing "for a set time" is only half an answer, so the
                    // windows are offered straight away.
                    if let view = self.scopeControl?.view(at: index) { self.showDurationMenu(from: view) }
                },
                onReselect: { [weak self] index, view in
                    guard let self, index < self.scopes.count, self.scopes[index] == .duration else { return }
                    self.showDurationMenu(from: view)
                }
            )
            scopeControl = control
            column.setCustomSpacing(15, after: column.arrangedSubviews.last!)
            column.addArrangedSubview(centred(control))
        } else if let only = content.scopes.first {
            let label = PanelStyle.label(
                "Allowed for: \(PanelContent.scopeLabel(only).lowercased())",
                size: 11.5,
                color: PanelStyle.inkTertiary
            )
            label.alignment = .center
            column.setCustomSpacing(15, after: column.arrangedSubviews.last!)
            column.addArrangedSubview(centred(label))
        }

        // Says what happened when a check did not complete. Hidden until there is
        // something to say, so the common one-gesture case stays quiet.
        let status = PanelStyle.label("", size: 11, color: PanelStyle.inkSecondary)
        status.lineBreakMode = .byWordWrapping
        status.maximumNumberOfLines = 3
        status.preferredMaxLayoutWidth = PanelStyle.contentWidth
        status.isHidden = true
        statusLabel = status
        column.setCustomSpacing(10, after: column.arrangedSubviews.last!)
        column.addArrangedSubview(status)

        column.setCustomSpacing(14, after: column.arrangedSubviews.last!)
        column.addArrangedSubview(actionRow(content: content, mode: mode))
        column.setCustomSpacing(9, after: column.arrangedSubviews.last!)
        column.addArrangedSubview(underActions(mode: mode))

        let contentView = NSView()
        contentView.wantsLayer = true
        contentView.layer?.backgroundColor = PanelStyle.panelBackground.cgColor
        contentView.addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: PanelStyle.contentInset),
            column.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -PanelStyle.contentInset),
            column.topAnchor.constraint(equalTo: contentView.topAnchor, constant: PanelStyle.contentInset),
            column.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -PanelStyle.contentInset),
            column.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth),
        ])
        contentView.layoutSubtreeIfNeeded()

        let window = ApprovalPanelWindow(
            contentRect: NSRect(
                x: 0,
                y: 0,
                width: PanelStyle.contentWidth + PanelStyle.contentInset * 2,
                height: contentView.fittingSize.height
            ),
            styleMask: [.titled, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.standardWindowButton(.closeButton)?.isHidden = true
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true
        window.backgroundColor = PanelStyle.panelBackground
        // Committed dark chrome: the panel looks the same whatever the user's
        // theme, so it is recognisable as varlock asking rather than as whatever
        // window happened to be in front.
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = contentView
        window.title = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Varlock"
        window.onCancel = { [weak self] in self?.denyPressed(self as Any) }
        window.onConfirm = { [weak self] in
            guard let self, self.confirmButton?.isEnabled == true else { return }
            self.confirmPressed(self)
        }
        return window
    }

    private func topBar(_ content: PanelContent) -> NSView {
        let row = PanelStyle.row(spacing: 7)
        row.addArrangedSubview(logoMark())
        row.addArrangedSubview(PanelStyle.label(
            "varlock",
            size: 12,
            color: PanelStyle.wordmark,
            weight: .semibold
        ))
        row.addArrangedSubview(PanelStyle.spacer())
        if let fact = content.factLine {
            row.addArrangedSubview(PanelStyle.label(fact, size: 11, color: PanelStyle.inkQuiet))
        }
        return fullWidth(row)
    }

    /// varlock's own mark. Says who is asking before a single word is read,
    /// which is the one job the top bar has, so it is the real app icon rather
    /// than something that merely looks like a lock.
    private func logoMark() -> NSView {
        return PanelIconView(
            side: 20,
            placeholder: NSImage(systemSymbolName: "lock.fill", accessibilityDescription: "varlock")
        ) {
            PanelIcons.varlockMark()
        }
    }

    private func actionRow(content: PanelContent, mode: ApprovalPresenceMode) -> NSView {
        let row = PanelStyle.row(spacing: 10)
        let deny = PanelButton(
            title: content.cancelButtonTitle,
            style: .deny,
            glyph: .stop,
            target: self,
            action: #selector(denyPressed(_:))
        )
        deny.setContentHuggingPriority(.required, for: .horizontal)
        row.addArrangedSubview(deny)

        // On a machine that can scan, the primary IS the sensor: one control that
        // reads as the button and answers to a finger. The plain button is built
        // alongside it and kept hidden, because the password fallback needs
        // something to become, and rebuilding the row mid-approval would move the
        // panel under the pointer.
        if mode == .embedded {
            let scanButton = PanelScanButton(
                title: confirmTitle(content: content, mode: mode),
                context: attempt?.context
            ) { [weak self] in
                guard let self else { return }
                self.confirmPressed(self)
            }
            self.scanButton = scanButton
            // Only the real thing is worth photographing: a stand-in glyph would
            // sail through the check that exists to catch a blank sensor.
            if attempt != nil { embeddedScanView = scanButton.scanView }
            scanButton.setContentHuggingPriority(.init(1), for: .horizontal)
            row.addArrangedSubview(scanButton)
        }

        let confirm = PanelButton(
            title: mode == .embedded ? "Approve with password" : confirmTitle(content: content, mode: mode),
            style: .primary,
            glyph: mode == .embedded ? .lock : primaryGlyph(mode: mode),
            target: self,
            action: #selector(confirmPressed(_:))
        )
        confirmButton = confirm
        confirm.isHidden = scanButton != nil
        row.addArrangedSubview(confirm)
        // The approve action is the wide one: the panel has an obvious yes and a
        // quiet no, not two equal buttons.
        confirm.setContentHuggingPriority(.init(1), for: .horizontal)
        return fullWidth(row)
    }

    /// What sits on the left of the approve button.
    ///
    /// On the embedded path it is the system's own scan surface rather than a
    /// picture of one: the thing that reads the finger, in the place the design
    /// always had a fingerprint. A preview has no run loop and no sensor, so it
    /// gets the drawn glyph as a stand-in for where the live view goes.
    private func primaryGlyph(mode: ApprovalPresenceMode) -> PanelButton.PanelButtonGlyph {
        switch mode {
        // The fingerprint on this path is the system's own view, standing above
        // the buttons (or its stand-in, in a preview). A second one drawn on the
        // button would be two sensors on a machine with one.
        case .embedded: return .none
        case .systemDialog: return .lock
        case .none: return .none
        }
    }

    private func confirmTitle(content: PanelContent, mode: ApprovalPresenceMode) -> String {
        switch mode {
        case .embedded: return "Approve with Touch ID"
        case .systemDialog: return "Approve with password"
        case .none: return content.confirmButtonTitle
        }
    }

    private func underActions(mode: ApprovalPresenceMode) -> NSView {
        let row = PanelStyle.row(spacing: 8)
        let hint: String
        switch mode {
        case .embedded: hint = "Scanning approves without clicking"
        case .systemDialog: hint = "No Touch ID available on this Mac"
        case .none: hint = ""
        }
        let hintLabel = PanelStyle.label(hint, size: 11, color: PanelStyle.inkQuiet)
        self.hintLabel = hintLabel
        row.addArrangedSubview(hintLabel)
        row.addArrangedSubview(PanelStyle.spacer())

        // Offered only where there is something to fall back FROM. On a machine
        // with no sensor the password path is already the primary action, and a
        // link to it would be the same button twice.
        if mode == .embedded {
            let link = PanelButton(
                title: "Use password\u{2026}",
                style: .link,
                target: self,
                action: #selector(usePasswordPressed(_:))
            )
            passwordLink = link
            row.addArrangedSubview(link)
        }
        return fullWidth(row)
    }

    /// "For a set time" until a window has actually been picked, and the window
    /// itself afterwards: the segment says what was chosen, not what could be.
    private func scopeLabel(_ scope: SessionGrantScope, chosen: Bool) -> String {
        guard scope == .duration, chosen else { return PanelContent.scopeLabel(scope) }
        return "For \(duration.label) \u{25BE}"
    }

    /// Wrap a view so it fills the panel's width inside the vertical stack.
    private func fullWidth(_ view: NSView) -> NSView {
        let box = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: box.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            view.topAnchor.constraint(equalTo: box.topAnchor),
            view.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            box.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth),
        ])
        return box
    }

    private func centred(_ view: NSView) -> NSView {
        let box = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(view)
        NSLayoutConstraint.activate([
            view.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            view.leadingAnchor.constraint(greaterThanOrEqualTo: box.leadingAnchor),
            view.trailingAnchor.constraint(lessThanOrEqualTo: box.trailingAnchor),
            view.topAnchor.constraint(equalTo: box.topAnchor),
            view.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            box.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth),
        ])
        return box
    }
}

/// The panel's window.
///
/// A borderless-looking panel that can still take key events, so Escape refuses
/// and Return approves without either being a button the design has to find room
/// for.
final class ApprovalPanelWindow: NSPanel {
    var onCancel: (() -> Void)?
    var onConfirm: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 53: // escape
            onCancel?()
        case 36, 76: // return, enter
            onConfirm?()
        default:
            super.keyDown(with: event)
        }
    }
}
