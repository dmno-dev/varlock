import AppKit
import LocalAuthentication
import LocalAuthenticationEmbeddedUI
import IdentitySessions

/// The panel the daemon draws when someone has to say yes.
///
/// The panel is the card that says who is asking, what they get, and for how long,
/// and it arms the presence check the moment it opens. The scan IS the approval:
/// there is no separate confirm gesture in the common case.
///
/// Where the prompt is drawn is up to the system, and is not something the panel
/// can rely on. It binds an `LAAuthenticationView` to the context, which is
/// supposed to render the prompt inline, but macOS has been observed presenting
/// its own standard alert instead while that view stayed blank, and there is no
/// reliable signal for which will happen (see `EmbeddedUnlockProbe`). So the panel
/// draws its own affordance underneath and reads correctly either way: as a
/// self-contained prompt when the inline view renders, and as the details card
/// beside the system's alert when it does not.
///
/// The panel stays interactive while the check is armed, which is why the answer
/// takes whatever scope is selected at the moment the finger lands.
///
/// This file is view only. What the panel says, which scopes it may offer, and what
/// a given answer means are decided in `IdentitySessions` (`UnlockDecision.swift`,
/// `PanelContent.swift`, `ApprovalFlow.swift`), so the rules stay testable without a
/// window server.
///
/// It is drawn by the daemon on purpose. The daemon is the process that holds the
/// keys and the one that verified the peer, so it is the only party in a position
/// to say truthfully who is asking. A panel drawn by the caller would be a panel
/// the caller can lie on.
final class ApprovalPanel: NSObject {
    /// How long the whole interaction may take before it counts as a refusal.
    /// Below the client's 5 minute interactive timeout, so the caller gets a real
    /// answer rather than a dead socket.
    static let timeoutSeconds: TimeInterval = 120

    /// Ends the modal when the flow produced an answer, rather than when AppKit's
    /// own button handling did.
    private static let flowFinishedResponse = NSApplication.ModalResponse(rawValue: 9001)

    private static let contentWidth: CGFloat = 420

    /// What the panel answered, and the presence check that answered it.
    struct Outcome {
        let decision: PanelDecision
        /// Present only when a presence check approved this. Handing this exact
        /// context to the enclave is what keeps one scan covering the whole unlock.
        let proof: IdentitySessionManager.PresenceProof?
    }

    private var scopeControl: NSSegmentedControl?
    private var durationPopUp: NSPopUpButton?
    private var confirmButton: NSButton?
    private var retryButton: NSButton?
    private var statusLabel: NSTextField?
    private var detailsStack: NSStackView?
    private var disclosureButton: NSButton?
    private var accessoryContainer: NSView?
    private weak var alert: NSAlert?

    private var scopes: [SessionGrantScope] = []
    private var timedOut = false
    private var flow: ApprovalFlow!
    private var attempt: IdentitySessionManager.PresenceAttempt?
    private var presenceReason = ""
    private var proof: IdentitySessionManager.PresenceProof?
    /// Guards against a presence callback arriving after the modal has ended.
    private var modalRunning = false

    /// Show a panel and wait for the answer.
    ///
    /// Returns nil when the panel could not be drawn at all, which the caller
    /// reports as `NO_UI`. A refusal comes back as a decision with `approved`
    /// false, so callers can tell "the user said no" from "nobody could be asked".
    ///
    /// With an `attempt`, the panel carries a presence check: embedded (armed as
    /// the panel opens, the scan is the answer) or the system dialog fallback
    /// (raised by the confirm button). Without one it is a plain button panel.
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
            // The IPC handler is on a background queue, so the panel is drawn from
            // inside a main-queue work item. Everything the panel schedules has to
            // survive that; see `MainLoop`.
            DispatchQueue.main.sync { work() }
        }
        PanelDebug.note("present-returned", ["approved": outcome?.decision.approved ?? false])
        return outcome
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

        let alert = NSAlert()
        self.alert = alert
        alert.messageText = content.title
        alert.informativeText = content.subtitle ?? ""
        alert.alertStyle = .informational

        // With the prompt embedded, scanning is the action and Cancel is the only
        // button worth showing. The other two modes keep the confirm button, which
        // is what raises the system dialog (or answers outright when there is no
        // presence check at all).
        if mode != .embedded {
            alert.addButton(withTitle: content.confirmButtonTitle)
        }
        alert.addButton(withTitle: content.cancelButtonTitle)
        alert.accessoryView = buildAccessoryView(content: content, mode: mode)

        if mode != .embedded {
            confirmButton = alert.buttons.first
            confirmButton?.target = self
            confirmButton?.action = #selector(confirmPressed(_:))
        }

        let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Varlock"
        alert.window.title = appName

        // Float above whatever the user was looking at, and take focus, so an
        // approval never ends up hidden behind an editor window.
        alert.window.level = .floating
        NSApp.activate(ignoringOtherApps: true)
        alert.layout()
        PanelDebug.note("panel-shown", [
            "isVisible": alert.window.isVisible,
            "isKeyWindow": alert.window.isKeyWindow,
            "appIsActive": NSApp.isActive,
            "occlusion": alert.window.occlusionState.contains(.visible) ? "visible" : "occluded",
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
            self.perform(effect: self.flow.start())
        }

        let heartbeat = PanelDebug.isEnabled ? MainLoop.every(2) { [weak self] in
            guard let self else { return }
            PanelDebug.note("heartbeat", [
                "state": String(describing: self.flow.state),
                "isKeyWindow": alert.window.isKeyWindow,
                "isVisible": alert.window.isVisible,
                "appIsActive": NSApp.isActive,
                "authAgentWindows": EmbeddedUnlockProbe.authAgentWindowOwners().joined(separator: ","),
            ])
        } : nil

        _ = alert.runModal()
        modalRunning = false
        deadline.cancel()
        heartbeat?.cancel()

        // The flow is the authority on what was answered, not the button code:
        // Cancel is the first button in embedded mode and the second otherwise.
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

    /// Take the front, so the panel is what the user sees.
    ///
    /// Called once the modal is running, and again whenever a presence check ends
    /// without an answer: the system's own alert steals focus while it is up, and
    /// when it goes away the panel underneath has to come back rather than sit
    /// behind whatever was in front before.
    private func bringToFront() {
        guard let window = alert?.window else { return }
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
        switch effect {
        case .beginScan:
            retryButton?.isHidden = true
            setStatus(flow.presenceMode == .embedded
                ? "Touch the sensor to approve."
                : "Waiting for your password.")
            confirmButton?.isEnabled = false
            beginScan()
        case .showControls:
            confirmButton?.isEnabled = true
            if flow.presenceMode == .embedded { retryButton?.isHidden = false }
            setStatus(failureHint())
            // A check that just ended may have had a system alert over us.
            if flow.failedScans > 0 { bringToFront() }
        case .finish(let decision):
            NSApp.stopModal(withCode: decision.approved
                ? Self.flowFinishedResponse
                : .alertSecondButtonReturn)
        }
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
            guard let self, self.modalRunning else {
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
            case .failure:
                // Not a refusal. Leave the panel up with a way to try again.
                self.perform(effect: self.flow.apply(.scanFailed))
            }
        }
    }

    private func failureHint() -> String {
        guard flow.failedScans > 0 else { return "" }
        if flow.presenceMode == .embedded {
            return flow.failedScans > 1
                ? "Still not verified. Adjust how long to allow if you want, then try again, or Cancel to refuse."
                : "Not verified. Try again, or Cancel to refuse."
        }
        return "Not verified. Press \(confirmButton?.title ?? "the button") to try again, or Cancel to refuse."
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

    @objc private func retryPressed(_ sender: Any) {
        syncSelectionIntoFlow()
        perform(effect: flow.apply(.confirmPressed))
    }

    @objc private func scopeChanged(_ sender: NSSegmentedControl) {
        durationPopUp?.isEnabled = selectedScope(fallback: .once) == .duration
        syncSelectionIntoFlow()
    }

    @objc private func durationChanged(_ sender: NSPopUpButton) {
        syncSelectionIntoFlow()
    }

    @objc private func disclosureToggled(_ sender: NSButton) {
        detailsStack?.isHidden = sender.state != .on
        relayout()
    }

    /// Copy the controls' current state into the flow, so what a scan approves is
    /// what the panel is showing.
    private func syncSelectionIntoFlow() {
        let scope = selectedScope(fallback: flow.scope)
        flow.select(scope: scope, durationMs: scope == .duration ? selectedDurationMs() : nil)
    }

    private func selectedScope(fallback: SessionGrantScope) -> SessionGrantScope {
        guard let index = scopeControl?.selectedSegment, index >= 0, index < scopes.count else {
            return fallback
        }
        return scopes[index]
    }

    private func selectedDurationMs() -> Int64 {
        guard let index = durationPopUp?.indexOfSelectedItem,
              index >= 0, index < DurationPreset.allCases.count else {
            return DurationPreset.default.milliseconds
        }
        return DurationPreset.allCases[index].milliseconds
    }

    /// Re-fit the accessory view after something appeared or disappeared. NSAlert
    /// sizes an accessory view once, by its frame, so a disclosure that changes
    /// height has to ask for the window to be laid out again.
    private func relayout() {
        guard let accessoryContainer, let alert else { return }
        accessoryContainer.layoutSubtreeIfNeeded()
        accessoryContainer.frame = NSRect(origin: .zero, size: accessoryContainer.fittingSize)
        alert.layout()
    }

    // MARK: - Building the view

    private func buildAccessoryView(content: PanelContent, mode: ApprovalPresenceMode) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false

        // Who is asking: one derived line at rest.
        if !content.requester.summary.isEmpty {
            stack.addArrangedSubview(label(content.requester.summary, size: NSFont.systemFontSize, color: .labelColor))
        }

        // What the approval covers.
        for group in content.itemGroups {
            let box = NSStackView()
            box.orientation = .vertical
            box.alignment = .leading
            box.spacing = 2
            if let heading = group.heading {
                box.addArrangedSubview(label(heading, size: NSFont.smallSystemFontSize, color: .secondaryLabelColor))
            }
            for item in group.items {
                box.addArrangedSubview(itemRow(item))
            }
            stack.addArrangedSubview(box)
        }

        // Scope choice.
        if content.scopes.count > 1 {
            stack.addArrangedSubview(label("Allow for", size: NSFont.smallSystemFontSize, color: .secondaryLabelColor))
            let segmented = NSSegmentedControl(
                labels: content.scopes.map { PanelContent.scopeLabel($0) },
                trackingMode: .selectOne,
                target: self,
                action: #selector(scopeChanged(_:))
            )
            segmented.selectedSegment = content.scopes.firstIndex(of: content.defaultScope) ?? 0
            scopeControl = segmented
            stack.addArrangedSubview(segmented)

            if content.scopes.contains(.duration) {
                let popUp = NSPopUpButton(frame: .zero, pullsDown: false)
                popUp.addItems(withTitles: DurationPreset.allCases.map { $0.label })
                popUp.selectItem(at: DurationPreset.allCases.firstIndex(of: .default) ?? 0)
                popUp.isEnabled = content.defaultScope == .duration
                popUp.target = self
                popUp.action = #selector(durationChanged(_:))
                durationPopUp = popUp
                stack.addArrangedSubview(popUp)
            }
        } else if let only = content.scopes.first {
            stack.addArrangedSubview(label(
                "Allowed for: \(PanelContent.scopeLabel(only).lowercased())",
                size: NSFont.smallSystemFontSize,
                color: .secondaryLabelColor
            ))
        }

        // The scan affordance, bound to the context this unlock will run under.
        if mode == .embedded, let context = attempt?.context {
            stack.addArrangedSubview(embeddedScanRow(context: context))
        }

        // Says what happened when a check did not complete. Hidden until there is
        // something to say, so the common one-gesture case stays quiet.
        let status = label("", size: NSFont.smallSystemFontSize, color: .secondaryLabelColor)
        status.lineBreakMode = .byWordWrapping
        status.isHidden = true
        statusLabel = status
        stack.addArrangedSubview(status)

        // The evidence, one click away rather than in the way.
        if content.requester.hasDetails {
            let disclosure = NSButton()
            disclosure.bezelStyle = .disclosure
            disclosure.setButtonType(.onOff)
            disclosure.title = ""
            disclosure.state = .off
            disclosure.target = self
            disclosure.action = #selector(disclosureToggled(_:))
            disclosureButton = disclosure

            let row = NSStackView()
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = 4
            row.addArrangedSubview(disclosure)
            row.addArrangedSubview(label("Details", size: NSFont.smallSystemFontSize, color: .secondaryLabelColor))
            stack.addArrangedSubview(row)

            let details = NSStackView()
            details.orientation = .vertical
            details.alignment = .leading
            details.spacing = 2
            for line in content.requester.details {
                details.addArrangedSubview(label(
                    line.text,
                    size: NSFont.smallSystemFontSize,
                    color: line.isDerived ? .labelColor : .secondaryLabelColor
                ))
            }
            details.isHidden = true
            detailsStack = details
            stack.addArrangedSubview(details)
        }

        let container = NSView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            container.widthAnchor.constraint(equalToConstant: Self.contentWidth),
        ])
        container.layoutSubtreeIfNeeded()
        // NSAlert positions an accessory view by its frame, so hand it a concrete
        // size once auto layout has worked one out.
        container.frame = NSRect(origin: .zero, size: container.fittingSize)
        accessoryContainer = container
        return container
    }

    /// The scan affordance.
    ///
    /// We draw our own glyph, always. `LAAuthenticationView` is supposed to render
    /// the prompt inline, but in the field it has come up blank while the system
    /// presented its standard alert separately instead, and there is no reliable
    /// way to detect which of the two is about to happen (see the note in
    /// `EmbeddedUnlockProbe`). A panel that assumed inline rendering showed an
    /// empty square and no indication that anything wanted a fingerprint.
    ///
    /// So the system's view is layered directly on top of ours: if it does render,
    /// it covers ours and the user gets Apple's own animation; if it stays blank,
    /// ours shows through and the panel still says what it wants. Either way there
    /// is never an empty area, and the wording avoids claiming where the prompt
    /// will appear.
    private func embeddedScanRow(context: LAContext) -> NSView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8

        let glyphSide: CGFloat = 30
        let holder = NSView()
        holder.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            holder.widthAnchor.constraint(equalToConstant: glyphSide),
            holder.heightAnchor.constraint(equalToConstant: glyphSide),
        ])

        let ownGlyph = NSImageView()
        ownGlyph.translatesAutoresizingMaskIntoConstraints = false
        ownGlyph.image = NSImage(systemSymbolName: "touchid", accessibilityDescription: "Touch ID")
        ownGlyph.symbolConfiguration = NSImage.SymbolConfiguration(
            pointSize: glyphSide - 4,
            weight: .regular
        )
        ownGlyph.contentTintColor = .controlAccentColor
        ownGlyph.imageScaling = .scaleProportionallyUpOrDown
        holder.addSubview(ownGlyph)

        let authView = LAAuthenticationView(context: context, controlSize: .regular)
        authView.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(authView)

        NSLayoutConstraint.activate([
            ownGlyph.leadingAnchor.constraint(equalTo: holder.leadingAnchor),
            ownGlyph.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
            ownGlyph.topAnchor.constraint(equalTo: holder.topAnchor),
            ownGlyph.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            // Same box, drawn after, so a rendering system view wins and a blank
            // one leaves ours visible underneath.
            authView.leadingAnchor.constraint(equalTo: holder.leadingAnchor),
            authView.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
            authView.topAnchor.constraint(equalTo: holder.topAnchor),
            authView.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
        ])

        row.addArrangedSubview(holder)
        row.addArrangedSubview(label("Touch ID to approve", size: NSFont.systemFontSize, color: .labelColor))

        // Only shown once a scan has failed, so the resting panel is just the
        // prompt and Cancel.
        let retry = NSButton(title: "Try again", target: self, action: #selector(retryPressed(_:)))
        retry.bezelStyle = .rounded
        retry.controlSize = .small
        retry.isHidden = true
        retryButton = retry
        row.addArrangedSubview(retry)

        return row
    }

    private func itemRow(_ item: PanelItem) -> NSView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = 8

        let name = label(item.label, size: NSFont.systemFontSize, color: .labelColor)
        name.font = NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        row.addArrangedSubview(name)

        if let detail = item.detail {
            row.addArrangedSubview(label(detail, size: NSFont.smallSystemFontSize, color: .secondaryLabelColor))
        }
        return row
    }

    private func label(_ text: String, size: CGFloat, color: NSColor) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = NSFont.systemFont(ofSize: size)
        field.textColor = color
        field.lineBreakMode = .byTruncatingMiddle
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }
}
