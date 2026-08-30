import AppKit

/// The one-time "we are setting biometrics up" moment.
///
/// Creating the custody key is the point where varlock starts using Touch ID, and
/// the first time a user meets that should read as setup rather than as an
/// unexplained system prompt appearing out of nowhere. This shows a short panel
/// once, ever, immediately before the first gated key is generated, and then
/// records that it has been shown.
///
/// It is informational on purpose. The key is being created because the user just
/// asked for it, so there is nothing here to approve or refuse; a second button
/// that could only mean "then nothing works" would be theatre. The real consent
/// surface is the unlock panel, which shows up every time something wants the key.
enum FirstRunSetup {
    /// The panel closes itself after this long. `generate-key` runs as a one-shot
    /// under a caller timeout, so an unattended machine must not sit on a modal
    /// until the parent gives up and kills it.
    static let autoDismissSeconds: TimeInterval = 20

    static var markerPath: String {
        let keyStore = SecureEnclaveManager.keyStorePath
        let parent = (keyStore as NSString).deletingLastPathComponent
        return parent + "/.setup-shown"
    }

    static var hasBeenShown: Bool {
        return FileManager.default.fileExists(atPath: markerPath)
    }

    static func markShown() {
        let dir = (markerPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: markerPath, contents: Data())
    }

    /// Show the setup panel if this is the first gated key on this machine.
    ///
    /// Does nothing when the key needs no gate (CI keys created with `--no-auth`),
    /// when a key already exists, when it has been shown before, or when there is
    /// no window server to draw on.
    static func showIfNeeded(requireAuth: Bool) {
        guard requireAuth else { return }
        guard !hasBeenShown else { return }
        guard SecureEnclaveManager.listKeys().isEmpty else {
            // An existing user upgrading into this build has already lived through
            // the prompts. Record it and stay quiet.
            markShown()
            return
        }
        guard UiAvailability.canShowUi() else { return }

        markShown()
        show()
    }

    private static func show() {
        let work = {
            NSApplication.shared.setActivationPolicy(.accessory)

            let alert = NSAlert()
            alert.messageText = "Setting up biometrics for varlock"
            alert.informativeText = """
            varlock is creating an encryption key in this Mac's Secure Enclave. \
            The key never leaves the enclave, and macOS asks for Touch ID (or your \
            password) before anything can use it.

            Next time something needs a secret, varlock will ask you here first, and \
            you can choose to allow it once or for the rest of your session.
            """
            alert.alertStyle = .informational
            alert.addButton(withTitle: "Continue")

            alert.window.level = .floating
            NSApp.activate(ignoringOtherApps: true)

            let deadline = DispatchWorkItem { NSApp.abortModal() }
            DispatchQueue.main.asyncAfter(deadline: .now() + autoDismissSeconds, execute: deadline)
            _ = alert.runModal()
            deadline.cancel()
        }

        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.sync { work() }
        }
    }
}
