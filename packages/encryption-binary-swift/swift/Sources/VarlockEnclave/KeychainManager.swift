import Foundation
import Security
import KeychainLegacy

/// Error types for keychain operations
enum KeychainError: LocalizedError {
    case itemNotFound
    case accessDenied(String)
    case duplicateItem
    case unexpectedData
    case unhandledError(OSStatus)
    case keychainNotFound(String)
    case ambiguousMatch(service: String, accounts: [String])

    var errorDescription: String? {
        switch self {
        case .itemNotFound:
            return "Keychain item not found"
        case .accessDenied(let detail):
            return "Access denied: \(detail)"
        case .duplicateItem:
            return "Keychain item already exists"
        case .unexpectedData:
            return "Unexpected keychain data format"
        case .unhandledError(let status):
            if let msg = SecCopyErrorMessageString(status, nil) as String? {
                return "Keychain error: \(msg) (\(status))"
            }
            return "Keychain error: \(status)"
        case .keychainNotFound(let name):
            return "Keychain not found: \(name)"
        case .ambiguousMatch(let service, let accounts):
            let accountList = accounts.map { "\"\($0)\"" }.joined(separator: ", ")
            return "Multiple keychain items found for service \"\(service)\" with accounts: \(accountList). Specify account to disambiguate."
        }
    }
}

/// Metadata about a keychain item (no secret values)
struct KeychainItemMeta {
    let service: String
    let account: String
    let label: String?
    let kind: String // "generic" or "internet"
    let keychainPath: String?
    let creationDate: Date?

    func toDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "service": service,
            "account": account,
            "kind": kind,
        ]
        if let label = label { dict["label"] = label }
        if let path = keychainPath { dict["keychain"] = keychainDisplayName(path) }
        return dict
    }
}

/// Convert a keychain file path to a human-readable name
private func keychainDisplayName(_ path: String) -> String {
    let filename = (path as NSString).lastPathComponent
    // Strip common extensions
    let name = filename
        .replacingOccurrences(of: ".keychain-db", with: "")
        .replacingOccurrences(of: ".keychain", with: "")
    // Capitalize known names
    switch name.lowercased() {
    case "login": return "Login"
    case "system": return "System"
    default: return name
    }
}

/// Wraps macOS Keychain Services for searching, reading, and managing ACLs.
final class KeychainManager {

    // MARK: - Search (metadata only, no secrets)

    /// Search for keychain items matching optional criteria.
    /// Returns metadata only — never reads password values.
    static func searchItems(query: String? = nil, keychainName: String? = nil) -> [KeychainItemMeta] {
        var results: [KeychainItemMeta] = []

        // Search both generic and internet passwords
        for itemClass in [kSecClassGenericPassword, kSecClassInternetPassword] {
            let kind = itemClass == kSecClassGenericPassword ? "generic" : "internet"
            var searchQuery: [CFString: Any] = [
                kSecClass: itemClass,
                kSecMatchLimit: kSecMatchLimitAll,
                kSecReturnAttributes: true,
                kSecReturnRef: false,
            ]

            // Scope to specific keychain if requested
            if let keychainName = keychainName, let keychainRef = resolveKeychain(named: keychainName) {
                searchQuery[kSecMatchSearchList] = [keychainRef]
            }

            var result: AnyObject?
            let status = SecItemCopyMatching(searchQuery as CFDictionary, &result)

            guard status == errSecSuccess, let items = result as? [[String: Any]] else {
                continue
            }

            for item in items {
                let service: String
                if itemClass == kSecClassGenericPassword {
                    service = item[kSecAttrService as String] as? String ?? ""
                } else {
                    service = item[kSecAttrServer as String] as? String ?? ""
                }

                let account = item[kSecAttrAccount as String] as? String ?? ""
                let label = item[kSecAttrLabel as String] as? String
                let keychainPath = keychainPathFromAttributes(item)
                let creationDate = item[kSecAttrCreationDate as String] as? Date

                let meta = KeychainItemMeta(
                    service: service,
                    account: account,
                    label: label,
                    kind: kind,
                    keychainPath: keychainPath,
                    creationDate: creationDate
                )

                // Apply text filter if provided
                if let query = query?.lowercased(), !query.isEmpty {
                    let searchable = "\(service) \(account) \(label ?? "")".lowercased()
                    if !searchable.contains(query) {
                        continue
                    }
                }

                // Skip items with empty service (not useful for lookup)
                if service.isEmpty { continue }

                // Skip system/infrastructure items that aren't useful for secret management
                let itemDesc = (item[kSecAttrDescription as String] as? String ?? "").lowercased()
                let serviceLower = service.lowercased()
                let labelLower = (label ?? "").lowercased()

                // Wi-Fi / AirPort passwords
                if itemDesc.contains("airport") || itemDesc.contains("wi-fi") { continue }
                // Bluetooth pairing keys
                if itemDesc.contains("bluetooth") || serviceLower.contains("bluetooth") { continue }
                // macOS system services
                if serviceLower.hasPrefix("com.apple.") { continue }
                // Safari/browser saved passwords
                if itemDesc.contains("web form password") { continue }
                // Kerberos/authentication tickets
                if itemDesc.contains("kerberos") || itemDesc.contains("ticket") { continue }
                // Certificate/key items that leak through
                if itemDesc.contains("certificate") || itemDesc.contains("private key") { continue }
                // Time Machine
                if serviceLower.contains("time machine") || labelLower.contains("time machine") { continue }
                // iCloud/CloudKit tokens
                if serviceLower.hasPrefix("com.icloud.") || serviceLower.contains("cloudkit") { continue }

                results.append(meta)
            }
        }

        // Sort by service, then account
        results.sort {
            if $0.service != $1.service { return $0.service < $1.service }
            return $0.account < $1.account
        }

        return results
    }

    // MARK: - Get Item Value

    /// Fetch the password value for a keychain item.
    /// At least one of service or account must be provided.
    /// Throws if not found, access denied, or ambiguous match.
    static func getItem(service: String? = nil, account: String? = nil, keychainName: String? = nil) throws -> String {
        // Try generic password first, then internet password
        if let value = try? getItemOfClass(kSecClassGenericPassword, service: service, account: account, keychainName: keychainName) {
            return value
        }
        return try getItemOfClass(kSecClassInternetPassword, service: service, account: account, keychainName: keychainName)
    }

    /// Fetch a metadata field (account, label, etc.) from a keychain item instead of the password.
    static func getItemField(service: String? = nil, account: String? = nil, keychainName: String? = nil, field: String) throws -> String {
        for itemClass in [kSecClassGenericPassword, kSecClassInternetPassword] {
            var query: [CFString: Any] = [
                kSecClass: itemClass,
                kSecReturnAttributes: true,
                kSecMatchLimit: kSecMatchLimitOne,
            ]

            if let service = service {
                if itemClass == kSecClassGenericPassword {
                    query[kSecAttrService] = service
                } else {
                    query[kSecAttrServer] = service
                }
            }
            if let account = account {
                query[kSecAttrAccount] = account
            }
            if let keychainName = keychainName, let keychainRef = resolveKeychain(named: keychainName) {
                query[kSecMatchSearchList] = [keychainRef]
            }

            var result: AnyObject?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            guard status == errSecSuccess, let attrs = result as? [String: Any] else { continue }

            let attrKey: String
            switch field {
            case "account": attrKey = kSecAttrAccount as String
            case "label": attrKey = kSecAttrLabel as String
            case "service": attrKey = kSecAttrService as String
            case "server": attrKey = kSecAttrServer as String
            default:
                throw KeychainError.accessDenied("Unknown field: \(field). Supported fields: account, label, service, server")
            }

            if let value = attrs[attrKey] as? String {
                return value
            }
        }

        throw KeychainError.itemNotFound
    }

    private static func getItemOfClass(_ itemClass: CFString, service: String?, account: String?, keychainName: String?) throws -> String {
        // When account is nil and service is set, check for ambiguity
        if account == nil, let service = service {
            var countQuery: [CFString: Any] = [
                kSecClass: itemClass,
                kSecReturnAttributes: true,
                kSecMatchLimit: kSecMatchLimitAll,
            ]
            if itemClass == kSecClassGenericPassword {
                countQuery[kSecAttrService] = service
            } else {
                countQuery[kSecAttrServer] = service
            }
            if let keychainName = keychainName, let keychainRef = resolveKeychain(named: keychainName) {
                countQuery[kSecMatchSearchList] = [keychainRef]
            }

            var countResult: AnyObject?
            let countStatus = SecItemCopyMatching(countQuery as CFDictionary, &countResult)
            if countStatus == errSecSuccess, let items = countResult as? [[String: Any]], items.count > 1 {
                let accounts = items.compactMap { $0[kSecAttrAccount as String] as? String }
                throw KeychainError.ambiguousMatch(
                    service: service,
                    accounts: accounts
                )
            }
        }

        var query: [CFString: Any] = [
            kSecClass: itemClass,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]

        // Use service or server depending on class
        if let service = service {
            if itemClass == kSecClassGenericPassword {
                query[kSecAttrService] = service
            } else {
                query[kSecAttrServer] = service
            }
        }

        if let account = account {
            query[kSecAttrAccount] = account
        }

        if let keychainName = keychainName, let keychainRef = resolveKeychain(named: keychainName) {
            query[kSecMatchSearchList] = [keychainRef]
        }

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
                throw KeychainError.unexpectedData
            }
            return value
        case errSecItemNotFound:
            throw KeychainError.itemNotFound
        case errSecAuthFailed, errSecInteractionNotAllowed:
            throw KeychainError.accessDenied("Authentication failed or interaction not allowed")
        default:
            throw KeychainError.unhandledError(status)
        }
    }

    // MARK: - Add Item

    /// Create a new keychain item as a secure note.
    /// The label is the only user-visible identifier in Keychain Access.
    /// The value is stored as RTF for Keychain Access compatibility.
    static func addItem(label: String, value: String) throws -> KeychainItemMeta {
        guard let valueData = value.data(using: .utf8) else {
            throw KeychainError.unexpectedData
        }

        // Secure notes are generic passwords with kSecAttrType = "note"
        // Use the label as the service too (it's the lookup key)
        let noteType = UInt32(0x6E6F7465) // 'note' as FourCharCode
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: label,
            kSecAttrAccount: "",
            kSecAttrLabel: label,
            kSecAttrType: noteType,
            kSecValueData: valueData,
        ]

        let status = SecItemAdd(query as CFDictionary, nil)

        switch status {
        case errSecSuccess:
            return KeychainItemMeta(
                service: label,
                account: "",
                label: label,
                kind: "generic",
                keychainPath: nil,
                creationDate: Date()
            )
        case errSecDuplicateItem:
            throw KeychainError.duplicateItem
        default:
            throw KeychainError.unhandledError(status)
        }
    }

    // MARK: - ACL Management

    /// Attempt to add the given application path to the ACL of a keychain item.
    /// This uses the legacy Keychain API which supports per-application access control.
    /// Returns true if the ACL was modified, false if no change was needed.
    /// macOS will prompt the user for authentication to authorize the change.
    static func addToACL(service: String, account: String? = nil, keychainName: String? = nil, appPath: String) throws -> Bool {
        // We need the item reference for ACL manipulation
        let itemRef = try getItemRef(service: service, account: account, keychainName: keychainName)

        // Get current access object (uses legacy API wrappers from KeychainLegacyACL.swift)
        let (accessStatus, access) = LegacyKeychain.itemCopyAccess(itemRef)
        guard accessStatus == errSecSuccess, let currentAccess = access else {
            if accessStatus == errSecNoAccessForItem {
                throw KeychainError.accessDenied("Cannot read ACL for this item — it may be managed by the system")
            }
            throw KeychainError.unhandledError(accessStatus)
        }

        // Get all ACL entries
        let (aclListStatus, aclListRef) = LegacyKeychain.accessCopyACLList(currentAccess)
        guard aclListStatus == errSecSuccess, let aclList = aclListRef as? [SecACL] else {
            throw KeychainError.accessDenied("Cannot read ACL list")
        }

        // Create trusted application for our binary
        let (trustStatus, trustedApp) = LegacyKeychain.trustedApplicationCreate(path: appPath)
        guard trustStatus == errSecSuccess, let newTrustedApp = trustedApp else {
            throw KeychainError.unhandledError(trustStatus)
        }

        var modified = false

        // Find ACL entries that control decryption/reading and add our app
        for acl in aclList {
            let (contentsStatus, appList, description, promptSelector) = LegacyKeychain.aclCopyContents(acl)
            guard contentsStatus == errSecSuccess else { continue }

            // nil appList means "allow all apps" — no change needed
            guard let currentApps = appList as? [SecTrustedApplication] else { continue }

            // Check if our app is already in the list
            var alreadyPresent = false
            for app in currentApps {
                let (dataStatus, appData) = LegacyKeychain.trustedApplicationCopyData(app)
                if dataStatus == errSecSuccess,
                   let data = appData as Data?,
                   let path = String(data: data, encoding: .utf8),
                   path == appPath {
                    alreadyPresent = true
                    break
                }
            }

            if !alreadyPresent {
                var updatedApps = currentApps
                updatedApps.append(newTrustedApp)
                let updateStatus = LegacyKeychain.aclSetContents(acl, apps: updatedApps as CFArray, description: description ?? "" as CFString, prompt: promptSelector)
                if updateStatus == errSecSuccess {
                    modified = true
                }
            }
        }

        if modified {
            // Apply the modified access object back to the item
            let setStatus = LegacyKeychain.itemSetAccess(itemRef, currentAccess)
            if setStatus != errSecSuccess {
                throw KeychainError.unhandledError(setStatus)
            }
        }

        return modified
    }

    // MARK: - Private Helpers

    /// Get a SecKeychainItem reference for ACL operations.
    /// Searches generic passwords first, then internet passwords.
    private static func getItemRef(service: String, account: String?, keychainName: String?) throws -> SecKeychainItem {
        for itemClass in [kSecClassGenericPassword, kSecClassInternetPassword] {
            var query: [CFString: Any] = [
                kSecClass: itemClass,
                kSecReturnRef: true,
                kSecMatchLimit: kSecMatchLimitOne,
            ]

            if itemClass == kSecClassGenericPassword {
                query[kSecAttrService] = service
            } else {
                query[kSecAttrServer] = service
            }

            if let account = account {
                query[kSecAttrAccount] = account
            }

            if let keychainName = keychainName, let keychainRef = resolveKeychain(named: keychainName) {
                query[kSecMatchSearchList] = [keychainRef]
            }

            var result: AnyObject?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecSuccess, let item = result {
                // SecKeychainItem is a CFType — force cast from AnyObject
                return item as! SecKeychainItem
            }
        }

        throw KeychainError.itemNotFound
    }

    /// Resolve a human-friendly keychain name to a SecKeychain reference.
    /// Supports: "Login", "System", or a full/partial path.
    private static func resolveKeychain(named name: String) -> SecKeychain? {
        let lowered = name.lowercased()

        // Well-known keychains
        let path: String
        switch lowered {
        case "login":
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            path = "\(home)/Library/Keychains/login.keychain-db"
        case "system":
            path = "/Library/Keychains/System.keychain"
        default:
            // Treat as a path
            path = name
        }

        // Verify the file exists before opening (SecKeychainOpen doesn't check)
        guard FileManager.default.fileExists(atPath: path) else {
            return nil
        }

        let (status, keychain) = LegacyKeychain.keychainOpen(path: path)
        guard status == errSecSuccess, let kc = keychain else {
            return nil
        }

        return kc
    }

    /// Extract keychain file path from item attributes (if available).
    private static func keychainPathFromAttributes(_ attrs: [String: Any]) -> String? {
        // The keychain path isn't directly in attributes, but we can check
        // via the item's keychain reference if we fetched kSecReturnRef
        // For now, return nil — the picker dialog will show keychain info separately
        return nil
    }
}
