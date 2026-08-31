import AppKit
import IdentitySessions

/// The panel's own Touch ID glyph, and the only thing on the panel that moves.
///
/// It exists because the system's `LAAuthenticationView` draws nothing here, so
/// without this the panel would show an empty square while asking for a
/// fingerprint. The system view is layered over this one, so if it ever does
/// render, its animation wins and ours is never seen.
///
/// This type only turns a `PanelGlyphEffect` into animation. Which effect applies
/// is decided in `PanelGlyph`, from the flow's state, so the glyph cannot end up
/// breathing at a moment when nothing is actually listening to the sensor.
///
/// Core Animation throughout rather than `NSSymbolEffect`, which needs macOS 14
/// while this package targets 13. One mechanism that works everywhere beats two
/// that have to be kept in step.
final class TouchIDGlyphView: NSView {
    /// Resting colour. The system's own Touch ID art is in the pink and red
    /// family, so ours matches rather than using the accent colour, which was
    /// never a brand decision. One line to change if that turns out to be wrong.
    static let restingColor: NSColor = .systemPink
    static let successColor: NSColor = .systemGreen

    /// How faint the glyph sits when nothing is armed. Carries the whole
    /// idle-versus-armed distinction when motion is turned off.
    static let restingOpacity: Float = 0.6

    private let imageView = NSImageView()
    private var currentEffect: PanelGlyphEffect = .still

    private enum AnimationKey {
        static let pulse = "varlock.glyph.pulse"
        static let shake = "varlock.glyph.shake"
        static let pop = "varlock.glyph.pop"
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setUp()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setUp()
    }

    private func setUp() {
        wantsLayer = true
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.image = NSImage(systemSymbolName: "touchid", accessibilityDescription: "Touch ID")
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.contentTintColor = Self.restingColor
        imageView.wantsLayer = true
        addSubview(imageView)
        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: trailingAnchor),
            imageView.topAnchor.constraint(equalTo: topAnchor),
            imageView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    /// Scale has to grow from the middle, and an AppKit backing layer does not
    /// necessarily anchor there. Fixing it on layout keeps the pop centred.
    override func layout() {
        super.layout()
        guard let layer = imageView.layer else { return }
        let centre = CGPoint(x: 0.5, y: 0.5)
        if layer.anchorPoint != centre {
            layer.anchorPoint = centre
            layer.position = CGPoint(x: imageView.bounds.midX, y: imageView.bounds.midY)
        }
    }

    func apply(_ effect: PanelGlyphEffect) {
        guard effect != currentEffect || effect == .shakeThenStill else { return }
        currentEffect = effect
        guard let layer = imageView.layer else { return }
        layer.removeAnimation(forKey: AnimationKey.pulse)

        switch effect {
        case .still:
            // Dim: nothing is listening. Without motion this is the only thing
            // separating "idle" from "armed", so the two must not look alike.
            imageView.contentTintColor = Self.restingColor
            layer.opacity = Self.restingOpacity
        case .armedStill:
            // Reduce motion: say "listening" with full strength rather than
            // movement.
            imageView.contentTintColor = Self.restingColor
            layer.opacity = 1
        case .pulse:
            imageView.contentTintColor = Self.restingColor
            layer.opacity = 1
            startPulse(on: layer)
        case .shakeThenStill:
            imageView.contentTintColor = Self.restingColor
            layer.opacity = 1
            shake(layer)
        case .failedStill:
            imageView.contentTintColor = .secondaryLabelColor
            layer.opacity = 1
        case .successPop:
            imageView.contentTintColor = Self.successColor
            layer.opacity = 1
            pop(layer)
        case .successStill:
            imageView.contentTintColor = Self.successColor
            layer.opacity = 1
        }
    }

    // MARK: - The animations

    /// Slow breathing, well short of a flash. This sits in a floating panel that
    /// may be on screen for a while, so it stays quiet enough to ignore.
    private func startPulse(on layer: CALayer) {
        let opacity = CABasicAnimation(keyPath: "opacity")
        opacity.fromValue = 1.0
        opacity.toValue = 0.55

        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 1.0
        scale.toValue = 1.06

        let group = CAAnimationGroup()
        group.animations = [opacity, scale]
        group.duration = 1.1
        group.autoreverses = true
        group.repeatCount = .infinity
        group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer.add(group, forKey: AnimationKey.pulse)
    }

    /// The short horizontal shake the system uses for a rejected fingerprint.
    private func shake(_ layer: CALayer) {
        let shake = CAKeyframeAnimation(keyPath: "transform.translation.x")
        shake.values = [0, -6, 6, -4, 4, -2, 2, 0]
        shake.keyTimes = [0, 0.12, 0.28, 0.44, 0.6, 0.76, 0.9, 1]
        shake.duration = 0.42
        shake.timingFunction = CAMediaTimingFunction(name: .easeOut)
        layer.add(shake, forKey: AnimationKey.shake)
    }

    /// A small confirmation before the panel closes, so an approval reads as
    /// finished rather than as the window disappearing.
    private func pop(_ layer: CALayer) {
        let pop = CAKeyframeAnimation(keyPath: "transform.scale")
        pop.values = [1.0, 1.18, 1.0]
        pop.keyTimes = [0, 0.45, 1]
        pop.duration = 0.28
        pop.timingFunction = CAMediaTimingFunction(name: .easeOut)
        layer.add(pop, forKey: AnimationKey.pop)
    }

    /// How long the success animation wants before the panel closes over it.
    static let successHoldSeconds: TimeInterval = 0.32

    /// Whether the system asks us not to animate.
    static var reduceMotion: Bool {
        return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }
}
