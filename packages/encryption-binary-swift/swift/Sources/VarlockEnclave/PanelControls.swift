import AppKit
import IdentitySessions

/// The panel's own buttons and segmented control.
///
/// AppKit's stock controls follow the system appearance and the system's idea of
/// hierarchy, and this panel commits to neither: it is drawn dark, its primary
/// action is a wide bar carrying a live Touch ID glyph, and its refusal is a
/// quiet ghost button. Drawing them here is what lets the approve action and the
/// scan be one object rather than two things sitting near each other.

/// A flat, layer-drawn button.
final class PanelButton: NSControl {
    enum Style {
        case primary
        /// The refusal: red on a tinted ground, with a stop mark.
        case deny
        /// An underlined text link, for the secondary way through.
        case link
    }

    private let style: Style
    private let titleField: NSTextField
    private let contentRow = NSStackView()
    private var pressed = false
    /// Set for the primary button on a machine that can scan.
    private(set) var glyphView: TouchIDGlyphView?

    var title: String {
        get { titleField.stringValue }
        set {
            titleField.stringValue = newValue
            needsLayout = true
        }
    }

    init(title: String, style: Style, glyph: PanelButtonGlyph = .none, target: AnyObject?, action: Selector) {
        self.style = style
        let size: CGFloat = style == .link ? 11.5 : 13
        let weight: NSFont.Weight = style == .primary ? .semibold : .regular
        let color: NSColor
        switch style {
        case .primary: color = .white
        case .deny: color = PanelStyle.denyInk
        case .link: color = PanelStyle.inkTertiary
        }
        titleField = PanelStyle.label(title, size: size, color: color, weight: weight)
        super.init(frame: .zero)
        self.target = target
        self.action = action

        wantsLayer = true
        layer?.cornerRadius = style == .link ? 0 : 8
        applyBackground()

        contentRow.orientation = .horizontal
        contentRow.alignment = .centerY
        contentRow.spacing = 9
        contentRow.translatesAutoresizingMaskIntoConstraints = false
        contentRow.setContentHuggingPriority(.required, for: .horizontal)

        switch glyph {
        case .none:
            break
        case .touchID:
            let view = TouchIDGlyphView()
            view.setBaseTint(.white)
            view.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                view.widthAnchor.constraint(equalToConstant: 20),
                view.heightAnchor.constraint(equalToConstant: 20),
            ])
            glyphView = view
            contentRow.addArrangedSubview(view)
        case .lock:
            let image = NSImageView()
            image.image = NSImage(systemSymbolName: "lock.fill", accessibilityDescription: nil)
            image.contentTintColor = .white
            image.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                image.widthAnchor.constraint(equalToConstant: 15),
                image.heightAnchor.constraint(equalToConstant: 17),
            ])
            contentRow.addArrangedSubview(image)
        case .stop:
            let image = NSImageView()
            image.image = NSImage(systemSymbolName: "xmark.circle", accessibilityDescription: nil)
            image.contentTintColor = PanelStyle.denyInk
            image.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                image.widthAnchor.constraint(equalToConstant: 13),
                image.heightAnchor.constraint(equalToConstant: 13),
            ])
            contentRow.addArrangedSubview(image)
        }

        if style == .link {
            titleField.attributedStringValue = NSAttributedString(
                string: title,
                attributes: [
                    .font: NSFont.systemFont(ofSize: size),
                    .foregroundColor: PanelStyle.inkTertiary,
                    .underlineStyle: NSUnderlineStyle.single.rawValue,
                ]
            )
        }
        contentRow.addArrangedSubview(titleField)
        addSubview(contentRow)

        let vertical: CGFloat = style == .link ? 0 : 8
        let horizontal: CGFloat = style == .link ? 0 : 16
        NSLayoutConstraint.activate([
            contentRow.centerXAnchor.constraint(equalTo: centerXAnchor),
            contentRow.centerYAnchor.constraint(equalTo: centerYAnchor),
            contentRow.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: horizontal),
            contentRow.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -horizontal),
            contentRow.topAnchor.constraint(equalTo: topAnchor, constant: vertical),
            contentRow.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -vertical),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    enum PanelButtonGlyph {
        case none
        /// The breathing fingerprint, which is also the scan affordance.
        case touchID
        /// A static padlock, for a machine with no sensor to breathe about.
        case lock
        /// A circled cross, on the refusal.
        case stop
    }

    private func applyBackground() {
        switch style {
        case .primary:
            layer?.backgroundColor = (pressed ? PanelStyle.primaryButtonPressed : PanelStyle.primaryButton).cgColor
            layer?.borderWidth = 0
        case .deny:
            layer?.backgroundColor = (pressed ? PanelStyle.denyButtonPressed : PanelStyle.denyButton).cgColor
            layer?.borderColor = PanelStyle.denyButtonBorder.cgColor
            layer?.borderWidth = 1
        case .link:
            layer?.backgroundColor = NSColor.clear.cgColor
            layer?.borderWidth = 0
        }
        alphaValue = isEnabled ? 1 : 0.5
    }

    override var isEnabled: Bool {
        didSet { applyBackground() }
    }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        pressed = true
        applyBackground()
    }

    override func mouseUp(with event: NSEvent) {
        guard isEnabled else { return }
        pressed = false
        applyBackground()
        if bounds.contains(convert(event.locationInWindow, from: nil)) {
            sendAction(action, to: target)
        }
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override var intrinsicContentSize: NSSize {
        let fitting = contentRow.fittingSize
        switch style {
        case .link:
            return fitting
        default:
            return NSSize(width: fitting.width + 32, height: max(34, fitting.height + 16))
        }
    }
}

/// The scope choice, drawn as a pill of segments.
///
/// A stock `NSSegmentedControl` would follow the system appearance and cannot
/// carry the duration caret inside the selected segment, which is where the
/// design puts it: picking a window and seeing which window you picked are the
/// same control.
final class PanelSegmentedControl: NSView {
    private var buttons: [PanelSegmentButton] = []
    private(set) var selectedIndex = 0
    private let onChange: (Int) -> Void
    /// Called when the segment that is already selected is clicked again, which
    /// is how the duration menu is reopened.
    private let onReselect: (Int, NSView) -> Void

    init(
        labels: [String],
        selectedIndex: Int,
        onChange: @escaping (Int) -> Void,
        onReselect: @escaping (Int, NSView) -> Void = { _, _ in }
    ) {
        self.onChange = onChange
        self.onReselect = onReselect
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = PanelStyle.segmentTrack.cgColor
        layer?.borderColor = PanelStyle.segmentTrackBorder.cgColor
        layer?.borderWidth = 1
        layer?.cornerRadius = 8

        let row = PanelStyle.row(spacing: 0)
        row.translatesAutoresizingMaskIntoConstraints = false
        for (index, title) in labels.enumerated() {
            let button = PanelSegmentButton(title: title) { [weak self] view in
                self?.handleClick(index: index, view: view)
            }
            buttons.append(button)
            row.addArrangedSubview(button)
        }
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
        ])
        select(index: selectedIndex, notify: false)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func handleClick(index: Int, view: NSView) {
        if index == selectedIndex {
            onReselect(index, view)
            return
        }
        select(index: index, notify: true)
    }

    func select(index: Int, notify: Bool) {
        guard index >= 0, index < buttons.count else { return }
        selectedIndex = index
        for (position, button) in buttons.enumerated() {
            button.setSelected(position == index)
        }
        if notify { onChange(index) }
    }

    /// Change one segment's words, which is how "For a set time" becomes
    /// "For 4 hours" once a window has been chosen.
    func setTitle(_ title: String, at index: Int) {
        guard index >= 0, index < buttons.count else { return }
        buttons[index].setTitle(title)
    }

    func view(at index: Int) -> NSView? {
        guard index >= 0, index < buttons.count else { return nil }
        return buttons[index]
    }
}

/// One segment of the scope control.
final class PanelSegmentButton: NSView {
    private let field = PanelStyle.label("", size: 12, color: PanelStyle.ink)
    private let onClick: (NSView) -> Void
    private var titleText: String
    private var selected = false

    init(title: String, onClick: @escaping (NSView) -> Void) {
        self.onClick = onClick
        self.titleText = title
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 6
        field.stringValue = title
        field.alignment = .center
        field.translatesAutoresizingMaskIntoConstraints = false
        field.setContentCompressionResistancePriority(.required, for: .horizontal)
        addSubview(field)
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 11),
            field.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -11),
            field.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            field.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func setTitle(_ title: String) {
        titleText = title
        applyTitle()
    }

    func setSelected(_ isSelected: Bool) {
        selected = isSelected
        layer?.backgroundColor = (isSelected ? PanelStyle.vaultLocal : NSColor.clear).cgColor
        applyTitle()
    }

    private func applyTitle() {
        field.stringValue = titleText
        field.font = NSFont.systemFont(ofSize: 12, weight: selected ? .semibold : .regular)
        field.textColor = selected ? .white : PanelStyle.ink
    }

    override func mouseUp(with event: NSEvent) {
        guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        onClick(self)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }
}

/// A row that toggles something open, and says so by rotating a chevron.
final class PanelDisclosureRow: NSView {
    private let onToggle: (Bool) -> Void
    private(set) var isOpen = false
    private let chevron: NSTextField

    init(content: NSView, chevron: NSTextField, isOpen: Bool = false, onToggle: @escaping (Bool) -> Void) {
        self.onToggle = onToggle
        self.chevron = chevron
        self.isOpen = isOpen
        super.init(frame: .zero)
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor),
            content.trailingAnchor.constraint(equalTo: trailingAnchor),
            content.topAnchor.constraint(equalTo: topAnchor),
            content.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        applyChevron()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func applyChevron() {
        chevron.stringValue = isOpen ? "\u{25BE}" : "\u{25B8}"
    }

    override func mouseUp(with event: NSEvent) {
        guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        isOpen.toggle()
        applyChevron()
        onToggle(isOpen)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }
}
