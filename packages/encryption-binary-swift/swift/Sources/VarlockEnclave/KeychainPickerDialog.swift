import AppKit

/// Shows a native macOS dialog for browsing and selecting keychain items.
/// Includes search filtering, item metadata display, and ACL auto-fix flow.
final class KeychainPickerDialog: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate {

    private var allItems: [KeychainItemMeta] = []
    private var filteredItems: [KeychainItemMeta] = []
    private var tableView: NSTableView!
    private var searchField: NSSearchField!
    private var itemKey: String?

    /// The Select button, disabled when no row is selected.
    private var selectButton: NSButton?

    /// Show the keychain picker and return the selected item's reference info,
    /// or nil if the user cancelled.
    static func pick(itemKey: String? = nil) -> [String: Any]? {
        var result: [String: Any]?
        let work = {
            let picker = KeychainPickerDialog()
            result = picker.showDialog(itemKey: itemKey)
        }

        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.sync { work() }
        }

        return result
    }

    /// Result from the picker: selected existing item, created new item, or cancelled
    private enum PickerResult {
        case selected(KeychainItemMeta)
        case create
        case cancelled
    }

    private var pickerResult: PickerResult = .cancelled

    private func showDialog(itemKey: String? = nil) -> [String: Any]? {
        self.itemKey = itemKey
        SecureInputDialog.ensureEditMenu()

        // Load all keychain items
        allItems = KeychainManager.searchItems()
        filteredItems = allItems

        // Build table view
        tableView = NSTableView()
        tableView.usesAlternatingRowBackgroundColors = true
        tableView.allowsMultipleSelection = false
        tableView.rowHeight = 20
        tableView.dataSource = self
        tableView.delegate = self
        tableView.target = self
        tableView.doubleAction = #selector(tableDoubleClicked(_:))

        // Create columns with explicit NSTextFieldCell (ensures cell-based mode)
        let cell = NSTextFieldCell()
        cell.isEditable = false
        cell.lineBreakMode = .byTruncatingTail
        cell.font = NSFont.systemFont(ofSize: 12)

        for (id, title, width) in [("label", "Label", 220), ("service", "Service", 240), ("account", "Account", 180)] as [(String, String, Int)] {
            let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
            col.title = title
            col.width = CGFloat(width)
            col.dataCell = cell.copy() as! NSCell
            tableView.addTableColumn(col)
        }

        let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
        scrollView.documentView = tableView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false

        // Search field
        searchField = NSSearchField(frame: NSRect(x: 0, y: 0, width: 640, height: 24))
        searchField.placeholderString = "Filter keychain items..."
        searchField.target = self
        searchField.action = #selector(searchChanged(_:))

        // Layout container
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 354))
        searchField.frame = NSRect(x: 0, y: 330, width: 640, height: 24)
        scrollView.frame = NSRect(x: 0, y: 0, width: 640, height: 324)
        container.addSubview(searchField)
        container.addSubview(scrollView)

        // Build alert
        let alert = NSAlert()
        alert.messageText = itemKey.map { "Select Keychain Item for \($0)" } ?? "Select a Keychain Item"
        alert.informativeText = "Choose an existing keychain item, or create a new one."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Select")
        alert.addButton(withTitle: "Cancel")
        alert.accessoryView = container

        let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Varlock"
        alert.window.title = itemKey.map { "\(appName) — \($0)" } ?? "\(appName) — Keychain Picker"

        // "Create New" in the suppression button area (bottom-left)
        alert.showsSuppressionButton = true
        let suppressionButton = alert.suppressionButton!
        suppressionButton.title = " Create New…"
        suppressionButton.image = NSImage(systemSymbolName: "plus.circle.fill", accessibilityDescription: "Create")
        suppressionButton.imagePosition = .imageLeading
        suppressionButton.contentTintColor = .systemGreen
        suppressionButton.setButtonType(.momentaryPushIn)
        suppressionButton.bezelStyle = .rounded
        suppressionButton.target = self
        suppressionButton.action = #selector(createNewClicked(_:))

        self.selectButton = alert.buttons[0]
        pickerResult = .cancelled

        NSApp.activate(ignoringOtherApps: true)
        alert.window.initialFirstResponder = searchField

        let response = alert.runModal()

        // If Create New was clicked, pickerResult is already .create from stopModal
        // Otherwise handle the standard alert button response
        if case .create = pickerResult {
            // Already set by createNewClicked
        } else if response == .alertFirstButtonReturn {
            let row = tableView.selectedRow
            if row >= 0, row < filteredItems.count {
                pickerResult = .selected(filteredItems[row])
            }
        }

        switch pickerResult {
        case .create:
            guard let created = showCreateDialog(itemKey: itemKey) else { return nil }
            return created.toDictionary()
        case .selected(let item):
            let accessResult = verifyAccessAndFixACL(item: item)
            guard accessResult else { return nil }
            return item.toDictionary()
        case .cancelled:
            return nil
        }
    }

    @objc private func selectClicked(_ sender: Any) {
        let row = tableView.selectedRow
        guard row >= 0, row < filteredItems.count else {
            selectButton?.isEnabled = false
            return
        }
        pickerResult = .selected(filteredItems[row])
        NSApp.stopModal()
    }

    @objc private func createNewClicked(_ sender: Any) {
        pickerResult = .create
        NSApp.stopModal()
    }

    @objc private func tableDoubleClicked(_ sender: Any) {
        selectClicked(sender)
    }

    // MARK: - Create New Item

    /// Preloaded keychain item names for live duplicate checking.
    private var existingItemNames: Set<String> = []

    /// Warning label shown when name is already taken.
    private var duplicateWarningLabel: NSTextField!

    /// The Create button reference for enabling/disabling.
    private var createButton: NSButton?

    /// Show a dialog to create a new keychain secure note.
    /// The user can edit the label and enter the secret value.
    private func showCreateDialog(itemKey: String?) -> KeychainItemMeta? {
        let defaultLabel = "varlock/\(itemKey ?? "secret")"

        // Preload existing names for live duplicate checking
        let allItems = KeychainManager.searchItems(query: nil, keychainName: nil)
        existingItemNames = Set(allItems.flatMap { item -> [String] in
            var names = [item.service]
            if let label = item.label { names.append(label) }
            return names
        })

        let alert = NSAlert()
        alert.messageText = itemKey.map { "Save new secret for \($0)" } ?? "Create Secure Note"
        alert.informativeText = "Your secret will be saved in a secure note in your login keychain."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Create")
        alert.addButton(withTitle: "Cancel")

        let formWidth: CGFloat = 340

        // Name label + field
        let nameLabel = NSTextField(labelWithString: "Keychain item name:")
        nameLabel.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)

        let nameField = NSTextField(frame: .zero)
        nameField.stringValue = defaultLabel
        nameField.placeholderString = "varlock/my-secret"
        nameField.delegate = self
        nameField.target = self
        nameField.action = #selector(nameFieldChanged(_:))

        // Duplicate warning (hidden by default)
        duplicateWarningLabel = NSTextField(labelWithString: "")
        duplicateWarningLabel.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        duplicateWarningLabel.textColor = .systemRed
        duplicateWarningLabel.isHidden = true

        // Secret value label + field
        let valueLabel = NSTextField(labelWithString: "Secret value:")
        valueLabel.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)

        let valueField = NSTextField(frame: NSRect(x: 0, y: 0, width: formWidth, height: 80))
        valueField.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        valueField.placeholderString = "Enter or paste secret value..."
        valueField.usesSingleLineMode = false
        valueField.cell?.wraps = true
        valueField.cell?.isScrollable = false
        valueField.lineBreakMode = .byWordWrapping
        if #available(macOS 11.0, *) {
            valueField.contentType = .none
        }

        // Layout
        let container = NSView(frame: NSRect(x: 0, y: 0, width: formWidth, height: 156))
        nameLabel.frame = NSRect(x: 0, y: 138, width: formWidth, height: 16)
        nameField.frame = NSRect(x: 0, y: 116, width: formWidth, height: 22)
        duplicateWarningLabel.frame = NSRect(x: 0, y: 100, width: formWidth, height: 14)
        valueLabel.frame = NSRect(x: 0, y: 82, width: formWidth, height: 16)
        valueField.frame = NSRect(x: 0, y: 0, width: formWidth, height: 80)

        container.addSubview(nameLabel)
        container.addSubview(nameField)
        container.addSubview(duplicateWarningLabel)
        container.addSubview(valueLabel)
        container.addSubview(valueField)

        alert.accessoryView = container

        let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Varlock"
        alert.window.title = itemKey.map { "\(appName) — \($0)" } ?? "\(appName) — Create Secure Note"

        // Store Create button ref for enabling/disabling
        createButton = alert.buttons.first

        // Check initial name for duplicates
        checkDuplicateName(defaultLabel)

        NSApp.activate(ignoringOtherApps: true)

        alert.window.initialFirstResponder = valueField

        let response = alert.runModal()
        createButton = nil
        guard response == .alertFirstButtonReturn else { return nil }

        let label = nameField.stringValue.trimmingCharacters(in: .whitespaces)
        let value = valueField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)

        if label.isEmpty {
            showError("Name cannot be empty.")
            return nil
        }
        if value.isEmpty {
            showError("Secret value cannot be empty.")
            return nil
        }

        do {
            return try KeychainManager.addItem(label: label, value: value)
        } catch KeychainError.duplicateItem {
            showError("A keychain item named \"\(label)\" already exists.")
            return nil
        } catch {
            showError("Failed to create keychain item: \(error.localizedDescription)")
            return nil
        }
    }

    @objc private func nameFieldChanged(_ sender: NSTextField) {
        checkDuplicateName(sender.stringValue)
    }

    /// NSTextFieldDelegate — fires on every keystroke
    func controlTextDidChange(_ obj: Notification) {
        if let textField = obj.object as? NSTextField {
            checkDuplicateName(textField.stringValue)
        }
    }

    private func checkDuplicateName(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let isDuplicate = !trimmed.isEmpty && existingItemNames.contains(trimmed)
        duplicateWarningLabel.stringValue = isDuplicate ? "An item with this name already exists" : ""
        duplicateWarningLabel.isHidden = !isDuplicate
        createButton?.isEnabled = !isDuplicate && !trimmed.isEmpty
    }

    // MARK: - Access Verification

    /// Verify we can read the item. If access is denied, offer to fix the ACL.
    /// Returns true if access is confirmed, false if user cancelled or fix failed.
    private func verifyAccessAndFixACL(item: KeychainItemMeta) -> Bool {
        do {
            _ = try KeychainManager.getItem(
                service: item.service,
                account: item.account.isEmpty ? nil : item.account,
                keychainName: nil
            )
            return true
        } catch let error as KeychainError {
            switch error {
            case .accessDenied, .unhandledError:
                return offerACLFix(item: item)
            default:
                showError("Cannot access this keychain item: \(error.localizedDescription)")
                return false
            }
        } catch {
            showError("Cannot access this keychain item: \(error.localizedDescription)")
            return false
        }
    }

    /// Show a dialog offering to add VarlockEnclave to the item's ACL.
    private func offerACLFix(item: KeychainItemMeta) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Access Denied"
        alert.informativeText = "Varlock doesn't have permission to read this keychain item (\(item.service)). Would you like to add Varlock to the allowed applications?\n\nmacOS will ask you to authenticate to authorize this change."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Grant Access")
        alert.addButton(withTitle: "Cancel")

        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return false }

        let appPath = Bundle.main.executablePath ?? ProcessInfo.processInfo.arguments[0]

        do {
            _ = try KeychainManager.addToACL(
                service: item.service,
                account: item.account.isEmpty ? nil : item.account,
                appPath: appPath
            )
            _ = try KeychainManager.getItem(
                service: item.service,
                account: item.account.isEmpty ? nil : item.account
            )
            return true
        } catch {
            showError("Failed to update access: \(error.localizedDescription)\n\nYou may need to grant access manually in Keychain Access.app.")
            return false
        }
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Keychain Error"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    // MARK: - Search

    @objc private func searchChanged(_ sender: NSSearchField) {
        let query = sender.stringValue.lowercased()
        if query.isEmpty {
            filteredItems = allItems
        } else {
            filteredItems = allItems.filter { item in
                let searchable = "\(item.service) \(item.account) \(item.label ?? "")".lowercased()
                return searchable.contains(query)
            }
        }
        tableView.reloadData()
    }

    // MARK: - NSTableViewDataSource

    func numberOfRows(in tableView: NSTableView) -> Int {
        return filteredItems.count
    }

    // MARK: - NSTableViewDataSource (cell-based for performance)

    func tableView(_ tableView: NSTableView, objectValueFor tableColumn: NSTableColumn?, row: Int) -> Any? {
        guard row < filteredItems.count, let columnId = tableColumn?.identifier.rawValue else { return nil }
        let item = filteredItems[row]
        switch columnId {
        case "label": return item.label ?? item.service
        case "service": return item.service
        case "account": return item.account
        default: return nil
        }
    }

    // MARK: - NSTableViewDelegate

    func tableViewSelectionDidChange(_ notification: Notification) {
        selectButton?.isEnabled = tableView.selectedRow >= 0
    }
}
