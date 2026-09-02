import Foundation

/// What the panel says when the values were encrypted the old way.
///
/// Before unlock sessions, values were encrypted straight to this Mac's device
/// key. That path has no grant table behind it: there is no session to scope, no
/// item set to narrow to, and nothing to remember, so it gets none of the
/// ladder, the breadth checkbox or the memory. What it does have is the same
/// panel frame, because a path to a secret that does not say who is asking is
/// the thing this window exists to remove.
///
/// Two things it has to be honest about, and neither is a control.
///
/// The window is not `once`. macOS is asked to reuse one scan for
/// `SessionManager.sessionTimeout`, so approving here lets reads continue
/// without another prompt for up to that long. The panel used to say "Allowed
/// for: once" over a note admitting "a few minutes", which is the panel
/// contradicting itself about the one number that matters. It says the real
/// number now, as a fact rather than as an option, because the user has no say
/// in it: the reuse window belongs to macOS and this path cannot set it.
///
/// And it is a state somebody can leave: these values stay in the old format
/// until they are re-encrypted, so every install lands here on upgrade and a
/// partially upgraded project draws BOTH panels in one load. Saying so, and
/// doing something about it, is deliberately not here yet. This type is only
/// about the panel not lying, which is true whatever the way out turns out to
/// be.
public enum LegacyDeviceKeyPanel {
    /// The window this approval really carries, said in the slot where the
    /// ladder would be.
    ///
    /// "Up to", because the reuse is a ceiling and not a promise: the scan may
    /// be re-asked for sooner, and a line reading "for 5 minutes" would be
    /// claiming a guarantee nobody made. The number comes from the constant that
    /// is actually sent to macOS, so the copy cannot drift away from it.
    public static func windowFactLine(reuse: TimeInterval) -> String {
        return "Allowed for up to \(DurationText.prose(milliseconds(reuse)))"
    }

    /// What this format is, and who owns the window it grants.
    public static func formatNote(reuse: TimeInterval) -> String {
        return "These values are encrypted to this Mac's device key, the format varlock used "
            + "before unlock sessions. macOS reuses one scan for up to "
            + "\(DurationText.prose(milliseconds(reuse))) on this path, which varlock cannot set "
            + "or shorten from here."
    }

    private static func milliseconds(_ reuse: TimeInterval) -> Int64 {
        return Int64((reuse * 1000).rounded())
    }
}
