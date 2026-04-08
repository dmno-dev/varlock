import AppKit

/// Manages the macOS menu bar status item for the Varlock Enclave daemon.
final class StatusBarMenu: NSObject, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private let menu = NSMenu()
    private let sessionManager: SessionManager
    private let onLock: () -> Void
    private let onQuit: () -> Void

    init(
        sessionManager: SessionManager,
        onLock: @escaping () -> Void,
        onQuit: @escaping () -> Void
    ) {
        self.sessionManager = sessionManager
        self.onLock = onLock
        self.onQuit = onQuit
        super.init()
        setupStatusItem()
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        guard let button = statusItem?.button else { return }
        updateIcon()
        let menuTitle = Bundle.main.object(forInfoDictionaryKey: "VarlockMenuTitle") as? String ?? "Varlock Secure Enclave"
        button.toolTip = menuTitle

        menu.delegate = self
        statusItem?.menu = menu
        rebuildMenuItems()
    }

    private func updateIcon() {
        guard let button = statusItem?.button else { return }
        let hasActiveSessions = sessionManager.hasAnySessions()
        button.image = nil
        button.title = hasActiveSessions ? "🔓" : "🔒"
    }

    // NSMenuDelegate — update items and icon each time the menu opens
    func menuWillOpen(_ menu: NSMenu) {
        updateIcon()
        rebuildMenuItems()
    }

    private func rebuildMenuItems() {
        menu.removeAllItems()

        // Header
        let menuTitle = Bundle.main.object(forInfoDictionaryKey: "VarlockMenuTitle") as? String ?? "Varlock Secure Enclave"
        let headerItem = NSMenuItem(title: menuTitle, action: nil, keyEquivalent: "")
        headerItem.isEnabled = false
        menu.addItem(headerItem)

        menu.addItem(NSMenuItem.separator())

        // Lock action — disabled with status text when already locked
        let hasActiveSessions = sessionManager.hasAnySessions()
        if hasActiveSessions {
            let lockItem = NSMenuItem(title: "Lock", action: #selector(lockClicked), keyEquivalent: "l")
            lockItem.target = self
            menu.addItem(lockItem)
        } else {
            let lockedItem = NSMenuItem(title: "Locked", action: nil, keyEquivalent: "")
            lockedItem.isEnabled = false
            menu.addItem(lockedItem)
        }

        menu.addItem(NSMenuItem.separator())

        // Quit
        let quitItem = NSMenuItem(title: "Quit Daemon", action: #selector(quitClicked), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
    }

    @objc private func lockClicked() {
        onLock()
        updateIcon()
    }

    @objc private func quitClicked() {
        onQuit()
    }

    /// Call from any thread after a session state change to update the icon
    func refresh() {
        // Use performSelector to ensure the update runs in the next run loop iteration
        // on the main thread — more reliable than DispatchQueue.main.async with NSApplication
        performSelector(onMainThread: #selector(doRefresh), with: nil, waitUntilDone: false)
    }

    @objc private func doRefresh() {
        updateIcon()
    }

    func remove() {
        if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
            statusItem = nil
        }
    }
}
