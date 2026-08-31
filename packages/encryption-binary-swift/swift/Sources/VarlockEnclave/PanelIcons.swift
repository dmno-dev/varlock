import AppKit
import SessionScoping

/// The small pictures on the panel: varlock's own mark, and one per hop.
///
/// An icon is the fastest way a person recognises their own terminal in the
/// chain, so where a real one exists we use the real one: the app's icon,
/// straight from its bundle. Where there is no bundle to ask (a CLI on the path,
/// an interpreter in a version manager's directory) we draw a small tile with the
/// tool's initials rather than shipping a logo we would have to keep in step with
/// somebody else's branding.
///
/// A drop-in beats both: anything in `Resources/tool-icons/<name>.png` wins, so a
/// proper icon set can be added later without touching this code.
enum PanelIcons {
    /// Icons are cheap but not free: LaunchServices can hit disk on a cold cache.
    /// Nothing here is ever on the path that draws the panel.
    private static var cache: [String: NSImage] = [:]

    // MARK: - varlock's own mark

    /// The app's icon, which is the same mark the menu bar and the Dock use.
    ///
    /// Drawn from the bundle when the daemon is running as the shipped app, and
    /// from the source tree when it is a development build, so the panel looks
    /// the same in the demo as it does in the field.
    static func varlockMark() -> NSImage? {
        if let cached = cache["varlock-mark"] { return cached }
        let image = bundledResource(named: "AppIcon", extension: "icns")
            ?? NSImage(systemSymbolName: "lock.fill", accessibilityDescription: "varlock")
        if let image {
            image.size = NSSize(width: 20, height: 20)
            cache["varlock-mark"] = image
        }
        return image
    }

    // MARK: - Hops

    /// The icon for one hop, or nil when there is nothing worth drawing.
    ///
    /// In order: the app's own icon, a drop-in for a known tool, a tile with the
    /// tool's initials, and for a shell the terminal symbol. Resolution can touch
    /// LaunchServices, so callers do it after the panel is up.
    static func icon(for hop: ExecutionHop) -> NSImage? {
        if let bundlePath = hop.bundlePath, let icon = appIcon(bundlePath: bundlePath) {
            return icon
        }
        if let session = hop.agentSession {
            return agentIcon(productName: session.productName)
        }
        let name = executableName(for: hop)
        if let dropIn = toolDropIn(named: name) { return dropIn }
        if let monogram = monogramIcon(forTool: name) { return monogram }
        if isShell(name) { return symbol("terminal", tint: PanelStyle.inkTertiary) }
        return nil
    }

    /// A real app icon, when the path is a bundle that exists.
    static func appIcon(bundlePath: String) -> NSImage? {
        if let cached = cache[bundlePath] { return cached }
        guard FileManager.default.fileExists(atPath: bundlePath) else { return nil }
        let icon = NSWorkspace.shared.icon(forFile: bundlePath)
        icon.size = NSSize(width: 16, height: 16)
        cache[bundlePath] = icon
        return icon
    }

    /// The agent's own app icon when it is installed, and its initial otherwise.
    ///
    /// The CLI a session runs under has no bundle of its own, so the icon has to
    /// come from the app that ships alongside it.
    private static func agentIcon(productName: String) -> NSImage? {
        for path in agentAppPaths[productName] ?? [] {
            if let icon = appIcon(bundlePath: path) { return icon }
        }
        return monogram(
            String(productName.prefix(1)),
            background: PanelStyle.sessionRail,
            ink: PanelStyle.sessionInk
        )
    }

    /// Where each agent's own app lives, when it has one.
    private static let agentAppPaths: [String: [String]] = [
        "Claude Code": ["/Applications/Claude.app", NSHomeDirectory() + "/Applications/Claude.app"],
    ]

    /// The tool this hop is, whatever it is running: `bun` for a script under bun.
    private static func executableName(for hop: ExecutionHop) -> String {
        if let via = hop.via, via.hasPrefix("via ") { return String(via.dropFirst(4)) }
        if let path = hop.path, !path.isEmpty { return (path as NSString).lastPathComponent }
        return hop.name
    }

    // MARK: - Tools

    /// A drop-in icon for a tool, if one has been added to the bundle.
    ///
    /// Nothing ships here today: a logo is somebody else's asset to keep current,
    /// and a stale one is worse than a tile. The lookup exists so a proper set can
    /// be dropped in without a code change.
    private static func toolDropIn(named name: String) -> NSImage? {
        if let cached = cache["tool:\(name)"] { return cached }
        guard let image = bundledResource(named: "tool-icons/\(name)", extension: "png") else { return nil }
        image.size = NSSize(width: 16, height: 16)
        cache["tool:\(name)"] = image
        return image
    }

    /// The tools worth drawing a tile for, with the colour each is known by.
    ///
    /// One or two characters: a tile this small is read as a mark, not as a word,
    /// and four letters at 16pt is a smudge.
    private static let toolTiles: [String: (label: String, tint: UInt32)] = [
        "bun": ("b", 0xF2_E4_D2),
        "node": ("n", 0x6C_C2_4A),
        "deno": ("d", 0xE5_E5_EA),
        "python": ("py", 0x4B_8B_BE),
        "python3": ("py", 0x4B_8B_BE),
        "ruby": ("rb", 0xCC_34_2D),
        "perl": ("pl", 0x9B_8A_C4),
        "tsx": ("ts", 0x31_78_C6),
        "ts-node": ("ts", 0x31_78_C6),
    ]

    private static func monogramIcon(forTool name: String) -> NSImage? {
        guard let tile = toolTiles[name] else { return nil }
        return monogram(
            tile.label,
            background: PanelStyle.chipBackground,
            ink: PanelStyle.color(tile.tint)
        )
    }

    private static func isShell(_ name: String) -> Bool {
        return ["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "login"].contains(name)
    }

    /// The last-resort mark: a terminal, which is where a request without any
    /// other identity came from.
    static func genericTerminal() -> NSImage? {
        return symbol("terminal", tint: PanelStyle.inkQuiet)
    }

    // MARK: - Drawing

    private static func symbol(_ name: String, tint: NSColor) -> NSImage? {
        if let cached = cache["symbol:\(name)"] { return cached }
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return nil }
        let configured = image.withSymbolConfiguration(
            NSImage.SymbolConfiguration(pointSize: 12, weight: .regular)
        ) ?? image
        let tinted = tintedCopy(configured, tint: tint)
        cache["symbol:\(name)"] = tinted
        return tinted
    }

    private static func tintedCopy(_ image: NSImage, tint: NSColor) -> NSImage {
        let copy = NSImage(size: image.size, flipped: false) { rect in
            image.draw(in: rect)
            tint.set()
            rect.fill(using: .sourceAtop)
            return true
        }
        return copy
    }

    /// A small rounded tile carrying a tool's initials. Reads as an icon at 16pt
    /// while being ours to draw, which a borrowed logo would not be.
    private static func monogram(_ text: String, background: NSColor, ink: NSColor) -> NSImage {
        let key = "monogram:\(text):\(background.description):\(ink.description)"
        if let cached = cache[key] { return cached }
        let side: CGFloat = 16
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            let tile = NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4)
            background.setFill()
            tile.fill()

            let attributes: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: text.count > 1 ? 8 : 10, weight: .bold),
                .foregroundColor: ink,
            ]
            let string = NSAttributedString(string: text.lowercased(), attributes: attributes)
            let size = string.size()
            string.draw(at: NSPoint(
                x: rect.midX - size.width / 2,
                y: rect.midY - size.height / 2
            ))
            return true
        }
        cache[key] = image
        return image
    }

    // MARK: - Finding resources

    /// A resource from the app bundle, falling back to the source tree.
    ///
    /// A development build is a bare executable with no bundle around it, so
    /// without the fallback every icon would be missing in exactly the situation
    /// where the panel is being looked at on purpose: the demo.
    ///
    /// Shared with the menu bar, which has the same problem and used to solve it
    /// by not using our artwork at all.
    static func bundledResource(named name: String, extension ext: String) -> NSImage? {
        if let url = Bundle.main.url(forResource: name, withExtension: ext),
           let image = NSImage(contentsOf: url) {
            return image
        }
        var directory = URL(fileURLWithPath: Bundle.main.bundlePath)
        for _ in 0..<6 {
            let candidate = directory
                .appendingPathComponent("resources")
                .appendingPathComponent(name)
                .appendingPathExtension(ext)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return NSImage(contentsOf: candidate)
            }
            directory = directory.deletingLastPathComponent()
        }
        return nil
    }
}

/// An image view that fills itself in once the panel is already up.
///
/// Resolving an icon can go to LaunchServices, and nothing about a picture is
/// worth delaying an approval for. This draws a placeholder immediately and
/// replaces it from the run loop, which for a cached icon is the same frame and
/// for a cold one is a moment later.
final class PanelIconView: NSImageView {
    init(side: CGFloat, placeholder: NSImage?, resolve: @escaping () -> NSImage?) {
        super.init(frame: .zero)
        image = placeholder
        imageScaling = .scaleProportionallyUpOrDown
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: side),
            heightAnchor.constraint(equalToConstant: side),
        ])
        MainLoop.perform { [weak self] in
            guard let self, let resolved = resolve() else { return }
            self.image = resolved
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}
