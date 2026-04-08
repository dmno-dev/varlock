import AppKit

/// Shows a native macOS dialog with a secure text field for entering secrets.
/// Runs on the main thread and blocks until the user submits or cancels.
final class SecureInputDialog {
    /// Show a secure input dialog and return the entered text, or nil if cancelled.
    static func prompt(title: String, message: String, itemKey: String?) -> String? {
        var result: String?
        let work = {
            // Ensure the app has an Edit menu so Cmd+V/C/X/A work in text fields.
            // NSAlert doesn't create one, so keyboard shortcuts are dead without this.
            ensureEditMenu()

            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = message
            alert.alertStyle = .informational
            alert.addButton(withTitle: "Encrypt")
            alert.addButton(withTitle: "Cancel")

            let inputField = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
            inputField.placeholderString = "Enter or paste secret value..."
            alert.accessoryView = inputField

            // Set the window title to include the item key for context
            let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Varlock"
            alert.window.title = itemKey.map { "\(appName) — \($0)" } ?? appName

            // Bring the app to front so the dialog is visible
            NSApp.activate(ignoringOtherApps: true)

            // Make the input field the first responder after the alert is shown
            alert.window.initialFirstResponder = inputField

            let response = alert.runModal()
            if response == .alertFirstButtonReturn {
                let value = inputField.stringValue
                if !value.isEmpty {
                    result = value
                }
            }
        }

        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.sync { work() }
        }

        return result
    }

    /// Create a minimal Edit menu so standard keyboard shortcuts work.
    /// Safe to call multiple times — only creates the menu once.
    private static var editMenuInstalled = false
    private static func ensureEditMenu() {
        guard !editMenuInstalled else { return }
        editMenuInstalled = true

        let mainMenu = NSApp.mainMenu ?? NSMenu()

        let editMenuItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")

        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)
        NSApp.mainMenu = mainMenu
    }
}
