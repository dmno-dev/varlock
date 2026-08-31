import AppKit
import IdentitySessions

/// The approval panel's look, in one place.
///
/// The panel commits to a dark chrome rather than following the system
/// appearance. It is not a document window: it is an interruption that has to be
/// recognisable at a glance as varlock asking, whatever is behind it, and a
/// panel that changes colour with the user's theme is one more thing an
/// impostor could get right by accident.
enum PanelStyle {
    /// Inner width of the panel's content, matching the design.
    static let contentWidth: CGFloat = 340
    static let contentInset: CGFloat = 20

    static let panelBackground = color(0x21_21_25)
    static let panelBorder = color(0x38_38_3E)

    static let ink = color(0xE9_E9_EC)
    static let inkSecondary = color(0x9A_9A_A1)
    static let inkTertiary = color(0x8F_8F_97)
    static let inkQuiet = color(0x6F_6F_76)
    static let wordmark = color(0xC6_C6_CC)

    static let cardBackground = color(0x24_24_28)
    static let cardBorder = color(0x32_32_38)
    static let cardDivider = color(0x2E_2E_34)
    static let chipBackground = color(0x2D_2D_33)
    static let chipInk = color(0xC2_C2_C8)

    static let chainBackground = color(0x28_28_2C)
    static let chainBorder = color(0x35_35_3B)
    static let chainRail = color(0x38_38_3E)
    static let chainDot = color(0x4A_4A_52)

    static let accent = color(0xFF_5D_73)
    static let vaultLocal = color(0x4A_72_D8)
    static let warn = color(0xD9_A2_4A)
    static let ok = color(0x57_B0_6A)
    static let agentBadgeInk = color(0xB4_8C_E8)
    static let agentBadgeBackground = color(0x33_28_3F)
    static let agentBadgeBorder = color(0x47_36_5C)

    static let primaryButton = color(0x2F_6F_ED)
    static let primaryButtonPressed = color(0x27_5C_C8)
    static let ghostButton = color(0x2F_2F_35)
    static let ghostButtonPressed = color(0x3A_3A_42)
    static let ghostButtonBorder = color(0x3D_3D_44)
    static let segmentTrack = color(0x2B_2B_30)
    static let segmentTrackBorder = color(0x3A_3A_41)

    static func color(_ rgb: UInt32) -> NSColor {
        return NSColor(
            srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }

    /// A client-supplied `#rrggbb`, or nil. Only the exact form is accepted; the
    /// parse already happened once when the payload was read, and this is the
    /// second half of the same refusal to trust a colour string.
    static func color(hex: String?) -> NSColor? {
        guard let hex, hex.count == 7, hex.hasPrefix("#") else { return nil }
        guard let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        return color(value)
    }

    // MARK: - Text

    static func label(
        _ text: String,
        size: CGFloat,
        color: NSColor = ink,
        weight: NSFont.Weight = .regular,
        mono: Bool = false
    ) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = mono
            ? NSFont.monospacedSystemFont(ofSize: size, weight: weight)
            : NSFont.systemFont(ofSize: size, weight: weight)
        field.textColor = color
        field.lineBreakMode = .byTruncatingTail
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    /// A heading whose key names are drawn as identifiers.
    static func heading(_ segments: [PanelTextSegment], size: CGFloat) -> NSTextField {
        let string = NSMutableAttributedString()
        for segment in segments {
            let font: NSFont
            switch segment {
            case .plain:
                font = NSFont.systemFont(ofSize: size, weight: .semibold)
            case .code:
                font = NSFont.monospacedSystemFont(ofSize: size - 0.5, weight: .semibold)
            }
            string.append(NSAttributedString(
                string: segment.text,
                attributes: [.font: font, .foregroundColor: ink]
            ))
        }
        let field = NSTextField(labelWithAttributedString: string)
        field.alignment = .center
        field.lineBreakMode = .byTruncatingTail
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    // MARK: - Boxes

    /// A rounded card, the shape the panel groups things in.
    static func card(background: NSColor = cardBackground, border: NSColor = cardBorder) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = background.cgColor
        view.layer?.borderColor = border.cgColor
        view.layer?.borderWidth = 1
        view.layer?.cornerRadius = 10
        view.layer?.masksToBounds = true
        return view
    }

    /// A small filled square: the vault's identity mark, and the only place a
    /// vault colour is ever used.
    static func swatch(_ color: NSColor, side: CGFloat = 6) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = color.cgColor
        view.layer?.cornerRadius = 2
        view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            view.widthAnchor.constraint(equalToConstant: side),
            view.heightAnchor.constraint(equalToConstant: side),
        ])
        return view
    }

    /// A pill around a value name.
    static func chip(_ text: String) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = chipBackground.cgColor
        view.layer?.cornerRadius = 4
        let field = label(text, size: 10.5, color: chipInk, mono: true)
        field.translatesAutoresizingMaskIntoConstraints = false
        field.setContentCompressionResistancePriority(.required, for: .horizontal)
        view.addSubview(field)
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 6),
            field.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -6),
            field.topAnchor.constraint(equalTo: view.topAnchor, constant: 1),
            field.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -1),
        ])
        return view
    }

    /// A flexible gap in a horizontal stack.
    static func spacer() -> NSView {
        let view = NSView()
        view.setContentHuggingPriority(.init(1), for: .horizontal)
        view.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        return view
    }

    static func row(spacing: CGFloat, alignment: NSLayoutConstraint.Attribute = .centerY) -> NSStackView {
        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.alignment = alignment
        stack.spacing = spacing
        return stack
    }

    static func column(spacing: CGFloat, alignment: NSLayoutConstraint.Attribute = .leading) -> NSStackView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = alignment
        stack.spacing = spacing
        return stack
    }
}
