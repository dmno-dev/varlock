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

/// The "how long" choice, drawn as a pill of segments.
///
/// A stock `NSSegmentedControl` would follow the system appearance, and this
/// panel commits to its own whatever the user's theme is set to. Segments size
/// to their own labels rather than to the widest one, which is what lets a
/// ladder from "Once" to "This session" sit on one row: padding "1hr" out to the
/// width of "This session" would spend most of the panel on space.
final class PanelSegmentedControl: NSView {
    private var buttons: [PanelSegmentButton] = []
    private(set) var selectedIndex = 0
    private let onChange: (Int) -> Void
    /// A click on the rung that is already selected. Not a change, so it must
    /// never be reported as one; the custom rung uses it to put the caret back
    /// in its field.
    private let onReselect: ((Int) -> Void)?

    init(
        labels: [String],
        selectedIndex: Int,
        onChange: @escaping (Int) -> Void,
        onReselect: ((Int) -> Void)? = nil
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
        // Clicking what is already selected does not change the answer: a
        // control that fires a change on a click that changes nothing is a
        // control that can surprise somebody, on a panel where a surprise is an
        // approval. It is still a click, and a rung that has something to open
        // gets told about it.
        guard index != selectedIndex else {
            onReselect?(index)
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
}

/// One rung of the "how long" control.
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

/// The custom rung's value: a number, and the unit it is in.
///
/// Typed rather than stepped, which is a decision with a cost this control has
/// to pay for. The sensor is live the whole time this field has focus, and a
/// scan approves with no click, so a half-typed number must never become an
/// approval for something other than what the panel is showing. Three rules
/// carry that:
///
///   1. There is no committed value hiding behind the field. `liveValue` is a
///      clamped reading of the text as it stands at this instant, and it is what
///      the panel grants; the summary sentence is rewritten from it on every
///      keystroke. A finger landing mid-word approves what is on screen. Partial
///      numbers are prefixes, so a scan during typing can only ever land shorter
///      than what was being aimed at, never longer.
///   2. Return commits and gets out of the way. It does not reach the panel's
///      confirm handler, because a key that means "done editing" must not also
///      mean "unlock". Escape is left alone to refuse the whole panel, which is
///      what it does everywhere else here.
///   3. Nothing is ever invalid. See `CustomDuration`: empty, zero, nonsense and
///      over the cap all read as the nearest legal window, and the field is
///      rewritten to the clamped value when editing ends. There is no error
///      state, so there is no way to leave the panel holding an answer it cannot
///      act on.
///
/// Notably NOT solved by disarming the sensor while the field has focus. Arming
/// is the part of this panel with the longest bug history, and a rule that says
/// "grant what is displayed" needs no state machine to be right.
final class PanelDurationField: NSView, NSTextFieldDelegate {
    private let amountField = NSTextField()
    private let amountBox = NSView()
    private let capLabel: NSTextField
    private var unitControl: PanelSegmentedControl!
    /// Any change to the value, typed or through the unit toggle.
    private let onChange: () -> Void
    /// Escape, which is a refusal of the panel and not of the field.
    private let onCancel: () -> Void
    private(set) var unit: DurationUnit

    /// What the panel would grant if a finger landed right now.
    var liveValue: CustomDuration {
        return CustomDuration.parse(amountField.stringValue, unit: unit)
    }

    init(
        value: CustomDuration,
        onChange: @escaping () -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.onChange = onChange
        self.onCancel = onCancel
        self.unit = value.unit
        capLabel = PanelStyle.label("", size: 11, color: PanelStyle.inkTertiary)
        super.init(frame: .zero)

        amountBox.wantsLayer = true
        amountBox.layer?.backgroundColor = PanelStyle.segmentTrack.cgColor
        amountBox.layer?.cornerRadius = 8
        amountBox.layer?.borderWidth = 1
        amountBox.translatesAutoresizingMaskIntoConstraints = false

        // Drawn in the panel's chrome like everything else here: no bezel, no
        // background of its own, no focus ring. A stock field would be the one
        // control on this window that follows the system's appearance.
        amountField.isBordered = false
        amountField.drawsBackground = false
        amountField.focusRingType = .none
        amountField.isEditable = true
        amountField.isSelectable = true
        amountField.usesSingleLineMode = true
        amountField.cell?.wraps = false
        amountField.cell?.isScrollable = true
        // Tabular figures, so the number does not jitter sideways as digits are
        // typed and deleted under a live sensor.
        amountField.font = NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .regular)
        amountField.textColor = PanelStyle.ink
        amountField.alignment = .center
        amountField.delegate = self
        amountField.stringValue = String(value.amount)
        amountField.translatesAutoresizingMaskIntoConstraints = false
        amountBox.addSubview(amountField)

        addSubview(amountBox)

        let unitControl = PanelSegmentedControl(
            labels: DurationUnit.allCases.map { $0.suffix },
            selectedIndex: DurationUnit.allCases.firstIndex(of: value.unit) ?? 0
        ) { [weak self] index in
            self?.unitChanged(to: DurationUnit.allCases[index])
        }
        unitControl.translatesAutoresizingMaskIntoConstraints = false
        self.unitControl = unitControl
        addSubview(unitControl)

        capLabel.alignment = .left
        capLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(capLabel)

        NSLayoutConstraint.activate([
            amountBox.leadingAnchor.constraint(equalTo: leadingAnchor),
            amountBox.centerYAnchor.constraint(equalTo: centerYAnchor),
            // Wide enough for three digits, which is every number this field can
            // hold, so the box never resizes around its own contents.
            amountBox.widthAnchor.constraint(equalToConstant: 54),
            amountBox.heightAnchor.constraint(equalToConstant: 26),
            amountField.leadingAnchor.constraint(equalTo: amountBox.leadingAnchor, constant: 6),
            amountField.trailingAnchor.constraint(equalTo: amountBox.trailingAnchor, constant: -6),
            amountField.centerYAnchor.constraint(equalTo: amountBox.centerYAnchor),
            unitControl.leadingAnchor.constraint(equalTo: amountBox.trailingAnchor, constant: 8),
            unitControl.centerYAnchor.constraint(equalTo: centerYAnchor),
            capLabel.leadingAnchor.constraint(equalTo: unitControl.trailingAnchor, constant: 12),
            capLabel.trailingAnchor.constraint(equalTo: trailingAnchor),
            capLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
            // The cap is said in whichever unit is showing, so its text changes
            // with the toggle. Sized for the longer of the two once, or the row
            // would re-centre itself every time somebody switched units.
            capLabel.widthAnchor.constraint(equalToConstant: Self.capLabelWidth),
            heightAnchor.constraint(greaterThanOrEqualTo: amountBox.heightAnchor),
        ])
        applyCapLabel()
        setFocusedLook(false)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Room for `max 720min`, which is the wider of the two things it says.
    private static let capLabelWidth: CGFloat = {
        let font = NSFont.systemFont(ofSize: 11)
        let widest = DurationUnit.allCases
            .map { PanelContent.customDurationCapLabel(unit: $0) }
            .map { ($0 as NSString).size(withAttributes: [.font: font]).width }
            .max() ?? 0
        return ceil(widest) + 1
    }()

    /// Show the value the panel would actually act on.
    ///
    /// Called when editing ends rather than on every keystroke: rewriting `80`
    /// to `72` under somebody's fingers as they reach for the `0` of `800` is
    /// the kind of help nobody asked for. Until then the clamp is applied to the
    /// VALUE and said out loud in the summary sentence, so the panel is honest
    /// about what it would grant even while the text is not yet legal.
    func commit() {
        amountField.stringValue = String(liveValue.amount)
    }

    /// Put the caret in the field, for a click on the rung that opens it.
    func focusField() {
        window?.makeFirstResponder(amountField)
    }

    /// The focused look, as a border rather than a system focus ring.
    ///
    /// Exposed so a preview can render the focused state: the panel is checked
    /// by looking at pictures of it, and a state only reachable by clicking is a
    /// state nobody checks.
    func setFocusedLook(_ focused: Bool) {
        amountBox.layer?.borderColor = (focused ? PanelStyle.vaultLocal : PanelStyle.segmentTrackBorder).cgColor
    }

    private func applyCapLabel() {
        capLabel.stringValue = PanelContent.customDurationCapLabel(unit: unit)
    }

    /// Switching units converts the window, never rereads the number.
    ///
    /// 90 minutes becomes one hour, not ninety hours. `CustomDuration.converted`
    /// owns the rounding and the re-clamp; this only has to show the answer.
    private func unitChanged(to newUnit: DurationUnit) {
        let converted = liveValue.converted(to: newUnit)
        unit = newUnit
        amountField.stringValue = String(converted.amount)
        applyCapLabel()
        onChange()
    }

    // MARK: - NSTextFieldDelegate

    func controlTextDidChange(_ obj: Notification) {
        onChange()
    }

    func controlTextDidBeginEditing(_ obj: Notification) {
        setFocusedLook(true)
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        setFocusedLook(false)
        commit()
        onChange()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.insertNewline(_:)):
            // Return means "I am done with this number". It must not fall
            // through to the window, where Return approves.
            commit()
            onChange()
            window?.makeFirstResponder(window)
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            // Escape refuses the panel, exactly as it does with the field
            // unfocused. A field that swallowed it would leave somebody pressing
            // Escape at an approval prompt and watching nothing happen.
            onCancel()
            return true
        default:
            return false
        }
    }
}
