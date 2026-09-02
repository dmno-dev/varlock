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

/// The approve action, which is the sensor and its label.
///
/// It sits where the primary action goes, beside Deny, and it is also the scan
/// surface: the system's own `LAAuthenticationView` is the fingerprint, and
/// touching the sensor approves without anyone clicking anything. Clicking the
/// label asks again, for a scan that did not take.
///
/// Nothing is drawn behind it, and that is not a taste decision.
/// `render-bisect.ts` measured the pixels for each arrangement:
///
///   sensor alone in a plain holder                  51 greys, drawn
///   sensor and label in a plain holder              51 greys, drawn
///   the same pair inside an outlined box            51 greys, drawn
///   the same box with a layer-backed fill            4 greys, blank
///   the same box with the fill drawn in code         4 greys, blank
///
/// So the rule is: no paint of ours may cover the sensor's own rectangle. A fill
/// behind it blanks it, whether the fill is a layer or a `draw(_:)` call. The
/// mock's solid blue bar is therefore not available at all, and the outline that
/// stood in for it was a box around a fingerprint that read as neither. What is
/// left is the honest version: the live sensor at its own size with the words
/// beside it, and the panel's ground showing through.
///
/// Deliberately an `NSView` and not an `NSControl`: inside an `NSButton` the auth
/// view drew nothing either, for the same reason.
final class PanelScanButton: NSView, PanelClickTarget {
    /// The system's view. Kept so the panel can photograph it and prove it drew.
    private(set) var scanView: NSView!

    private let onClick: () -> Void
    private let label: NSTextField

    /// The sensor's own drawn size. `LAAuthenticationView` renders at a size per
    /// control size (mini 16, small 32, regular 64, large 128), so the small one
    /// is asked for rather than a large one squeezed: a scaled-down fingerprint
    /// is a blurry fingerprint.
    static let sensorSide: CGFloat = 32

    /// `context` is nil only in a preview, which has no sensor to bind to and
    /// gets our drawn glyph in the same slot: a picture of where the live one goes.
    init(title: String, context: LAContext?, onClick: @escaping () -> Void) {
        self.onClick = onClick
        label = PanelStyle.label(title, size: 13, color: PanelStyle.ink, weight: .semibold)
        super.init(frame: .zero)

        let authView: NSView
        if let context {
            authView = LAAuthenticationView(context: context, controlSize: .small)
        } else {
            let placeholder = TouchIDGlyphView()
            placeholder.apply(.still)
            authView = placeholder
        }
        authView.translatesAutoresizingMaskIntoConstraints = false
        scanView = authView

        label.translatesAutoresizingMaskIntoConstraints = false
        label.setContentCompressionResistancePriority(.required, for: .horizontal)

        // Both placed directly, with no stack view between the auth view and this
        // one: every arrangement that has ever rendered had it as a plain subview
        // with constraints of its own.
        addSubview(authView)
        addSubview(label)

        // A layout guide rather than a container view, so the pair can be centred
        // as a unit without anything existing behind the sensor.
        let pair = NSLayoutGuide()
        addLayoutGuide(pair)

        NSLayoutConstraint.activate([
            authView.widthAnchor.constraint(equalToConstant: Self.sensorSide),
            authView.heightAnchor.constraint(equalToConstant: Self.sensorSide),
            authView.centerYAnchor.constraint(equalTo: centerYAnchor),
            authView.trailingAnchor.constraint(equalTo: label.leadingAnchor, constant: -9),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            pair.leadingAnchor.constraint(equalTo: authView.leadingAnchor),
            pair.trailingAnchor.constraint(equalTo: label.trailingAnchor),
            pair.centerXAnchor.constraint(equalTo: centerXAnchor).withPriority(.defaultHigh),
            authView.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            // Tall enough that the sensor is never clipped, and no taller: this
            // row sits next to a 34pt Deny button.
            heightAnchor.constraint(greaterThanOrEqualToConstant: Self.sensorSide + 6),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Pressed state lives in the label's ink.
    ///
    /// Everything else a button does to say "pressed" is paint, and paint is the
    /// one thing that must not happen around this view.
    private func setPressed(_ pressed: Bool) {
        label.textColor = pressed ? PanelStyle.inkSecondary : PanelStyle.ink
    }

    override func mouseDown(with event: NSEvent) {
        setPressed(true)
    }

    override func mouseUp(with event: NSEvent) {
        setPressed(false)
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

    init(
        labels: [String],
        selectedIndex: Int,
        onChange: @escaping (Int) -> Void
    ) {
        self.onChange = onChange
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
        // Clicking what is already selected does nothing. It used to reopen the
        // duration menu; there is no menu now, and a control that fires on a
        // click that changes nothing is a control that can surprise somebody.
        guard index != selectedIndex else { return }
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

/// The breadth control: one checkbox, ticked for the broad answer.
///
/// Drawn here rather than taken from `NSButton(checkboxWithTitle:)` for the same
/// reason everything else on this panel is: a stock checkbox follows the system
/// appearance, and this window commits to its own.
///
/// The whole row is the target, label included. A checkbox whose 15 points of
/// box are the only place a click lands is a checkbox people miss, and this one
/// sits directly under the control that decides how long a grant lasts, where a
/// missed click reads as the panel ignoring you.
final class PanelCheckbox: NSView, PanelClickTarget {
    private(set) var isChecked: Bool
    private let onChange: (Bool) -> Void
    private let box = NSView()
    private let tick = NSImageView()
    private let field: NSTextField

    init(title: String, isChecked: Bool, onChange: @escaping (Bool) -> Void) {
        self.isChecked = isChecked
        self.onChange = onChange
        field = PanelStyle.label(title, size: 12, color: PanelStyle.ink)
        super.init(frame: .zero)

        box.wantsLayer = true
        box.layer?.cornerRadius = 4
        box.layer?.borderWidth = 1
        box.translatesAutoresizingMaskIntoConstraints = false

        tick.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)
        tick.contentTintColor = .white
        tick.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(tick)

        field.translatesAutoresizingMaskIntoConstraints = false
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 2
        field.setContentCompressionResistancePriority(.required, for: .horizontal)

        addSubview(box)
        addSubview(field)

        NSLayoutConstraint.activate([
            box.widthAnchor.constraint(equalToConstant: 15),
            box.heightAnchor.constraint(equalToConstant: 15),
            box.leadingAnchor.constraint(equalTo: leadingAnchor),
            box.centerYAnchor.constraint(equalTo: centerYAnchor),
            tick.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            tick.centerYAnchor.constraint(equalTo: box.centerYAnchor),
            tick.widthAnchor.constraint(equalToConstant: 10),
            tick.heightAnchor.constraint(equalToConstant: 10),
            field.leadingAnchor.constraint(equalTo: box.trailingAnchor, constant: 8),
            field.trailingAnchor.constraint(equalTo: trailingAnchor),
            field.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(greaterThanOrEqualTo: field.heightAnchor),
        ])
        applyState()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Set the state without telling anyone, for building the panel.
    func setChecked(_ checked: Bool) {
        isChecked = checked
        applyState()
    }

    private func applyState() {
        box.layer?.backgroundColor = (isChecked ? PanelStyle.vaultLocal : NSColor.clear).cgColor
        box.layer?.borderColor = (isChecked ? PanelStyle.vaultLocal : PanelStyle.segmentTrackBorder).cgColor
        tick.isHidden = !isChecked
    }

    override func mouseUp(with event: NSEvent) {
        guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        isChecked.toggle()
        applyState()
        onChange(isChecked)
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        return clickTargetHitTest(point)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }
}
