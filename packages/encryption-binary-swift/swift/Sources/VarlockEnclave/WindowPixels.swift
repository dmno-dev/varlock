import AppKit
import CoreGraphics

/// Did that view actually draw anything?
///
/// Counting subviews and layer contents does not answer it: `LAAuthenticationView`
/// has both whether or not a fingerprint appears, which is how an earlier round of
/// this investigation talked itself into "it renders" while a person was looking
/// at an empty square. The only honest answer comes from the pixels.
///
/// So this photographs our own window and counts how many distinct greys a region
/// contains. A blank region is one flat colour; anything Apple actually drew is
/// dozens. That turns "does the inline prompt render" from a question only eyes
/// can answer into one a bisection can run unattended.
///
/// Needs screen-recording permission to see window contents, which is reported
/// alongside the count rather than assumed: a zero from a denied permission and a
/// zero from a blank view must never look the same.
enum WindowPixels {
    struct Sample {
        /// Distinct luminance values found. 0 means nothing could be read.
        let distinctGreys: Int
        /// Whether the system let us photograph the window at all.
        let permitted: Bool
        /// What was measured, in window coordinates, for the record.
        let rect: String

        var asDictionary: [String: Any] {
            return ["distinctGreys": distinctGreys, "screenCapturePermitted": permitted, "rect": rect]
        }

        /// Enough variation that something was drawn. A flat fill and a one-pixel
        /// border both stay well under this.
        var looksDrawn: Bool { permitted && distinctGreys >= 8 }
    }

    /// Photograph `view`'s area of its own window and count the greys in it.
    static func sample(_ view: NSView) -> Sample {
        let permitted = CGPreflightScreenCaptureAccess()
        guard let window = view.window else {
            return Sample(distinctGreys: 0, permitted: permitted, rect: "<no window>")
        }
        let inWindow = view.convert(view.bounds, to: nil)
        let rectLabel = "\(Int(inWindow.origin.x)),\(Int(inWindow.origin.y)) "
            + "\(Int(inWindow.width))x\(Int(inWindow.height))"
        guard permitted, inWindow.width > 1, inWindow.height > 1 else {
            return Sample(distinctGreys: 0, permitted: permitted, rect: rectLabel)
        }

        let windowId = CGWindowID(window.windowNumber)
        guard let image = CGWindowListCreateImage(
            .null,
            .optionIncludingWindow,
            windowId,
            [.boundsIgnoreFraming, .nominalResolution]
        ) else {
            return Sample(distinctGreys: 0, permitted: permitted, rect: rectLabel)
        }

        // The captured image is top-left origin; AppKit window coordinates are
        // bottom-left. Flipping here rather than at the call site keeps the
        // caller's rect in the coordinates it already thinks in.
        let scale = CGFloat(image.width) / max(window.frame.width, 1)
        let flippedY = window.frame.height - inWindow.origin.y - inWindow.height
        let cropRect = CGRect(
            x: inWindow.origin.x * scale,
            y: flippedY * scale,
            width: inWindow.width * scale,
            height: inWindow.height * scale
        ).integral
        guard let cropped = image.cropping(to: cropRect) else {
            return Sample(distinctGreys: 0, permitted: permitted, rect: rectLabel)
        }

        return Sample(
            distinctGreys: countGreys(in: cropped),
            permitted: permitted,
            rect: rectLabel
        )
    }

    private static func countGreys(in image: CGImage) -> Int {
        let width = min(image.width, 96)
        let height = min(image.height, 96)
        guard width > 0, height > 0 else { return 0 }

        var pixels = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return 0 }

        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return Set(pixels).count
    }
}
