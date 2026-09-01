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
///
/// Every icon in the chain is drawn in a square box of one size. App icons are
/// square already; a document icon is page-shaped, and a monogram is whatever we
/// draw. Fitting each one inside the same square, rather than resizing it TO a
/// square, is what keeps a page from being stretched into a stamp and keeps the
/// rows on the rail lined up whatever mix of art a chain happens to carry.
enum PanelIcons {
    /// The side of that box, everywhere in the chain.
    static let side: CGFloat = 16

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
    /// In order: the app's own icon, the agent's, varlock's own mark, the script
    /// file's icon as the system draws it, a drop-in for a known tool, a tile
    /// with the tool's initials, and for a shell the terminal symbol. Resolution
    /// can touch LaunchServices and the disk, so callers do it after the panel is
    /// up: see `PanelIconView`.
    static func icon(for hop: ExecutionHop) -> NSImage? {
        if let bundlePath = hop.bundlePath, let icon = appIcon(bundlePath: bundlePath) {
            return icon
        }
        if let session = hop.agentSession {
            return agentIcon(productName: session.productName)
        }
        // varlock is in every chain and is the one program in it the panel can
        // speak for, so it wears its own mark rather than a generic binary.
        if hop.isVarlock { return varlockHopMark() }
        // A script is what the values are actually for, and its file's own icon
        // is the fastest way to recognise it. Read from the resolved path so the
        // registered handler answers for the real file.
        if hop.via != nil {
            guard let scriptPath = hop.scriptPath else { return genericDocument() }
            return fileIcon(path: scriptPath) ?? genericDocument()
        }
        let name = executableName(for: hop)
        if let dropIn = toolDropIn(named: name) { return dropIn }
        if let monogram = monogramIcon(forTool: name) { return monogram }
        if isShell(name) { return symbol("terminal", tint: PanelStyle.inkTertiary) }
        return nil
    }

    /// A real app icon, when the path is a bundle that exists.
    static func appIcon(bundlePath: String) -> NSImage? {
        return fileIcon(path: bundlePath)
    }

    /// Whatever the system draws for a file: the type's icon plus whatever the
    /// registered handler contributes.
    ///
    /// Always asked about a PATH, never about an extension or a type derived from
    /// one. `UTType(filenameExtension: "ts")` answers `public.mpeg-2-transport-stream`
    /// on a stock machine, so an extension lookup can hand back a video icon for
    /// a TypeScript file.
    static func fileIcon(path: String) -> NSImage? {
        if let cached = cache[path] { return cached }
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let icon = fitted(NSWorkspace.shared.icon(forFile: path))
        cache[path] = icon
        return icon
    }

    /// varlock's own mark at chain-row size.
    ///
    /// The app icon rather than the menu bar art: the menu bar marks are template
    /// images meant to be tinted by the menu bar, and dropped onto the panel's own
    /// background they read as a grey smudge. The app icon is the same mark the
    /// Dock and the panel's header already use, in colour, and it is legible at
    /// 16pt.
    private static func varlockHopMark() -> NSImage? {
        if let cached = cache["varlock-hop"] { return cached }
        guard let image = bundledResource(named: "AppIcon", extension: "icns")
            ?? NSImage(systemSymbolName: "lock.fill", accessibilityDescription: "varlock") else {
            return nil
        }
        let mark = fitted(image)
        cache["varlock-hop"] = mark
        return mark
    }

    /// The plain page a script gets when its file cannot be found: honest about
    /// there being a file, silent about what kind. Never a guess from the name.
    private static func genericDocument() -> NSImage? {
        return symbol("doc", tint: PanelStyle.inkTertiary)
    }

    /// The artwork centred on a square canvas, scaled to fit and never squashed.
    ///
    /// Every icon this returns is the same square, whatever shape it arrived as.
    /// That matters because the shapes genuinely differ: an app icon is square, a
    /// document icon is page shaped, and an SF Symbol is usually wider than it is
    /// tall. Returning their natural rectangles left glyph rows visibly smaller
    /// than the app rows beside them, so the canvas is the constant and the
    /// artwork is what varies inside it.
    private static func fitted(_ image: NSImage, box: CGFloat = side) -> NSImage {
        let natural = image.size
        guard natural.width > 0, natural.height > 0 else {
            // Nothing to scale by: hand back an empty square so the row still
            // lines up with its neighbours.
            return NSImage(size: NSSize(width: box, height: box))
        }
        let scale = box / max(natural.width, natural.height)
        let drawn = NSSize(width: natural.width * scale, height: natural.height * scale)
        let canvas = NSImage(size: NSSize(width: box, height: box))
        canvas.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        // Drawn from the source rather than mutated in place: NSWorkspace hands
        // back images it also holds, and resizing one of those resizes it for
        // everybody who asked.
        image.draw(
            in: NSRect(
                x: (box - drawn.width) / 2,
                y: (box - drawn.height) / 2,
                width: drawn.width,
                height: drawn.height
            ),
            from: .zero,
            operation: .sourceOver,
            fraction: 1
        )
        canvas.unlockFocus()
        return canvas
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
        let sized = fitted(image)
        cache["tool:\(name)"] = sized
        return sized
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
        // Squared like everything else: symbols are typically wider than they are
        // tall, and a bare one sat visibly short next to the app icons above it.
        let tinted = fitted(tintedCopy(configured, tint: tint))
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
///
/// The box is always square and always the same size, whatever turns up in it.
/// The view owns that, not the image: art arrives at every shape and size (app
/// icons square, document icons page-shaped, SF Symbols whatever they please),
/// and a row whose icon is a different width from its neighbour's throws the
/// whole rail out. So the frame is pinned, the artwork is scaled to fit inside
/// it, and it is centred; nothing is ever stretched or cropped to fill.
final class PanelIconView: NSImageView {
    init(side: CGFloat, placeholder: NSImage?, resolve: @escaping () -> NSImage?) {
        super.init(frame: .zero)
        image = placeholder
        imageScaling = .scaleProportionallyUpOrDown
        imageAlignment = .alignCenter
        imageFrameStyle = .none
        translatesAutoresizingMaskIntoConstraints = false
        // The stack view around this one distributes slack, and an icon is not
        // where slack should go.
        setContentHuggingPriority(.required, for: .horizontal)
        setContentHuggingPriority(.required, for: .vertical)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .vertical)
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
