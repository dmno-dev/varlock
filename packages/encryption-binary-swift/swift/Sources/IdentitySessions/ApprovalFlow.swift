import Foundation

/// How an approval reaches a yes.
///
/// The panel and the Touch ID prompt are one window, not two. An
/// `LAAuthenticationView` is armed as the panel opens, so the scan happens inside
/// the same window that says who is asking and what they get. The scan IS the
/// approval: there is no separate confirm gesture in the common case, and no
/// system dialog appears at all.
///
/// Because nothing is modal over the panel, the scope controls stay live the whole
/// time the prompt is armed. So the answer takes whatever is selected at the moment
/// the finger lands, not whatever was selected when the panel opened. A user who
/// picks "Once" and then scans gets Once.
///
/// Cancel on the panel is the only refusal. A scan that fails is not one: it leaves
/// the panel exactly as it was, with a line explaining what happened and the button
/// re-enabled to arm the prompt again. Nothing re-arms on its own, so a failing
/// sensor cannot turn into a loop, and a refusal is always something the user
/// actually pressed.
///
/// This type holds all of that with no AppKit in sight, so the transitions can be
/// tested without a window server or an enclave.

/// What kind of user-presence check this approval carries.
public enum ApprovalPresenceMode: Equatable {
    /// No check at all: an ungated custody key, or a `request-approval` that did
    /// not ask for a biometric. The confirm button is the answer.
    case none
    /// The inline affordance, armed as the panel opens. The scan is the answer.
    case embedded
    /// The standard system dialog, raised by the confirm button. Used when
    /// biometrics are unavailable or locked out, so the panel keeps working with
    /// the device password.
    case systemDialog
}

public enum ApprovalFlowState: Equatable {
    /// A presence check is in flight. For `embedded` the prompt is live in the
    /// panel; for `systemDialog` the system's own window is up.
    case scanning
    /// Waiting on the panel's buttons.
    case awaitingInput
    case finished(PanelDecision)
}

public enum ApprovalFlowEvent: Equatable {
    /// The user authenticated.
    case scanSucceeded
    /// The check did not complete. Not a refusal.
    case scanFailed
    /// The panel's confirm button: the answer itself when there is no presence
    /// check, and otherwise "arm the prompt again".
    case confirmPressed
    /// The panel's Cancel button. The only refusal the user can express.
    case cancelPressed
    /// The whole interaction ran out of time.
    case timedOut
}

public enum ApprovalFlowEffect: Equatable {
    /// Arm the presence check (embedded prompt, or the system dialog).
    case beginScan
    /// Leave the panel waiting on its buttons.
    case showControls
    /// Close the panel with this answer.
    case finish(PanelDecision)
}

public struct ApprovalFlow {
    public let presenceMode: ApprovalPresenceMode

    public private(set) var state: ApprovalFlowState
    /// What an approval right now would carry. Kept current with the controls, so
    /// a scan takes what is on screen when the finger lands.
    public private(set) var scope: SessionGrantScope
    public private(set) var durationMs: Int64?
    /// How many presence checks have failed. Reported so the panel can say
    /// something more useful the second time around.
    public private(set) var failedScans = 0

    public init(defaultScope: SessionGrantScope, presenceMode: ApprovalPresenceMode) {
        self.presenceMode = presenceMode
        self.scope = defaultScope
        self.state = .awaitingInput
    }

    public init(content: PanelContent, presenceMode: ApprovalPresenceMode) {
        self.init(defaultScope: content.defaultScope, presenceMode: presenceMode)
    }

    /// Opening the panel. Only the embedded prompt arms itself; the other two modes
    /// wait for a button, which is what keeps today's behaviour for an ungated key
    /// and for the no-biometrics fallback.
    public mutating func start() -> ApprovalFlowEffect {
        guard presenceMode == .embedded else {
            state = .awaitingInput
            return .showControls
        }
        state = .scanning
        return .beginScan
    }

    /// A control the user moved.
    ///
    /// Allowed while a scan is armed on purpose: with the prompt inside the panel
    /// there is nothing modal over the controls, so the selection can legitimately
    /// change right up to the moment the scan lands. Refused only once an answer
    /// has been given, so a late control event cannot rewrite a decision already
    /// made.
    public mutating func select(scope newScope: SessionGrantScope, durationMs newDurationMs: Int64? = nil) {
        if case .finished = state { return }
        scope = newScope
        durationMs = newScope == .duration ? newDurationMs : nil
    }

    public mutating func apply(_ event: ApprovalFlowEvent) -> ApprovalFlowEffect {
        if case .finished(let decision) = state {
            // Terminal. A late callback must not reopen anything.
            return .finish(decision)
        }

        switch event {
        case .cancelPressed, .timedOut:
            return finish(PanelDecision.denied(defaultScope: scope))

        case .scanSucceeded:
            return finish(PanelDecision(approved: true, scope: scope, durationMs: durationForAnswer()))

        case .scanFailed:
            // Not a refusal. Leave the panel as it is, with the button live so the
            // user can arm it again. Deliberately does not re-arm by itself.
            failedScans += 1
            state = .awaitingInput
            return .showControls

        case .confirmPressed:
            guard state == .awaitingInput else { return .beginScan }
            switch presenceMode {
            case .none:
                return finish(PanelDecision(approved: true, scope: scope, durationMs: durationForAnswer()))
            case .embedded, .systemDialog:
                state = .scanning
                return .beginScan
            }
        }
    }

    private mutating func finish(_ decision: PanelDecision) -> ApprovalFlowEffect {
        state = .finished(decision)
        return .finish(decision)
    }

    private func durationForAnswer() -> Int64? {
        return scope == .duration ? (durationMs ?? DurationPreset.default.milliseconds) : nil
    }
}
