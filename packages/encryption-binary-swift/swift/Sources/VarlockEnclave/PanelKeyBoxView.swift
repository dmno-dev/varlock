import AppKit
import IdentitySessions
import SessionScoping

/// "What do they get": one card, one row per key.
///
/// The row answers the question at a glance (which key, which vault, how many
/// values) and opens to the value names grouped by the file that defined them.
/// That detail is client-reported, and the footnote inside the open row says so:
/// the daemon has no way to know what an env value is called, and pretending
/// otherwise would put the panel's own credibility behind a caller's strings.
final class PanelKeyBoxView: NSView {
    private let onLayoutChanged: () -> Void

    init(rows: [PanelKeyRow], onLayoutChanged: @escaping () -> Void) {
        self.onLayoutChanged = onLayoutChanged
        super.init(frame: .zero)

        let card = PanelStyle.card()
        card.translatesAutoresizingMaskIntoConstraints = false
        addSubview(card)
        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            card.trailingAnchor.constraint(equalTo: trailingAnchor),
            card.topAnchor.constraint(equalTo: topAnchor),
            card.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        let column = PanelStyle.column(spacing: 0)
        column.alignment = .leading
        column.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            column.topAnchor.constraint(equalTo: card.topAnchor),
            column.bottomAnchor.constraint(equalTo: card.bottomAnchor),
        ])

        for (index, row) in rows.enumerated() {
            if index > 0 { column.addArrangedSubview(divider()) }
            column.addArrangedSubview(keyRow(row))
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func divider() -> NSView {
        let line = NSView()
        line.wantsLayer = true
        line.layer?.backgroundColor = PanelStyle.cardDivider.cgColor
        line.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            line.heightAnchor.constraint(equalToConstant: 1),
            line.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth),
        ])
        return line
    }

    private func keyRow(_ row: PanelKeyRow) -> NSView {
        let column = PanelStyle.column(spacing: 0)
        column.translatesAutoresizingMaskIntoConstraints = false

        let head = PanelStyle.row(spacing: 8)
        head.addArrangedSubview(PanelStyle.label(
            row.displayName,
            size: 12.5,
            color: PanelStyle.ink,
            weight: .semibold,
            mono: true
        ))
        if let vaultLabel = row.vaultLabel {
            let tag = PanelStyle.row(spacing: 5)
            tag.addArrangedSubview(PanelStyle.swatch(
                PanelStyle.color(hex: row.vaultColor) ?? PanelStyle.vaultLocal
            ))
            tag.addArrangedSubview(PanelStyle.label(vaultLabel, size: 10.5, color: PanelStyle.inkTertiary))
            head.addArrangedSubview(tag)
        }
        if let note = row.note {
            head.addArrangedSubview(PanelStyle.label(note, size: 10.5, color: PanelStyle.warn))
        }
        head.addArrangedSubview(PanelStyle.spacer())
        if let count = row.valueCountLabel {
            head.addArrangedSubview(PanelStyle.label(count, size: 11.5, color: PanelStyle.inkTertiary))
        }

        let headBox = NSView()
        head.translatesAutoresizingMaskIntoConstraints = false
        headBox.addSubview(head)
        NSLayoutConstraint.activate([
            head.leadingAnchor.constraint(equalTo: headBox.leadingAnchor, constant: 12),
            head.trailingAnchor.constraint(equalTo: headBox.trailingAnchor, constant: -12),
            head.topAnchor.constraint(equalTo: headBox.topAnchor, constant: 8),
            head.bottomAnchor.constraint(equalTo: headBox.bottomAnchor, constant: -8),
            headBox.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth),
        ])

        guard row.isExpandable else {
            column.addArrangedSubview(headBox)
            return column
        }

        // A row with something behind it says so, and opening it is what shows
        // the value names.
        let chevron = PanelStyle.label("\u{25B8}", size: 10, color: PanelStyle.inkQuiet)
        head.addArrangedSubview(chevron)

        let body = valueList(row)
        body.isHidden = true

        let disclosure = PanelDisclosureRow(content: headBox, chevron: chevron) { [weak self] isOpen in
            body.isHidden = !isOpen
            self?.onLayoutChanged()
        }
        disclosure.translatesAutoresizingMaskIntoConstraints = false
        column.addArrangedSubview(disclosure)
        column.addArrangedSubview(body)
        NSLayoutConstraint.activate([
            disclosure.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth),
        ])
        return column
    }

    /// The open row: value names, grouped by the file that defined them.
    private func valueList(_ row: PanelKeyRow) -> NSView {
        let column = PanelStyle.column(spacing: 5)
        column.translatesAutoresizingMaskIntoConstraints = false

        for file in row.files where !file.valueNames.isEmpty {
            let heading = file.path.map { path in
                let count = file.valueNames.count
                return "\(path) \u{00B7} \(count == 1 ? "1 value" : "\(count) values")"
            }
            if let heading {
                column.addArrangedSubview(PanelStyle.label(
                    heading,
                    size: 10.5,
                    color: PanelStyle.inkTertiary,
                    mono: true
                ))
            }
            column.addArrangedSubview(WrappingChipView(
                names: file.valueNames,
                maxWidth: PanelStyle.contentWidth - 24
            ))
        }
        column.addArrangedSubview(PanelStyle.label(
            PanelContent.valueSourceFootnote,
            size: 10,
            color: PanelStyle.inkQuiet
        ))

        let box = NSView()
        box.addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 12),
            column.trailingAnchor.constraint(lessThanOrEqualTo: box.trailingAnchor, constant: -12),
            column.topAnchor.constraint(equalTo: box.topAnchor, constant: 2),
            column.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -11),
            box.widthAnchor.constraint(equalToConstant: PanelStyle.contentWidth),
        ])
        return box
    }
}

/// Value-name chips, wrapped onto as many lines as they need.
///
/// Auto layout has no flow container, and a horizontal stack would push a long
/// list off the panel, so the wrapping is worked out here from each chip's
/// fitting size.
final class WrappingChipView: NSView {
    init(names: [String], maxWidth: CGFloat) {
        super.init(frame: .zero)
        let column = PanelStyle.column(spacing: 4)
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            column.topAnchor.constraint(equalTo: topAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        var line = PanelStyle.row(spacing: 6)
        var lineWidth: CGFloat = 0
        for name in names {
            let chip = PanelStyle.chip(name)
            let width = chip.fittingSize.width
            if lineWidth > 0, lineWidth + width + 6 > maxWidth {
                column.addArrangedSubview(line)
                line = PanelStyle.row(spacing: 6)
                lineWidth = 0
            }
            line.addArrangedSubview(chip)
            lineWidth += width + 6
        }
        if !line.arrangedSubviews.isEmpty { column.addArrangedSubview(line) }
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}
