import AppKit
import IdentitySessions

/// Manages the macOS menu bar status item for the Varlock Enclave daemon.
///
/// The icon is the passive part: closed lock when the daemon is holding nothing,
/// open lock while any session is unlocked. Everything else is built when the
/// menu opens, from `SessionMenuModel`, which is where the wording lives and
/// where it is tested. Nothing here ticks: an open menu is a snapshot, and the
/// next one is a fresh read.
final class StatusBarMenu: NSObject, NSMenuDelegate {

    /// What the menu needs from the rest of the daemon. Closures rather than the
    /// managers themselves, so this file never reaches into session state.
    struct Actions {
        /// Live grants, re-read every time the menu opens.
        var liveGrants: () -> [SessionGrantInfo]
        /// Erase everything, whatever each session's policy says.
        var lockAll: () -> Void
        /// Erase one session.
        var lockSession: (String) -> Void
        /// The machine-wide default, as the config file currently has it.
        var currentLockPolicy: () -> SessionLockPolicy
        /// Write the machine-wide default back. Throws so a config file that
        /// cannot be edited is reported rather than silently ignored.
        var setLockPolicy: (SessionLockPolicy) throws -> Void
        var quit: () -> Void
    }

    private var statusItem: NSStatusItem?
    private let menu = NSMenu()
    private let sessionManager: SessionManager
    private let actions: Actions

    init(sessionManager: SessionManager, actions: Actions) {
        self.sessionManager = sessionManager
        self.actions = actions
        super.init()
        setupStatusItem()
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        guard let button = statusItem?.button else { return }
        updateIcon()
        button.toolTip = Self.menuTitle

        menu.delegate = self
        statusItem?.menu = menu
        rebuildMenuItems()
    }

    private static var menuTitle: String {
        return Bundle.main.object(forInfoDictionaryKey: "VarlockMenuTitle") as? String ?? "Varlock Secure Enclave"
    }

    // MARK: - Icon

    /// Sessions the icon reflects: identity unlock sessions, plus the older
    /// cached-biometric sessions, since both mean the daemon is holding something.
    private func liveSessionCount() -> Int {
        let identitySessions = Set(actions.liveGrants().map(\.sessionId)).count
        if identitySessions > 0 { return identitySessions }
        return sessionManager.hasAnySessions() ? 1 : 0
    }

    private func updateIcon() {
        guard let button = statusItem?.button else { return }
        let count = liveSessionCount()

        if let image = Self.icon(unlocked: count > 0) {
            button.image = image
        } else {
            button.image = nil
        }
        // A count only when there is more than one thing to count. One open
        // session is what the open lock already says.
        button.title = count > 1 ? " \(count)" : ""
        button.imagePosition = button.title.isEmpty ? .imageOnly : .imageLeading
    }

    /// Our own mark first, then a plain lock symbol as the fallback.
    ///
    /// The varlock menu bar art has been in the repo the whole time and was never
    /// reached: the symbol branch came first and a system symbol is always
    /// available, so the daemon has been sitting in the menu bar as a generic
    /// padlock indistinguishable from anything else that draws one. The artwork
    /// is a template image, so it still follows the menu bar's own light and dark
    /// treatment rather than fighting it.
    ///
    /// Resolved through `PanelIcons`, which also finds resources in the source
    /// tree, so a development build shows the real icon instead of quietly
    /// falling back.
    private static func icon(unlocked: Bool) -> NSImage? {
        let resourceName = unlocked ? "varlock-menu-unlocked" : "varlock-menu-locked"
        if let image = PanelIcons.bundledResource(named: resourceName, extension: "pdf") {
            image.isTemplate = true
            image.size = NSSize(width: 18, height: 18)
            return image
        }
        // Worth saying out loud: a missing asset is why this used to be a generic
        // padlock, and silence is how it stayed one.
        PanelDebug.note("menu-icon-fallback", ["missing": resourceName])
        let symbolName = unlocked ? "lock.open.fill" : "lock.fill"
        guard let symbol = NSImage(systemSymbolName: symbolName, accessibilityDescription: menuTitle) else {
            return nil
        }
        symbol.isTemplate = true
        return symbol
    }

    // MARK: - Menu

    // NSMenuDelegate: everything is recomputed each time the menu opens, which is
    // also why no timer is needed to keep the times honest.
    func menuWillOpen(_ menu: NSMenu) {
        updateIcon()
        rebuildMenuItems()
    }

    private func rebuildMenuItems() {
        menu.removeAllItems()

        addDisabledItem(Self.menuTitle, to: menu)
        menu.addItem(NSMenuItem.separator())

        let model = SessionMenuModel.build(from: actions.liveGrants())
        if model.isEmpty {
            addDisabledItem("No unlocked sessions", to: menu)
        } else {
            for row in model.rows {
                menu.addItem(sessionItem(for: row))
            }
        }

        menu.addItem(NSMenuItem.separator())

        // Lock All stays enabled while the older cached-biometric sessions exist
        // even with no identity grants, since it drops those too.
        let lockAll = NSMenuItem(title: "Lock All", action: #selector(lockAllClicked), keyEquivalent: "")
        lockAll.target = self
        lockAll.isEnabled = !model.isEmpty || sessionManager.hasAnySessions()
        menu.addItem(lockAll)

        menu.addItem(lockPolicyItem())

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "Quit Daemon", action: #selector(quitClicked), keyEquivalent: "")
        quitItem.target = self
        menu.addItem(quitItem)
    }

    /// One session, as a submenu: what it holds, how long it has, what ends it,
    /// and a way to end it now.
    private func sessionItem(for row: SessionMenuModel.SessionRow) -> NSMenuItem {
        let item = NSMenuItem(title: row.title, action: nil, keyEquivalent: "")
        let submenu = NSMenu()

        for key in row.keys {
            addDisabledItem(key.title, to: submenu)
        }
        submenu.addItem(NSMenuItem.separator())
        addDisabledItem(row.capLine, to: submenu)
        addDisabledItem(row.lockLine, to: submenu)
        submenu.addItem(NSMenuItem.separator())

        let lockItem = NSMenuItem(title: "Lock This Session", action: #selector(lockSessionClicked(_:)), keyEquivalent: "")
        lockItem.target = self
        lockItem.representedObject = row.sessionId
        submenu.addItem(lockItem)

        item.submenu = submenu
        return item
    }

    /// The machine-wide default. Per-session overrides are shown on the rows
    /// above and are not editable here: a session's policy was fixed when it was
    /// unlocked, and changing it from a menu would rewrite a decision the user
    /// already approved.
    private func lockPolicyItem() -> NSMenuItem {
        let item = NSMenuItem(title: "Lock Sessions On", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        let current = actions.currentLockPolicy()

        for policy in [SessionLockPolicy.screenLock, .sleep, .never] {
            let choice = NSMenuItem(
                title: SessionMenuModel.lockPolicyMenuLabel(policy),
                action: #selector(lockPolicyChosen(_:)),
                keyEquivalent: ""
            )
            choice.target = self
            choice.representedObject = policy.rawValue
            choice.state = policy == current ? .on : .off
            submenu.addItem(choice)
        }

        submenu.addItem(NSMenuItem.separator())
        addDisabledItem("Applies to new sessions", to: submenu)

        item.submenu = submenu
        return item
    }

    private func addDisabledItem(_ title: String, to menu: NSMenu) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        menu.addItem(item)
    }

    // MARK: - Actions

    @objc private func lockAllClicked() {
        actions.lockAll()
        updateIcon()
    }

    @objc private func lockSessionClicked(_ sender: NSMenuItem) {
        guard let sessionId = sender.representedObject as? String else { return }
        actions.lockSession(sessionId)
        updateIcon()
    }

    @objc private func lockPolicyChosen(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let policy = SessionLockPolicy(wireValue: raw) else { return }
        do {
            try actions.setLockPolicy(policy)
        } catch {
            let alert = NSAlert()
            alert.messageText = "Could not save the lock setting"
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .warning
            alert.runModal()
        }
    }

    @objc private func quitClicked() {
        actions.quit()
    }

    /// Call from any thread after a session state change to update the icon
    func refresh() {
        // Use performSelector to ensure the update runs in the next run loop
        // iteration on the main thread: more reliable than DispatchQueue.main.async
        // with NSApplication.
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
