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
///
/// A coding-agent session is a hop like any other, sitting where it really is in
/// the ancestry, marked in purple with its own title and start time. The rail
/// below it is tinted the same purple, so everything running inside that session
/// is a span you can see rather than a relationship you have to work out. It is
/// never folded away: which session a request came from is the most load-bearing
/// fact on the panel when there is one.
final class PanelChainView: NSView {
    private let onLayoutChanged: () -> Void
    private var expanded = false
    private var foldedRows: [NSView] = []
    private var pathLabels: [NSTextField] = []
    /// The expander's label and what it says, so the preview can open the chain.
    private var expander: (field: NSTextField, label: String)?
    /// Lines that only appear once the chain is opened.
    private var invocationRows: [NSView] = []
    /// Marks that grow a word when the chain is opened.
    private var postureLabels: [(label: NSTextField, posture: HopPosture)] = []

    /// `startExpanded` is for the preview command, which has nobody to click the
    /// expander and still has to be able to show what the opened chain looks like.
    init(
        chain: ExecutionChain,
        fallbackSummary: String,
        invocationMode: UnlockInvocationMode? = nil,
        startExpanded: Bool = false,
        onLayoutChanged: @escaping () -> Void
    ) {
        self.onLayoutChanged = onLayoutChanged
        super.init(frame: .zero)
        defer { if startExpanded { openEverything() } }

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
            let row = hopRow(hop, isFirst: index == 0, isLast: index == chain.hops.count - 1)
            column.addArrangedSubview(row)
            if collapsing, hop.isMinor {
                row.isHidden = true
                foldedRows.append(row)
            }

            // The warning about a hop goes under that hop. A legend at the
            // bottom of the chain is a warning the reader has to match back up
            // to a row, which is a warning that gets skipped.
            // How varlock itself was invoked, from the kernel rather than from
            // anything the client said. Evidence, so it keeps company with the
            // paths and appears when the chain is opened.
            if hop.isRequester, let invocation = invocationText(hop: hop, chain: chain, mode: invocationMode) {
                let line = invocationRow(invocation, insideSession: hop.isInsideSession)
                column.addArrangedSubview(line)
                invocationRows.append(line)
                line.isHidden = true
            }

            guard let advisory = hop.advisory else { continue }
            let sub = advisoryRow(
                advisory,
                insideSession: hop.isInsideSession,
                // Nothing follows the last hop's advisory, so its rail ends there
                // instead of trailing off into the bottom of the card.
                endsTheChain: index == chain.hops.count - 1 && !collapsing
            )
            column.addArrangedSubview(sub)
            if collapsing, hop.isMinor {
                sub.isHidden = true
                foldedRows.append(sub)
            }
        }

        if collapsing, let label = chain.expanderLabel {
            // The folded hops sit inside the session when the last one does, so
            // the expander's own rail segment is tinted to match rather than
            // breaking the span in half.
            let insideSession = chain.collapsibleHops.last?.isInsideSession ?? false
            column.addArrangedSubview(expanderView(label: label, insideSession: insideSession))
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Open the chain without a click, for the preview.
    private func openEverything() {
        guard let (field, label) = expander else {
            // Nothing folds away, but the evidence lines still have to appear.
            expanded = true
            for path in pathLabels { path.isHidden = false }
            for row in invocationRows { row.isHidden = false }
            applyPostureWords()
            return
        }
        toggleExpanded(field: field, label: label)
    }

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
        let container = ChainRailView(
            isFirst: isFirst,
            isLast: isLast,
            emphasis: hop.isSessionRoot ? .session : (hop.isImportant ? .actor : .quiet),
            // The tint starts halfway down the session root's own row, which is
            // where the session actually begins.
            railAbove: hop.isInsideSession ? PanelStyle.sessionRail : PanelStyle.chainRail,
            railBelow: hop.isInsideSession || hop.isSessionRoot
                ? PanelStyle.sessionRail
                : PanelStyle.chainRail
        )
        container.translatesAutoresizingMaskIntoConstraints = false

        let row = hop.isSessionRoot ? sessionRow(hop) : processRow(hop)
        row.translatesAutoresizingMaskIntoConstraints = false

        // The session root is a tinted, labelled row rather than one more line
        // with a different coloured dot. Which session a request came from is
        // the fact most likely to change the answer, so it has to be impossible
        // to skim past.
        let host: NSView
        if hop.isSessionRoot {
            let tinted = NSView()
            tinted.wantsLayer = true
            tinted.layer?.backgroundColor = PanelStyle.sessionRowBackground.cgColor
            tinted.layer?.cornerRadius = 7
            tinted.translatesAutoresizingMaskIntoConstraints = false
            tinted.addSubview(row)
            NSLayoutConstraint.activate([
                row.leadingAnchor.constraint(equalTo: tinted.leadingAnchor, constant: 8),
                row.trailingAnchor.constraint(equalTo: tinted.trailingAnchor, constant: -8),
                row.topAnchor.constraint(equalTo: tinted.topAnchor, constant: 6),
                row.bottomAnchor.constraint(equalTo: tinted.bottomAnchor, constant: -6),
            ])
            host = tinted
        } else {
            host = row
        }

        container.addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
            host.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            host.topAnchor.constraint(equalTo: container.topAnchor, constant: hop.isSessionRoot ? 2 : 3),
            host.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: hop.isSessionRoot ? -2 : -3),
            container.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth - 24),
        ])
        return container
    }

    /// What the line under varlock's hop says.
    ///
    /// A typed command is shown as one ("$ varlock load"). A load from inside a
    /// host process is not: the command a person would recognise is the host's,
    /// and varlock's own internal invocation would be a command nobody ran. The
    /// framing word is client-reported and the command is the kernel's, which is
    /// the split the whole panel is built on.
    private func invocationText(
        hop: ExecutionHop,
        chain: ExecutionChain,
        mode: UnlockInvocationMode?
    ) -> String? {
        guard let mode, mode.isHosted else {
            return hop.invocation.map { "$ \($0)" }
        }
        guard let host = chain.hostInvocation ?? hop.invocation else { return nil }
        return "auto-loaded inside \(host)"
    }

    /// The command line under the hop that ran it.
    private func invocationRow(_ text: String, insideSession: Bool) -> NSView {
        let rail = ChainRailView(
            isFirst: false,
            isLast: true,
            emphasis: .none,
            railAbove: insideSession ? PanelStyle.sessionRail : PanelStyle.chainRail,
            railBelow: insideSession ? PanelStyle.sessionRail : PanelStyle.chainRail
        )
        let label = PanelStyle.label(text, size: 10, color: PanelStyle.inkTertiary, mono: true)
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false
        rail.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: rail.leadingAnchor, constant: 42),
            label.trailingAnchor.constraint(lessThanOrEqualTo: rail.trailingAnchor),
            label.topAnchor.constraint(equalTo: rail.topAnchor),
            label.bottomAnchor.constraint(equalTo: rail.bottomAnchor, constant: -3),
            rail.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth - 24),
        ])
        return rail
    }

    /// The amber line under a hop, saying the one thing about it worth knowing.
    private func advisoryRow(_ text: String, insideSession: Bool, endsTheChain: Bool) -> NSView {
        let rail = ChainRailView(
            isFirst: false,
            isLast: endsTheChain,
            emphasis: .none,
            railAbove: insideSession ? PanelStyle.sessionRail : PanelStyle.chainRail,
            railBelow: insideSession ? PanelStyle.sessionRail : PanelStyle.chainRail
        )
        let label = PanelStyle.label("\u{25B2} " + text, size: 10.5, color: PanelStyle.warn)
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 3
        label.preferredMaxLayoutWidth = PanelStyle.contentWidth - 70
        label.translatesAutoresizingMaskIntoConstraints = false
        rail.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: rail.leadingAnchor, constant: 42),
            label.trailingAnchor.constraint(lessThanOrEqualTo: rail.trailingAnchor),
            label.topAnchor.constraint(equalTo: rail.topAnchor),
            label.bottomAnchor.constraint(equalTo: rail.bottomAnchor, constant: -3),
            rail.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth - 24),
        ])
        return rail
    }

    /// An ordinary process: what it is, what is running it, and how hardened it is.
    private func processRow(_ hop: ExecutionHop) -> NSStackView {
        let row = PanelStyle.row(spacing: 8)

        row.addArrangedSubview(icon(for: hop))

        var nameText = hop.name
        if let terminal = hop.terminalName { nameText += " \u{00B7} \(terminal)" }
        row.addArrangedSubview(PanelStyle.label(
            nameText,
            size: hop.isImportant ? 14.5 : 11.5,
            color: hop.isImportant ? PanelStyle.ink : PanelStyle.inkTertiary,
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
        if let path = hop.path { row.addArrangedSubview(pathLabel(path)) }
        return row
    }

    /// The session root: which session a "this session" grant attaches to.
    ///
    /// Every chain has one, because every grant has one. Usually that is the
    /// shell on the controlling terminal; inside a coding agent it is the agent
    /// itself, and the row then says which product, what the session is called,
    /// and when it started. Two lines, because the second line is what tells one
    /// session from another and squeezing it onto the first would truncate it.
    /// The row is allowed to be taller than the others: it answers the question
    /// the scope buttons are asking.
    private func sessionRow(_ hop: ExecutionHop) -> NSStackView {
        let column = PanelStyle.column(spacing: 2)
        guard let root = hop.sessionRoot else { return column }
        let session = root.agent

        let heading = PanelStyle.row(spacing: 8)
        heading.addArrangedSubview(icon(for: hop))
        // The agent's product where there is one, and the process itself
        // otherwise: "zsh" is what this session is, and naming it anything
        // grander would be inventing a session that does not exist.
        let name = PanelStyle.label(
            session?.productName ?? hop.name,
            size: 12.5,
            color: PanelStyle.sessionInk,
            weight: .semibold
        )
        name.setContentCompressionResistancePriority(.required, for: .horizontal)
        heading.addArrangedSubview(name)
        heading.addArrangedSubview(sessionRootTag())
        heading.addArrangedSubview(PanelStyle.spacer())
        if let started = startedLabel(session?.startTime) {
            let time = PanelStyle.label("started \(started)", size: 9.5, color: PanelStyle.inkQuiet)
            // When the chain is opened the path joins this row, and the time is
            // the half worth keeping: it is what tells two sessions apart.
            time.setContentCompressionResistancePriority(.required, for: .horizontal)
            heading.addArrangedSubview(time)
        }
        if let path = hop.path { heading.addArrangedSubview(pathLabel(path)) }
        column.addArrangedSubview(heading)
        heading.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true

        // The agent's own title where there is one, and otherwise the name this
        // session goes by everywhere else ("Terminal ttys004"), which is what the
        // menu bar lists it under and what ending it will be called.
        let titled = session?.title
        let secondary = PanelStyle.label(
            titled.map { "\u{201C}\($0)\u{201D}" } ?? root.label,
            size: 11.5,
            color: PanelStyle.sessionTitleInk
        )
        if titled != nil {
            secondary.font = NSFontManager.shared.convert(
                NSFont.systemFont(ofSize: 11.5),
                toHaveTrait: .italicFontMask
            )
        }
        // Wraps rather than truncates: this is the line that tells one session
        // apart from another.
        secondary.lineBreakMode = .byWordWrapping
        secondary.maximumNumberOfLines = 3
        secondary.preferredMaxLayoutWidth = PanelStyle.contentWidth - 72
        column.addArrangedSubview(secondary)
        return column
    }

    /// The chip that says out loud what the tint means.
    private func sessionRootTag() -> NSView {
        let box = NSView()
        box.wantsLayer = true
        box.layer?.backgroundColor = PanelStyle.sessionTagBackground.cgColor
        box.layer?.cornerRadius = 4
        let field = PanelStyle.label("SESSION ROOT", size: 8.5, color: PanelStyle.sessionInk, weight: .bold)
        field.translatesAutoresizingMaskIntoConstraints = false
        field.setContentCompressionResistancePriority(.required, for: .horizontal)
        box.addSubview(field)
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 5),
            field.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -5),
            field.topAnchor.constraint(equalTo: box.topAnchor, constant: 1.5),
            field.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -1.5),
        ])
        return box
    }

    /// Paths are evidence, not identity: they appear only once the chain has been
    /// opened, and they sit in the quiet column on the right. Truncated in the
    /// middle, because the ends of a path are the parts that identify it.
    private func pathLabel(_ path: String) -> NSTextField {
        let label = PanelStyle.label(abbreviate(path), size: 9.5, color: PanelStyle.inkQuiet, mono: true)
        label.lineBreakMode = .byTruncatingMiddle
        label.isHidden = true
        pathLabels.append(label)
        return label
    }

    /// The mark, and once the chain is opened the word for it.
    ///
    /// The word only ever appears next to something we actually checked. An
    /// absent mark means "we are not saying", which is honest; a grey dot would
    /// read as a verdict.
    private func postureMark(_ posture: HopPosture) -> NSView? {
        switch posture {
        case .signedHardened:
            let label = PanelStyle.label("\u{25CF}", size: 10, color: PanelStyle.ok)
            postureLabels.append((label, posture))
            return label
        case .interpretedScript:
            return PanelStyle.label("\u{25B2}", size: 11, color: PanelStyle.warn)
        case .unhardened, .unknown:
            return nil
        }
    }

    private func expanderView(label: String, insideSession: Bool) -> NSView {
        let field = PanelStyle.label(collapsedLabel(label), size: 10.5, color: PanelStyle.inkQuiet)
        expander = (field, label)
        let rail = ChainRailView(
            isFirst: false,
            isLast: false,
            emphasis: .none,
            railAbove: insideSession ? PanelStyle.sessionRail : PanelStyle.chainRail,
            railBelow: insideSession ? PanelStyle.sessionRail : PanelStyle.chainRail
        )
        rail.onClick = { [weak self] in self?.toggleExpanded(field: field, label: label) }
        field.translatesAutoresizingMaskIntoConstraints = false
        rail.addSubview(field)
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: rail.leadingAnchor, constant: 16),
            field.trailingAnchor.constraint(lessThanOrEqualTo: rail.trailingAnchor),
            field.topAnchor.constraint(equalTo: rail.topAnchor, constant: 2),
            field.bottomAnchor.constraint(equalTo: rail.bottomAnchor),
            rail.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth - 24),
        ])
        return rail
    }

    private func collapsedLabel(_ label: String) -> String {
        return "\u{2304} \(label) \u{00B7} paths and signatures \u{25B8}"
    }

    private func toggleExpanded(field: NSTextField, label: String) {
        expanded.toggle()
        for row in foldedRows { row.isHidden = !expanded }
        for path in pathLabels { path.isHidden = !expanded }
        for row in invocationRows { row.isHidden = !expanded }
        for (label, posture) in postureLabels {
            let word = posture.inlineLabel.map { " \($0)" } ?? ""
            label.stringValue = "\u{25CF}" + (expanded ? word : "")
        }
        field.stringValue = expanded ? "\u{2303} fewer steps" : collapsedLabel(label)
        onLayoutChanged()
    }

    private func applyPostureWords() {
        for (label, posture) in postureLabels {
            let word = posture.inlineLabel.map { " \($0)" } ?? ""
            label.stringValue = "\u{25CF}" + (expanded ? word : "")
        }
    }

    /// "2:14 PM": the thing a person can check against their own screen.
    private func startedLabel(_ startTime: Int?) -> String? {
        guard let startTime, startTime > 0 else { return nil }
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(startTime)))
    }

    /// This hop's picture: the app's own icon where there is one, a tool tile
    /// where there is not, and a terminal when we know nothing. Filled in from the
    /// run loop, so a cold LaunchServices lookup cannot delay the panel.
    private func icon(for hop: ExecutionHop) -> NSView {
        return PanelIconView(side: 16, placeholder: PanelIcons.genericTerminal()) {
            PanelIcons.icon(for: hop) ?? PanelIcons.genericTerminal()
        }
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
///
/// The rail is drawn in two halves so a session can begin in the middle of a row:
/// grey above the hop the session is rooted at, tinted below it and all the way
/// down. That is what makes "inside the session" a visible span.
final class ChainRailView: NSView, PanelClickTarget {
    enum Emphasis {
        /// The hop that decides what runs.
        case actor
        /// The root of a coding-agent session.
        case session
        /// Everything else on the rail.
        case quiet
        /// Not a hop at all (the expander line): rail, no dot.
        case none
    }

    private let isFirst: Bool
    private let isLast: Bool
    private let emphasis: Emphasis
    private let railAbove: NSColor
    private let railBelow: NSColor

    /// Set when the row is something to click.
    var onClick: (() -> Void)?

    init(isFirst: Bool, isLast: Bool, emphasis: Emphasis, railAbove: NSColor, railBelow: NSColor) {
        self.isFirst = isFirst
        self.isLast = isLast
        self.emphasis = emphasis
        self.railAbove = railAbove
        self.railBelow = railBelow
        super.init(frame: .zero)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let midY = bounds.midY
        let railX: CGFloat = 5

        // AppKit's origin is bottom left, so "above" is the higher y.
        if !isFirst {
            railAbove.setFill()
            NSRect(x: railX - 1, y: midY, width: 2, height: bounds.maxY - midY).fill()
        }
        if !isLast {
            railBelow.setFill()
            NSRect(x: railX - 1, y: bounds.minY, width: 2, height: midY - bounds.minY).fill()
        }

        let side: CGFloat
        let color: NSColor
        switch emphasis {
        // Bright and neutral, never accent: a coloured marker next to a green
        // "signed" dot reads as a verdict on the process, and this one is about
        // structure. Colour on this rail means one thing at a time.
        case .actor: (side, color) = (9, PanelStyle.ink)
        case .session: (side, color) = (9, PanelStyle.sessionDot)
        case .quiet: (side, color) = (7, PanelStyle.chainDot)
        case .none: return
        }
        let dot = NSBezierPath(ovalIn: NSRect(
            x: railX - side / 2,
            y: midY - side / 2,
            width: side,
            height: side
        ))
        color.setFill()
        dot.fill()
    }

    override func mouseUp(with event: NSEvent) {
        guard let onClick, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        onClick()
    }

    /// Only the rows that do something take the click; the rest let it fall
    /// through, so a chain row is not a dead button.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard onClick != nil else { return nil }
        return clickTargetHitTest(point)
    }

    override func resetCursorRects() {
        guard onClick != nil else { return }
        addCursorRect(bounds, cursor: .pointingHand)
    }
}
