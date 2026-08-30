import AppKit
import IdentitySessions

/// The panel the daemon draws when someone has to say yes.
///
/// This file is view only. What the panel says, which scopes it may offer, and
/// what a given answer means are all decided in `IdentitySessions` (see
/// `UnlockDecision.swift` and `PanelContent.swift`), so the rules can be tested
/// without a window server. Everything here does is turn a `PanelContent` into
/// pixels and turn the click back into a `PanelDecision`.
///
/// It is drawn by the daemon on purpose. The daemon is the process that holds the
/// keys and the one that verified the peer, so it is the only party in a position
/// to say truthfully who is asking. A panel drawn by the caller would be a panel
/// the caller can lie on.
final class ApprovalPanel: NSObject {
    /// How long the panel waits for an answer before treating it as a cancel.
    /// Below the client's 5 minute interactive timeout, so the caller gets a real
    /// answer rather than a dead socket.
    static let timeoutSeconds: TimeInterval = 120

    private static let contentWidth: CGFloat = 420

    private var scopeControl: NSSegmentedControl?
    private var durationPopUp: NSPopUpButton?
    private var scopes: [SessionGrantScope] = []
    private var timedOut = false

    /// Show a panel and wait for the answer.
    ///
    /// Returns nil when the panel could not be drawn at all, which the caller
    /// reports as `NO_UI`. A cancel comes back as a decision with `approved`
    /// false, so callers can tell "the user said no" from "nobody could be asked".
    static func present(content: PanelContent) -> PanelDecision? {
        guard UiAvailability.canShowUi() else { return nil }

        var decision: PanelDecision?
        let work = {
            let panel = ApprovalPanel()
            decision = panel.run(content: content)
        }
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.sync { work() }
        }
        return decision
    }

    // MARK: - Rendering

    private func run(content: PanelContent) -> PanelDecision {
        SecureInputDialog.ensureEditMenu()
        scopes = content.scopes

        let alert = NSAlert()
        alert.messageText = content.title
        alert.informativeText = content.subtitle ?? ""
        alert.alertStyle = .informational
        alert.addButton(withTitle: content.confirmButtonTitle)
        alert.addButton(withTitle: content.cancelButtonTitle)
        alert.accessoryView = buildAccessoryView(content: content)

        let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Varlock"
        alert.window.title = appName

        // Float above whatever the user was looking at, and take focus, so an
        // approval never ends up hidden behind an editor window.
        alert.window.level = .floating
        NSApp.activate(ignoringOtherApps: true)
        alert.layout()

        // An unanswered panel must not pin a client socket open forever.
        timedOut = false
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, !self.timedOut else { return }
            self.timedOut = true
            NSApp.abortModal()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeoutSeconds, execute: deadline)

        let response = alert.runModal()
        deadline.cancel()

        guard !timedOut, response == .alertFirstButtonReturn else {
            return PanelDecision.denied(defaultScope: content.defaultScope)
        }
        let scope = selectedScope(fallback: content.defaultScope)
        return PanelDecision(
            approved: true,
            scope: scope,
            durationMs: scope == .duration ? selectedDurationMs() : nil
        )
    }

    private func buildAccessoryView(content: PanelContent) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false

        // Who is asking. Derived lines come first and are drawn as normal body
        // text; client-supplied decoration is dimmed so the two never read alike.
        let derived = content.contextLines.filter { $0.isDerived }
        let clientSupplied = content.contextLines.filter { !$0.isDerived }
        if !derived.isEmpty || !clientSupplied.isEmpty {
            let box = NSStackView()
            box.orientation = .vertical
            box.alignment = .leading
            box.spacing = 2
            for line in derived {
                box.addArrangedSubview(label(line.text, size: NSFont.systemFontSize, color: .labelColor))
            }
            for line in clientSupplied {
                box.addArrangedSubview(label(
                    line.text,
                    size: NSFont.smallSystemFontSize,
                    color: .secondaryLabelColor
                ))
            }
            stack.addArrangedSubview(box)
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
        return container
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

    // MARK: - Controls

    @objc private func scopeChanged(_ sender: NSSegmentedControl) {
        durationPopUp?.isEnabled = selectedScope(fallback: .once) == .duration
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
}
