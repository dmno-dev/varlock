import AppKit
import LocalAuthentication
import LocalAuthenticationEmbeddedUI
import IdentitySessions

/// The panel's own buttons and segmented control.
///
/// AppKit's stock controls follow the system appearance and the system's idea of
/// hierarchy, and this panel commits to neither: it is drawn dark, its primary
/// action is a wide bar carrying a live Touch ID glyph, and its refusal is a
/// quiet ghost button. Drawing them here is what lets the approve action and the
/// scan be one object rather than two things sitting near each other.

/// A view whose whole area is the click target.
///
/// AppKit hands a click to the deepest view under the pointer, and an
/// `NSTextField` swallows it rather than passing it on. Every row on this panel
/// is mostly text, so without this the clickable parts were the gaps between the
/// words: the vault row looked expandable and did nothing when you clicked its
/// name.
protocol PanelClickTarget: NSView {}

extension PanelClickTarget {
    func clickTargetHitTest(_ point: NSPoint) -> NSView? {
        guard let superview else { return nil }
        return bounds.contains(convert(point, from: superview)) ? self : nil
    }
}

/// A flat, layer-drawn button.
final class PanelButton: NSControl, PanelClickTarget {
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

    override func hitTest(_ point: NSPoint) -> NSView? {
        return isEnabled ? clickTargetHitTest(point) : nil
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

/// The approve action, with the sensor in it.
///
/// It reads as the panel's primary button and it is also the scan surface: the
/// system's own `LAAuthenticationView` sits in the glyph slot, and touching the
/// sensor approves without anyone clicking anything.
///
/// Outlined rather than filled, and that is not a taste decision.
/// `render-bisect.ts` measured the pixels for each arrangement:
///
///   sensor alone in a plain holder                  51 greys, drawn
///   sensor and label in a plain holder              51 greys, drawn
///   this control, outline only, beside Deny         51 greys, drawn
///   the same control with a layer-backed fill        4 greys, blank
///   the same control with the fill drawn in code     4 greys, blank
///
/// So the rule is: no paint of ours may cover the sensor's own rectangle. A fill
/// behind it blanks it, whether the fill is a layer or a `draw(_:)` call, while
/// an outline (which never crosses that rectangle) leaves it alone. The mock's
/// solid blue bar is therefore not available; a blue outline in the same shape,
/// with the same label, is as close as the platform allows.
///
/// Deliberately an `NSView` and not an `NSControl`: inside an `NSButton` the auth
/// view drew nothing either, for the same reason.
final class PanelScanButton: NSView, PanelClickTarget {
    /// The system's view. Kept so the panel can photograph it and prove it drew.
    private(set) var scanView: NSView!

    private let onClick: () -> Void
    private var pressed = false

    /// `context` is nil only in a preview, which has no sensor to bind to and
    /// gets our drawn glyph in the same slot: a picture of where the live one goes.
    init(title: String, context: LAContext?, onClick: @escaping () -> Void) {
        self.onClick = onClick
        super.init(frame: .zero)

        // The fill is drawn by a sibling BEHIND the content, not by this view, so
        // nothing in the auth view's ancestry is a layer-backed rounded box. That
        // arrangement is under test: the view drew nothing when its parent owned
        // a background layer.
        let authView: NSView
        if let context {
            authView = LAAuthenticationView(context: context, controlSize: .large)
        } else {
            let placeholder = TouchIDGlyphView()
            placeholder.apply(.still)
            authView = placeholder
        }
        authView.translatesAutoresizingMaskIntoConstraints = false
        scanView = authView

        let label = PanelStyle.label(
            title,
            size: 13,
            color: PanelStyle.ink,
            weight: .semibold
        )
        label.translatesAutoresizingMaskIntoConstraints = false
        label.setContentCompressionResistancePriority(.required, for: .horizontal)

        // Both placed directly, with no stack view between the auth view and this
        // one. Under test: whether being an arranged subview is what stops it
        // drawing, since every arrangement that has ever rendered had it as a
        // plain subview with constraints of its own.
        addSubview(authView)
        addSubview(label)

        NSLayoutConstraint.activate([
            authView.widthAnchor.constraint(equalToConstant: 48),
            authView.heightAnchor.constraint(equalToConstant: 48),
            authView.centerYAnchor.constraint(equalTo: centerYAnchor),
            authView.trailingAnchor.constraint(equalTo: label.leadingAnchor, constant: -10),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            // The pair sits centred as a unit, the way a button's content does.
            authView.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 14),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -14),
            authView.centerXAnchor.constraint(
                equalTo: centerXAnchor,
                constant: -24 - 5
            ).withPriority(.defaultHigh),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 56),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The fill, drawn rather than layered.
    ///
    /// Same shape, no backing layer of its own: under test as the way to keep the
    /// button's look without the sensor going blank inside it.
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let inset = bounds.insetBy(dx: 1, dy: 1)
        let path = NSBezierPath(roundedRect: inset, xRadius: 8, yRadius: 8)
        path.lineWidth = pressed ? 2.5 : 1.5
        (pressed ? PanelStyle.primaryButtonPressed : PanelStyle.primaryButton).setStroke()
        path.stroke()
    }

    private func applyBackground() {
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        pressed = true
        applyBackground()
    }

    override func mouseUp(with event: NSEvent) {
        pressed = false
        applyBackground()
        guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        onClick()
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }
}

private extension NSLayoutConstraint {
    /// Reads better than three lines of mutation at the call site.
    func withPriority(_ priority: NSLayoutConstraint.Priority) -> NSLayoutConstraint {
        self.priority = priority
        return self
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
final class PanelSegmentButton: NSView, PanelClickTarget {
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
        field.font = NSFont.systemFont(ofSize: 12, weight: .regular)
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

    /// Selection is colour, never weight.
    ///
    /// A bolder label is a wider label, so bolding the selected segment moved the
    /// control (and everything under it) by a few points every time the user
    /// changed their mind. Nothing about a toggle should reflow a panel.
    private func applyTitle() {
        field.stringValue = titleText
        field.textColor = selected ? .white : PanelStyle.ink
    }

    override func mouseUp(with event: NSEvent) {
        guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        onClick(self)
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        return clickTargetHitTest(point)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }
}

/// A row that toggles something open, and says so by rotating a chevron.
final class PanelDisclosureRow: NSView, PanelClickTarget {
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

    override func hitTest(_ point: NSPoint) -> NSView? {
        return clickTargetHitTest(point)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }
}
