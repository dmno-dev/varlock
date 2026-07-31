// Legacy SecKeychain ACL APIs — deprecated in macOS 10.10 with no replacement.
// Isolated in a separate module so deprecation warnings don't pollute the main build.
// See README.md for details on why these are necessary.

import Foundation
import Security

public enum LegacyKeychain {

    public static func itemCopyAccess(_ item: SecKeychainItem) -> (OSStatus, SecAccess?) {
        var access: SecAccess?
        let status = SecKeychainItemCopyAccess(item, &access)
        return (status, access)
    }

    public static func accessCopyACLList(_ access: SecAccess) -> (OSStatus, CFArray?) {
        var aclList: CFArray?
        let status = SecAccessCopyACLList(access, &aclList)
        return (status, aclList)
    }

    public static func trustedApplicationCreate(path: String) -> (OSStatus, SecTrustedApplication?) {
        var app: SecTrustedApplication?
        let status = SecTrustedApplicationCreateFromPath(path, &app)
        return (status, app)
    }

    public static func aclCopyContents(_ acl: SecACL) -> (OSStatus, CFArray?, CFString?, SecKeychainPromptSelector) {
        var appList: CFArray?
        var description: CFString?
        var promptSelector = SecKeychainPromptSelector()
        let status = SecACLCopyContents(acl, &appList, &description, &promptSelector)
        return (status, appList, description, promptSelector)
    }

    public static func trustedApplicationCopyData(_ app: SecTrustedApplication) -> (OSStatus, CFData?) {
        var data: CFData?
        let status = SecTrustedApplicationCopyData(app, &data)
        return (status, data)
    }

    public static func aclSetContents(_ acl: SecACL, apps: CFArray, description: CFString, prompt: SecKeychainPromptSelector) -> OSStatus {
        return SecACLSetContents(acl, apps, description, prompt)
    }

    public static func itemSetAccess(_ item: SecKeychainItem, _ access: SecAccess) -> OSStatus {
        return SecKeychainItemSetAccess(item, access)
    }

    public static func keychainOpen(path: String) -> (OSStatus, SecKeychain?) {
        var keychain: SecKeychain?
        let status = SecKeychainOpen(path, &keychain)
        return (status, keychain)
    }
}
