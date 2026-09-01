import AppKit
import IdentitySessions
import SessionScoping

/// "Who is asking", drawn as the line of processes that leads to the caller.
///
/// The chain is always visible, because one process name is not an answer: `bun`
/// says nothing, and `agent.ts via bun, launched from iTerm2` says everything.
/// Size carries the meaning: the actor (the program the values are for) is large,
/// the app that was launched is small context at the top, and the plumbing in
/// between folds away until someone asks for it. Nothing is large when nothing
/// qualifies, which is the honest state for a command a person typed.
///
/// One row is the session root, tinted purple and tagged: the process a "this
/// session" grant attaches to, which the panel is asking about in the same
/// breath. The rail below it is tinted to match, so everything inside that
/// session is a span you can see rather than a relationship you have to work
/// out, and it is never folded away. When the session belongs to a coding agent,
/// that row also carries the product, the session's title, and its start time.
///
/// That row is also the only place a tty id appears. A controlling terminal is
/// inherited, so every hop below the session root is on the same one, and the app
/// at the top of the chain holds none of its own: saying "ttys004" anywhere else
/// is either the same fact twice or a fact about the wrong row.
///
/// The line under varlock's own hop says how it came to be running: a typed
/// command with its command line, or the host that auto-loaded it. That is never
/// hidden behind the expander, because it is the difference between a person
/// asking and a program asking.
final class PanelChainView: NSView {
    private let onLayoutChanged: () -> Void
    private var expanded = false
    private var foldedRows: [NSView] = []
    private var pathLabels: [NSTextField] = []
    /// The expander's label and what it says, so the preview can open the chain.
    private var expander: (field: NSTextField, label: String)?
    /// Marks that grow a word when the chain is opened.
    private var postureLabels: [(label: NSTextField, posture: HopPosture)] = []

    /// `startExpanded` is for the preview command, which has nobody to click the
    /// expander and still has to be able to show what the opened chain looks like.
    init(
        chain: ExecutionChain,
        fallbackSummary: String,
        invocation: InvocationNote = InvocationNote(kind: .unknown),
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

            // How varlock came to be running, and what receives the values. Read
            // from the kernel rather than from anything the client said, and
            // always on screen: a typed command and an auto-load are different
            // requests, and which one this is should never have to be inferred
            // (or found behind a disclosure).
            if hop.isRequester {
                for text in invocation.lines {
                    column.addArrangedSubview(invocationRow(text, insideSession: hop.isInsideSession))
                }
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
        // Every row gets the same padding, whether or not anything is painted
        // behind it. Only the session root has a background, and giving that
        // background its own inset is what used to push its icon and text out of
        // line with the rows around it.
        let host = NSView()
        host.translatesAutoresizingMaskIntoConstraints = false
        if hop.isSessionRoot {
            host.wantsLayer = true
            host.layer?.backgroundColor = PanelStyle.sessionRowBackground.cgColor
            host.layer?.cornerRadius = 7
        }
        host.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: ChainGrid.rowPadding),
            row.trailingAnchor.constraint(equalTo: host.trailingAnchor, constant: -ChainGrid.rowPadding),
            row.topAnchor.constraint(equalTo: host.topAnchor, constant: hop.isSessionRoot ? 6 : 0),
            row.bottomAnchor.constraint(equalTo: host.bottomAnchor, constant: hop.isSessionRoot ? -6 : 0),
        ])

        container.addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: ChainGrid.rowInset),
            host.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            host.topAnchor.constraint(equalTo: container.topAnchor, constant: hop.isSessionRoot ? 2 : 3),
            host.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: hop.isSessionRoot ? -2 : -3),
            container.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth - 24),
        ])
        return container
    }

    /// The one grid every row in the chain is laid out on.
    ///
    /// Rows used to set their own leading constants, and the session root's
    /// tinted background gave it padding nothing else had, so its icon and text
    /// sat further right than the rows above and below it. Every row now carries
    /// the same padding whether or not anything is drawn behind it, and every
    /// line of text starts at `textInset`, icons or no icons.
    private enum ChainGrid {
        /// The rail's width: where a row's own leading edge begins.
        static let rowInset: CGFloat = 16
        /// Breathing room inside a row. Applied to all of them, so the session
        /// root's background can be painted without moving its contents.
        static let rowPadding: CGFloat = 8
        /// Between an icon and the text beside it.
        static let iconSpacing: CGFloat = 8
        /// Where text starts, measured from the rail's leading edge.
        static var textInset: CGFloat { rowInset + rowPadding + PanelIcons.side + iconSpacing }
        /// The same column, measured from inside a row that already has an icon.
        static var textIndent: CGFloat { PanelIcons.side + iconSpacing }
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
            label.leadingAnchor.constraint(equalTo: rail.leadingAnchor, constant: ChainGrid.textInset),
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
            label.leadingAnchor.constraint(equalTo: rail.leadingAnchor, constant: ChainGrid.textInset),
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

        // No tty here, ever. A controlling terminal is inherited, so every hop
        // below the session root shares the one the session-root row already
        // names, and the app at the top holds none of its own.
        row.addArrangedSubview(PanelStyle.label(
            hop.name,
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

        // What this session is: the name it goes by everywhere else ("Terminal
        // ttys004"), which is what the menu bar lists it under and what ending it
        // will be called, led by the agent's own title where it recorded one.
        // The tty is stated here and nowhere else in the chain.
        let secondary = PanelStyle.label(
            root.descriptionLine,
            size: 11.5,
            color: PanelStyle.sessionTitleInk
        )
        // The agent's words in italics, ours upright, so a title cannot be
        // mistaken for something varlock is asserting.
        if let quoted = root.quotedTitle {
            let upright = NSFont.systemFont(ofSize: 11.5)
            let text = NSMutableAttributedString(
                string: root.descriptionLine,
                attributes: [.foregroundColor: PanelStyle.sessionTitleInk, .font: upright]
            )
            let titleRange = (root.descriptionLine as NSString).range(of: quoted)
            if titleRange.location != NSNotFound {
                text.addAttribute(
                    .font,
                    value: NSFontManager.shared.convert(upright, toHaveTrait: .italicFontMask),
                    range: titleRange
                )
            }
            secondary.attributedStringValue = text
        }
        // Wraps rather than truncates: this is the line that tells one session
        // apart from another.
        secondary.lineBreakMode = .byWordWrapping
        secondary.maximumNumberOfLines = 3
        secondary.preferredMaxLayoutWidth = PanelStyle.contentWidth - 72
        // Indented past the icon so it starts where the name above it starts,
        // rather than under the icon in a column of its own.
        let secondaryRow = NSView()
        secondary.translatesAutoresizingMaskIntoConstraints = false
        secondaryRow.addSubview(secondary)
        NSLayoutConstraint.activate([
            secondary.leadingAnchor.constraint(
                equalTo: secondaryRow.leadingAnchor,
                constant: ChainGrid.textIndent
            ),
            secondary.trailingAnchor.constraint(lessThanOrEqualTo: secondaryRow.trailingAnchor),
            secondary.topAnchor.constraint(equalTo: secondaryRow.topAnchor),
            secondary.bottomAnchor.constraint(equalTo: secondaryRow.bottomAnchor),
        ])
        column.addArrangedSubview(secondaryRow)
        secondaryRow.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
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
        return PanelIconView(side: PanelIcons.side, placeholder: PanelIcons.genericTerminal()) {
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
