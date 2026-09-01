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
/// that row also carries the product, the session's title, and its start time,
/// and says so when nobody is watching it or when it is working somewhere other
/// than the project being unlocked.
///
/// That row is also the only place a tty id appears. A controlling terminal is
/// inherited, so every hop below the session root is on the same one, and the app
/// at the top of the chain holds none of its own: saying "ttys004" anywhere else
/// is either the same fact twice or a fact about the wrong row.
///
/// The line under varlock's own hop says how it came to be running: a typed
/// command with its command line, or the host that auto-loaded it. That is never
/// hidden behind the expander, because it is the difference between a person
/// asking and a program asking. Nor is the line saying WHICH varlock is running,
/// the compiled binary or its JavaScript under an interpreter, because those two
/// draw the same row and are not the same thing.
///
/// Evidence (paths, versions, interpreters, signatures) lives on full-width lines
/// under the hop it belongs to, shown when the chain is opened. It used to be
/// crammed into the right-hand end of the hop's own row, where a path had a few
/// dozen points to live in and truncated to things like "~/Libra\u{2026}2.1.234".
/// Evidence you cannot read is not evidence.
final class PanelChainView: NSView {
    private let onLayoutChanged: () -> Void
    private var expanded = false
    private var foldedRows: [NSView] = []
    /// Rows that only appear once the chain is opened, whatever else is folded.
    private var evidenceRows: [NSView] = []
    /// The expander's label and what it says, so the preview can open the chain.
    private var expander: (field: NSTextField, label: String)?
    /// Marks that grow a word when the chain is opened.
    private var postureMarks: [PostureMarkView] = []
    /// Every rail segment in the column, in order, so the last VISIBLE one can
    /// stop drawing its half of the rail instead of trailing into a hidden row.
    private var rails: [ChainRailView] = []

    /// `startExpanded` is for the preview command, which has nobody to click the
    /// expander and still has to be able to show what the opened chain looks like.
    init(
        chain: ExecutionChain,
        fallbackSummary: String,
        invocation: InvocationNote = InvocationNote(kind: .unknown),
        sessionAdvisories: [String] = [],
        reportedVarlockVersion: String? = nil,
        startExpanded: Bool = false,
        onLayoutChanged: @escaping () -> Void
    ) {
        self.onLayoutChanged = onLayoutChanged
        super.init(frame: .zero)
        defer { if startExpanded { openEverything() } else { updateRails() } }

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
            let row = hopRow(hop, isFirst: index == 0)
            column.addArrangedSubview(row)
            if collapsing, hop.isMinor {
                row.isHidden = true
                foldedRows.append(row)
            }

            /// Everything under a hop shares its fold and its rail tint.
            func addSubRow(_ view: NSView, hidden: Bool = false) {
                column.addArrangedSubview(view)
                if collapsing, hop.isMinor {
                    view.isHidden = true
                    foldedRows.append(view)
                } else if hidden {
                    view.isHidden = true
                    evidenceRows.append(view)
                }
            }

            // WHICH varlock this is. Never folded away: a compiled binary and a
            // directory of JavaScript files draw the same row, and the difference
            // between them is not detail.
            if let form = hop.runtimeForm {
                addSubRow(runtimeFormRow(
                    form,
                    isCaution: hop.runtimeFormIsCaution,
                    insideSession: hop.isInsideSession
                ))
            }

            // How varlock came to be running, and what receives the values. Read
            // from the kernel rather than from anything the client said, and
            // always on screen: a typed command and an auto-load are different
            // requests, and which one this is should never have to be inferred
            // (or found behind a disclosure).
            if hop.isRequester {
                for line in invocation.commandLines {
                    addSubRow(commandRow(line, insideSession: hop.isInsideSession))
                }
            }

            if let advisory = hop.advisory {
                addSubRow(advisoryRow(advisory, insideSession: hop.isInsideSession))
            }
            // What is unusual about the session itself: nobody watching it, or an
            // agent working somewhere other than the project being unlocked.
            if hop.isSessionRoot {
                for advisory in sessionAdvisories {
                    addSubRow(advisoryRow(advisory, insideSession: true))
                }
            }

            for evidence in evidenceLines(for: hop, reportedVarlockVersion: reportedVarlockVersion) {
                addSubRow(evidenceRow(evidence, insideSession: hop.isInsideSession), hidden: true)
            }
        }

        // The expander appears whenever there is anything behind it, which for a
        // short chain means the evidence lines. It used to be tied to folding
        // hops away, so the commonest panel of all (an app, a shell, and varlock)
        // had no control at all and its paths, versions, and signatures were
        // unreachable: hidden with no way to ask.
        if collapsing || !evidenceRows.isEmpty {
            // The folded hops sit inside the session when the last one does, so
            // the expander's own rail segment is tinted to match rather than
            // breaking the span in half.
            let insideSession = collapsing
                ? (chain.collapsibleHops.last?.isInsideSession ?? false)
                : (chain.hops.last?.isInsideSession ?? false)
            column.addArrangedSubview(expanderView(
                foldedLabel: collapsing ? chain.expanderLabel : nil,
                insideSession: insideSession
            ))
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Open the chain without a click, for the preview.
    private func openEverything() {
        guard let (field, label) = expander else {
            // Nothing folds away, but the evidence lines still have to appear.
            expanded = true
            applyExpansion()
            return
        }
        toggleExpanded(field: field, label: label)
    }

    private func hopRow(_ hop: ExecutionHop, isFirst: Bool) -> NSView {
        let container = ChainRailView(
            isFirst: isFirst,
            emphasis: hop.isSessionRoot ? .session : (hop.isImportant ? .actor : .quiet),
            // The tint starts halfway down the session root's own row, which is
            // where the session actually begins.
            railAbove: hop.isInsideSession ? PanelStyle.sessionRail : PanelStyle.chainRail,
            railBelow: hop.isInsideSession || hop.isSessionRoot
                ? PanelStyle.sessionRail
                : PanelStyle.chainRail
        )
        container.translatesAutoresizingMaskIntoConstraints = false
        rails.append(container)

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

    /// A sub-line under a hop: same rail, same tint, text on the same column.
    ///
    /// Every one of these is built here so a new kind of line cannot quietly
    /// arrive at a different indent, which is how the chain drifted off its grid
    /// the last time.
    private func subRow(insideSession: Bool, content: NSView, bottomPadding: CGFloat = 3) -> NSView {
        let rail = ChainRailView(
            isFirst: false,
            emphasis: .none,
            railAbove: insideSession ? PanelStyle.sessionRail : PanelStyle.chainRail,
            railBelow: insideSession ? PanelStyle.sessionRail : PanelStyle.chainRail
        )
        rails.append(rail)
        content.translatesAutoresizingMaskIntoConstraints = false
        rail.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: rail.leadingAnchor, constant: ChainGrid.textInset),
            content.trailingAnchor.constraint(lessThanOrEqualTo: rail.trailingAnchor),
            content.topAnchor.constraint(equalTo: rail.topAnchor),
            content.bottomAnchor.constraint(equalTo: rail.bottomAnchor, constant: -bottomPadding),
            rail.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth - 24),
        ])
        return rail
    }

    /// The command line under the hop that ran it, drawn as a command.
    ///
    /// A tinted strip, a dimmed sigil, a monospaced face: this is the one line on
    /// the panel a person can check word for word against what they typed, and it
    /// used to be the same small grey text as every note around it.
    private func commandRow(_ line: InvocationLine, insideSession: Bool) -> NSView {
        let row = PanelStyle.row(spacing: 6)
        if let prefix = line.prefix {
            row.addArrangedSubview(PanelStyle.label(prefix, size: 10.5, color: PanelStyle.inkTertiary))
        }
        row.addArrangedSubview(commandStrip(sigil: line.sigil, command: line.command))
        if let suffix = line.suffix {
            let label = PanelStyle.label(suffix, size: 10.5, color: PanelStyle.inkTertiary)
            label.setContentCompressionResistancePriority(.required, for: .horizontal)
            row.addArrangedSubview(label)
        }
        row.addArrangedSubview(PanelStyle.spacer())
        return subRow(insideSession: insideSession, content: row, bottomPadding: 4)
    }

    /// The strip itself: `$` in the quiet ink, the command in the bright one.
    private func commandStrip(sigil: String?, command: String) -> NSView {
        let box = NSView()
        box.wantsLayer = true
        box.layer?.backgroundColor = PanelStyle.commandStrip.cgColor
        box.layer?.borderColor = PanelStyle.commandStripBorder.cgColor
        box.layer?.borderWidth = 1
        box.layer?.cornerRadius = 4

        let font = NSFont.monospacedSystemFont(ofSize: 10.5, weight: .regular)
        let text = NSMutableAttributedString()
        if let sigil {
            text.append(NSAttributedString(
                string: "\(sigil) ",
                attributes: [.font: font, .foregroundColor: PanelStyle.commandSigil]
            ))
        }
        text.append(NSAttributedString(
            string: command,
            attributes: [.font: font, .foregroundColor: PanelStyle.commandInk]
        ))

        let field = NSTextField(labelWithAttributedString: text)
        // Elided in the middle: a command's subcommand and its `--` target are
        // its two identifying ends, and a tail cut takes one of them away.
        field.lineBreakMode = .byTruncatingMiddle
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(field)
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 6),
            field.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -6),
            field.topAnchor.constraint(equalTo: box.topAnchor, constant: 2),
            field.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -2),
        ])
        return box
    }

    /// Which varlock is running, in words, under the varlock row.
    private func runtimeFormRow(_ text: String, isCaution: Bool, insideSession: Bool) -> NSView {
        let label = PanelStyle.label(
            isCaution ? "\u{25B2} " + text : text,
            size: 10.5,
            color: isCaution ? PanelStyle.warn : PanelStyle.inkTertiary
        )
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 2
        label.preferredMaxLayoutWidth = PanelStyle.contentWidth - 70
        return subRow(insideSession: insideSession, content: label)
    }

    /// The amber line under a hop, saying the one thing about it worth knowing.
    private func advisoryRow(_ text: String, insideSession: Bool) -> NSView {
        let label = PanelStyle.label("\u{25B2} " + text, size: 10.5, color: PanelStyle.warn)
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 3
        label.preferredMaxLayoutWidth = PanelStyle.contentWidth - 70
        return subRow(insideSession: insideSession, content: label)
    }

    /// One evidence line: a quiet label, the value, and where relevant the mark
    /// for what was checked about it.
    private func evidenceRow(_ evidence: HopEvidence, insideSession: Bool) -> NSView {
        let row = PanelStyle.row(spacing: 6)

        let label = PanelStyle.label(evidence.label, size: 9.5, color: PanelStyle.inkQuiet)
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        label.alignment = .right
        label.translatesAutoresizingMaskIntoConstraints = false
        label.widthAnchor.constraint(equalToConstant: 62).isActive = true
        row.addArrangedSubview(label)

        let value = PanelStyle.label(
            evidence.isPath ? abbreviate(evidence.value) : evidence.value,
            size: 9.5,
            color: PanelStyle.inkTertiary,
            mono: evidence.isPath
        )
        // The tail of a path names the package and the entry file, which is the
        // half that identifies it, so long ones lose their middle.
        value.lineBreakMode = evidence.isPath ? .byTruncatingMiddle : .byTruncatingTail
        value.toolTip = evidence.isPath ? evidence.value : nil
        row.addArrangedSubview(value)

        if let posture = evidence.posture {
            row.addArrangedSubview(postureMark(
                posture,
                subject: evidence.postureSubject ?? evidence.value,
                alwaysShowsWord: true
            ))
        }
        row.addArrangedSubview(PanelStyle.spacer())
        return subRow(insideSession: insideSession, content: row)
    }

    /// The evidence under one hop, plus the fallback version for varlock's row.
    ///
    /// The daemon reads a version off the package when varlock is running as
    /// JavaScript, because it can resolve that package itself. The compiled
    /// binary carries no package, so the only answer available is the client's
    /// own, and it is labelled as the client's own.
    private func evidenceLines(for hop: ExecutionHop, reportedVarlockVersion: String?) -> [HopEvidence] {
        var lines = hop.evidence
        if hop.isVarlock, hop.release == nil, let reportedVarlockVersion {
            lines.append(HopEvidence(
                label: "version",
                value: HopRelease(version: reportedVarlockVersion, source: .clientReported).displayValue
            ))
        }
        return lines
    }

    /// An ordinary process: what it is, what is running it, and what was checked.
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
        row.addArrangedSubview(postureMark(
            hop.posture,
            subject: hop.postureSubject,
            interpreter: hop.interpreterName
        ))
        row.addArrangedSubview(PanelStyle.spacer())
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
        // This row makes a claim too. It names an agent, and "is this really
        // Claude Code" is a fair question to ask of the row a grant is about to
        // attach to; leaving it as the one unmarked row in the chain would read
        // as the one row nobody had to check.
        heading.addArrangedSubview(postureMark(
            hop.posture,
            subject: session.map { "\u{201C}\($0.productName)\u{201D}" } ?? hop.postureSubject,
            interpreter: hop.interpreterName
        ))
        heading.addArrangedSubview(PanelStyle.spacer())
        if let started = startedLabel(session?.startTime) {
            let time = PanelStyle.label("started \(started)", size: 9.5, color: PanelStyle.inkQuiet)
            // The one thing that earns a place at the end of this row: it is what
            // tells two of the same agent's sessions apart. Paths used to be here
            // too, in whatever few points were left over, and were unreadable.
            time.setContentCompressionResistancePriority(.required, for: .horizontal)
            heading.addArrangedSubview(time)
        }
        column.addArrangedSubview(heading)
        heading.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true

        // What this session is: the name it goes by everywhere else ("Terminal
        // ttys004"), which is what the menu bar lists it under and what ending it
        // will be called, led by the session's own title where it has one.
        // The tty is stated here and nowhere else in the chain.
        let secondary = PanelStyle.label(
            root.descriptionLine,
            size: 11.5,
            color: PanelStyle.sessionTitleInk
        )
        // The agent's words in italics, ours upright, so a title cannot be
        // mistaken for something varlock is asserting. The quotation marks around
        // it are the mark's own business: it drops them for a name the agent
        // generated rather than one a person typed.
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
        if root.agent?.isTitleDerived == true {
            secondary.toolTip = "This name was generated by "
                + "\(session?.productName ?? "the agent") from the directory it was opened in. "
                + "Nobody typed it."
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

    /// The mark for what was checked about a hop, and its explanation.
    ///
    /// A bare coloured dot used to carry this, which meant it carried nothing: a
    /// green circle is a legend a reader was never given. The shape says the
    /// answer, the tooltip spells out what was and was not checked, and the word
    /// beside it once the chain is opened matches both.
    private func postureMark(
        _ posture: HopPosture,
        subject: String,
        interpreter: String? = nil,
        alwaysShowsWord: Bool = false
    ) -> NSView {
        let mark = PostureMarkView(
            posture: posture,
            explanation: posture.explanation(subject: subject, interpreter: interpreter),
            alwaysShowsWord: alwaysShowsWord
        )
        postureMarks.append(mark)
        mark.setWordVisible(alwaysShowsWord || expanded)
        return mark
    }

    private func expanderView(foldedLabel: String?, insideSession: Bool) -> NSView {
        let label = foldedLabel ?? ""
        let field = PanelStyle.label(collapsedLabel(label), size: 10.5, color: PanelStyle.inkQuiet)
        expander = (field, label)
        let rail = ChainRailView(
            isFirst: false,
            emphasis: .none,
            railAbove: insideSession ? PanelStyle.sessionRail : PanelStyle.chainRail,
            railBelow: insideSession ? PanelStyle.sessionRail : PanelStyle.chainRail
        )
        rails.append(rail)
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
        guard !label.isEmpty else { return "\u{2304} paths, versions, and signatures \u{25B8}" }
        return "\u{2304} \(label) \u{00B7} paths and signatures \u{25B8}"
    }

    private func toggleExpanded(field: NSTextField, label: String) {
        expanded.toggle()
        let closed = label.isEmpty ? "\u{2303} less detail" : "\u{2303} fewer steps"
        field.stringValue = expanded ? closed : collapsedLabel(label)
        applyExpansion()
    }

    private func applyExpansion() {
        for row in foldedRows { row.isHidden = !expanded }
        for row in evidenceRows { row.isHidden = !expanded }
        for mark in postureMarks { mark.setWordVisible(expanded) }
        updateRails()
        onLayoutChanged()
    }

    /// Stop the rail at the last row that is actually on screen.
    ///
    /// The evidence lines under the last hop are hidden at rest, so without this
    /// the bottom row would draw its half of the rail down into nothing.
    private func updateRails() {
        let visible = rails.filter { !isHiddenInColumn($0) }
        for rail in rails { rail.drawsRailBelow = rail !== visible.last }
    }

    /// Whether a rail's own row has been folded away. The rail is the row here,
    /// so this is just its own hidden flag, checked through the view it sits in
    /// so a future wrapper cannot silently break it.
    private func isHiddenInColumn(_ rail: ChainRailView) -> Bool {
        var view: NSView? = rail
        while let current = view, current !== self {
            if current.isHidden { return true }
            view = current.superview
        }
        return false
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

/// The mark saying what was checked about one thing, with the words for it.
///
/// A glyph rather than a dot, because a dot has to be explained and a shield does
/// not: a shield with a tick is something checked out, a warning triangle is
/// something that was not, and a question mark is a process the kernel would not
/// talk about. The tooltip is where the exact claim lives, in full sentences,
/// including what was NOT checked; the short word beside it appears when the
/// chain is opened and always agrees with the shape.
final class PostureMarkView: NSStackView {
    private let word: NSTextField
    private let alwaysShowsWord: Bool

    init(posture: HopPosture, explanation: String, alwaysShowsWord: Bool) {
        let tint: NSColor
        if posture.isVerified {
            tint = PanelStyle.ok
        } else if posture.isCaution {
            tint = PanelStyle.warn
        } else {
            tint = PanelStyle.inkQuiet
        }

        word = PanelStyle.label(posture.inlineLabel, size: 9.5, color: tint)
        word.setContentCompressionResistancePriority(.required, for: .horizontal)
        self.alwaysShowsWord = alwaysShowsWord
        super.init(frame: .zero)

        orientation = .horizontal
        alignment = .centerY
        spacing = 3
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)

        let glyph = NSImageView()
        glyph.image = NSImage(
            systemSymbolName: posture.symbolName,
            accessibilityDescription: posture.inlineLabel
        )?.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 10, weight: .medium))
        glyph.contentTintColor = tint
        glyph.imageScaling = .scaleProportionallyDown
        glyph.setContentHuggingPriority(.required, for: .horizontal)
        glyph.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            glyph.widthAnchor.constraint(equalToConstant: 13),
            glyph.heightAnchor.constraint(equalToConstant: 13),
        ])

        addArrangedSubview(glyph)
        addArrangedSubview(word)
        // On the whole mark, so hovering the shape or the word both answer.
        toolTip = explanation
        glyph.toolTip = explanation
        word.toolTip = explanation
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func setWordVisible(_ visible: Bool) {
        word.isHidden = !(visible || alwaysShowsWord)
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
        /// Not a hop at all (a sub-line, the expander): rail, no dot.
        case none
    }

    private let isFirst: Bool
    private let emphasis: Emphasis
    private let railAbove: NSColor
    private let railBelow: NSColor

    /// Whether the rail continues below this row. Set by the chain rather than
    /// fixed at build time, because which row is last changes when the chain is
    /// opened: the evidence lines under the bottom hop are hidden at rest, and a
    /// rail drawn down to a hidden row is a stub hanging off the last thing on
    /// screen.
    var drawsRailBelow: Bool = true {
        didSet { if drawsRailBelow != oldValue { needsDisplay = true } }
    }

    /// Set when the row is something to click.
    var onClick: (() -> Void)?

    init(isFirst: Bool, emphasis: Emphasis, railAbove: NSColor, railBelow: NSColor) {
        self.isFirst = isFirst
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
        if drawsRailBelow {
            railBelow.setFill()
            NSRect(x: railX - 1, y: bounds.minY, width: 2, height: midY - bounds.minY).fill()
        }

        let side: CGFloat
        let color: NSColor
        switch emphasis {
        // Bright and neutral, never accent: a coloured marker next to a green
        // posture mark reads as a verdict on the process, and this one is about
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
