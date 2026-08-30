import Foundation
import AppKit
import CoreGraphics

/// Whether this process can actually put a window in front of a human.
///
/// The daemon is the trusted display, so an approval it cannot draw is an
/// approval it must refuse. Over SSH, or from a launchd job with no console
/// session, there is no window server to draw on: the honest answer is to fail
/// with `NO_UI` and let the client fall back to telling the user in the terminal.
/// Silently skipping the panel would turn a consent surface into a rubber stamp.
enum UiAvailability {
    /// Forces the answer to "no window server" for tests and for the headless
    /// end-to-end run. It can only ever make the daemon refuse more, never less,
    /// so it is safe to honour from the environment.
    static let modeEnvVar = "_VARLOCK_UI_MODE"

    /// Treats every unlock as if its key were presence gated, so the panel path
    /// can be exercised against a `--no-auth` key in tests. Also strictly a
    /// tightening: it adds a question, it never removes one.
    static let forcePromptEnvVar = "_VARLOCK_FORCE_UNLOCK_PROMPT"

    static var isHeadlessForced: Bool {
        return ProcessInfo.processInfo.environment[modeEnvVar] == "headless"
    }

    static var isPromptForced: Bool {
        let value = ProcessInfo.processInfo.environment[forcePromptEnvVar]
        return value == "1" || value == "true"
    }

    /// True when there is a graphical login session attached to this process.
    static func canShowUi() -> Bool {
        if isHeadlessForced { return false }
        return CGSessionCopyCurrentDictionary() != nil
    }
}
