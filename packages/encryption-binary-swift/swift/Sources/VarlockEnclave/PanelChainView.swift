import AppKit
import IdentitySessions
import SessionScoping

/// "Who is asking", drawn as the line of processes that leads to the caller.
///
/// The chain is always visible, because one process name is not an answer: `bun`
/// says nothing, and `agent.ts via bun, launched from iTerm2` says everything.
/// Size carries the meaning: the hop that decides what runs is large, the app
/// that was launched is small context at the top, and the boring hops in between
/// fold away until someone asks for them.
final class PanelChainView: NSView {
    private let onLayoutChanged: () -> Void
    private var expanded = false
    private var foldedRows: [NSView] = []
    private var expanderRow: NSView?

    init(chain: ExecutionChain, fallbackSummary: String, onLayoutChanged: @escaping () -> Void) {
        self.onLayoutChanged = onLayoutChanged
        super.init(frame: .zero)

        let card = PanelStyle.card(background: PanelStyle.chainBackground, border: PanelStyle.chainBorder)
        card.translatesAutoresizingMaskIntoConstraints = false
        addSubview(card)
        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            card.trailingAnchor.constraint(equalTo: trailingAnchor),
            card.topAnchor.constraint(equalTo: topAnchor),
            card.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        let column = PanelStyle.column(spacing: 0)
        column.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 12),
            column.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -12),
            column.topAnchor.constraint(equalTo: card.topAnchor, constant: 10),
            column.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -10),
        ])

        guard !chain.isEmpty else {
            // Nothing could be read off the peer. Say the one line we do have
            // rather than drawing an empty rail.
            column.addArrangedSubview(PanelStyle.label(
                fallbackSummary.isEmpty ? "Requested by an unidentified process" : fallbackSummary,
                size: 12,
                color: PanelStyle.ink
            ))
            return
        }

        let collapsing = chain.collapsesWhenResting
        for (index, hop) in chain.hops.enumerated() {
            let row = hopRow(
                hop,
                isFirst: index == 0,
                isLast: index == chain.hops.count - 1
            )
            column.addArrangedSubview(row)
            if collapsing, hop.isMinor {
                row.isHidden = true
                foldedRows.append(row)
            }
        }

        if collapsing, let label = chain.expanderLabel {
            let expander = expanderView(label: label)
            expanderRow = expander
            column.addArrangedSubview(expander)
        }

        if let badge = chain.agentSession {
            let badgeRow = PanelStyle.row(spacing: 6)
            badgeRow.addArrangedSubview(agentBadge(badge))
            badgeRow.addArrangedSubview(PanelStyle.spacer())
            column.setCustomSpacing(8, after: column.arrangedSubviews.last ?? badgeRow)
            column.addArrangedSubview(indented(badgeRow))
        }

        if let note = chain.postureNote {
            let marks = chain.hops.contains { $0.posture == .interpretedScript } ? "\u{25B2} " : "\u{25CF} "
            let noteLabel = PanelStyle.label(
                marks + note,
                size: 11,
                color: chain.hops.contains { $0.posture == .interpretedScript }
                    ? PanelStyle.warn
                    : PanelStyle.inkTertiary
            )
            noteLabel.lineBreakMode = .byWordWrapping
            noteLabel.maximumNumberOfLines = 3
            noteLabel.preferredMaxLayoutWidth = PanelStyle.contentWidth - 40
            column.setCustomSpacing(8, after: column.arrangedSubviews.last ?? noteLabel)
            column.addArrangedSubview(indented(noteLabel))
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Everything under the rail lines up with the hop text, not with the dots.
    private func indented(_ view: NSView) -> NSView {
        let box = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 16),
            view.trailingAnchor.constraint(lessThanOrEqualTo: box.trailingAnchor),
            view.topAnchor.constraint(equalTo: box.topAnchor),
            view.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            box.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth - 24),
        ])
        return box
    }

    private func hopRow(_ hop: ExecutionHop, isFirst: Bool, isLast: Bool) -> NSView {
        let container = ChainRailView(isFirst: isFirst, isLast: isLast, isImportant: hop.isImportant)
        container.translatesAutoresizingMaskIntoConstraints = false

        let row = PanelStyle.row(spacing: 8)
        row.translatesAutoresizingMaskIntoConstraints = false

        if let bundlePath = hop.bundlePath, let icon = appIcon(bundlePath: bundlePath) {
            let imageView = NSImageView()
            imageView.image = icon
            imageView.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                imageView.widthAnchor.constraint(equalToConstant: 16),
                imageView.heightAnchor.constraint(equalToConstant: 16),
            ])
            row.addArrangedSubview(imageView)
        }

        let nameSize: CGFloat = hop.isImportant ? 14.5 : 11.5
        let nameColor = hop.isImportant ? PanelStyle.ink : PanelStyle.inkTertiary
        var nameText = hop.name
        if let terminal = hop.terminalName {
            nameText += " \u{00B7} \(terminal)"
        }
        row.addArrangedSubview(PanelStyle.label(
            nameText,
            size: nameSize,
            color: nameColor,
            weight: hop.isImportant ? .semibold : .regular,
            mono: !hop.isLauncher
        ))
        if let via = hop.via {
            row.addArrangedSubview(PanelStyle.label(via, size: 11.5, color: PanelStyle.inkTertiary))
        }
        if let mark = postureMark(hop.posture) {
            row.addArrangedSubview(mark)
        }
        row.addArrangedSubview(PanelStyle.spacer())

        // Paths are evidence, not identity: they only appear once the chain has
        // been opened, and they sit in the quiet column on the right.
        if let path = hop.path {
            let pathLabel = PanelStyle.label(
                abbreviate(path),
                size: 9.5,
                color: PanelStyle.inkQuiet,
                mono: true
            )
            pathLabel.isHidden = true
            pathLabels.append(pathLabel)
            row.addArrangedSubview(pathLabel)
        }

        container.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            row.topAnchor.constraint(equalTo: container.topAnchor, constant: 3),
            row.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -3),
            container.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth - 24),
        ])
        return container
    }

    private var pathLabels: [NSTextField] = []

    private func postureMark(_ posture: HopPosture) -> NSView? {
        switch posture {
        case .signedHardened:
            return PanelStyle.label("\u{25CF}", size: 10, color: PanelStyle.ok)
        case .interpretedScript:
            return PanelStyle.label("\u{25B2}", size: 11, color: PanelStyle.warn)
        case .unhardened, .unknown:
            // Deliberately nothing. An absent badge means "we are not saying",
            // which is honest; a grey dot would read as a verdict.
            return nil
        }
    }

    private func expanderView(label: String) -> NSView {
        let field = PanelStyle.label(
            "\u{2304} \(label) \u{00B7} paths and signatures \u{25B8}",
            size: 10.5,
            color: PanelStyle.inkQuiet
        )
        let row = ClickableRow { [weak self] in self?.toggleExpanded(field: field, label: label) }
        field.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(field)
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 16),
            field.trailingAnchor.constraint(lessThanOrEqualTo: row.trailingAnchor),
            field.topAnchor.constraint(equalTo: row.topAnchor, constant: 2),
            field.bottomAnchor.constraint(equalTo: row.bottomAnchor),
            row.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth - 24),
        ])
        return row
    }

    private func toggleExpanded(field: NSTextField, label: String) {
        expanded.toggle()
        for row in foldedRows { row.isHidden = !expanded }
        for path in pathLabels { path.isHidden = !expanded }
        field.stringValue = expanded
            ? "\u{2303} fewer steps"
            : "\u{2304} \(label) \u{00B7} paths and signatures \u{25B8}"
        onLayoutChanged()
    }

    private func agentBadge(_ badge: AgentSessionBadge) -> NSView {
        let box = NSView()
        box.wantsLayer = true
        box.layer?.backgroundColor = PanelStyle.agentBadgeBackground.cgColor
        box.layer?.borderColor = PanelStyle.agentBadgeBorder.cgColor
        box.layer?.borderWidth = 1
        box.layer?.cornerRadius = 5

        var text = "\(badge.productName) session"
        if let started = startedLabel(badge.startTime) { text += " \u{00B7} started \(started)" }
        let field = PanelStyle.label(text, size: 10.5, color: PanelStyle.agentBadgeInk)
        field.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(field)
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 6),
            field.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -6),
            field.topAnchor.constraint(equalTo: box.topAnchor, constant: 1),
            field.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -1),
        ])
        return box
    }

    /// "2:14 PM": the thing a person can check against their own screen. The raw
    /// session id belongs in the audit log, where a machine reads it.
    private func startedLabel(_ startTime: Int?) -> String? {
        guard let startTime, startTime > 0 else { return nil }
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(startTime)))
    }

    private func appIcon(bundlePath: String) -> NSImage? {
        guard FileManager.default.fileExists(atPath: bundlePath) else { return nil }
        let icon = NSWorkspace.shared.icon(forFile: bundlePath)
        icon.size = NSSize(width: 16, height: 16)
        return icon
    }

    private func abbreviate(_ path: String) -> String {
        let home = NSHomeDirectory()
        if !home.isEmpty, path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }
}

/// Draws the vertical rail and this hop's dot behind a chain row.
final class ChainRailView: NSView {
    private let isFirst: Bool
    private let isLast: Bool
    private let isImportant: Bool

    init(isFirst: Bool, isLast: Bool, isImportant: Bool) {
        self.isFirst = isFirst
        self.isLast = isLast
        self.isImportant = isImportant
        super.init(frame: .zero)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let midY = bounds.midY
        let railX: CGFloat = 5

        PanelStyle.chainRail.setFill()
        let top = isFirst ? midY : bounds.maxY
        let bottom = isLast ? midY : bounds.minY
        NSRect(x: railX - 1, y: bottom, width: 2, height: top - bottom).fill()

        let side: CGFloat = isImportant ? 9 : 7
        let dot = NSBezierPath(ovalIn: NSRect(
            x: railX - side / 2,
            y: midY - side / 2,
            width: side,
            height: side
        ))
        (isImportant ? PanelStyle.accent : PanelStyle.chainDot).setFill()
        dot.fill()
    }
}

/// A view that reports a click. Used for rows that open something.
final class ClickableRow: NSView {
    private let onClick: () -> Void

    init(onClick: @escaping () -> Void) {
        self.onClick = onClick
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseUp(with event: NSEvent) {
        guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        onClick()
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }
}
