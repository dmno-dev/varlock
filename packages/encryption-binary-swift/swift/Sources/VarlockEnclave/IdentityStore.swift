import Foundation

/// Reads the identity files the TypeScript side writes.
///
/// An identity is a software P-256 key pair whose private key is never stored in
/// the clear: it is ECIES-wrapped to one or more device keys, so unwrapping it goes
/// through whatever gate the device backend applies. The file format is owned by
/// `packages/varlock/src/lib/local-encrypt/identity.ts`:
///
///   { version, id, publicKey, wraps: { <deviceKeyId>: <ciphertext> }, createdAt }
///
/// Only ciphertext and public keys live here, so ordinary String handling is fine.
/// The unwrapped private key never passes through this type.
enum IdentityStore {
    static let fileVersion = 1
    static let defaultIdentityId = "default"

    struct StoredIdentity {
        let id: String
        /// base64 uncompressed P-256 public key, as written by the TS side
        let publicKeyBase64: String
        /// device key id -> wrapped identity private key (base64 v1 payload)
        let wraps: [String: String]
    }

    enum IdentityStoreError: LocalizedError {
        case notFound(String)
        case malformed(String)
        case unsupportedVersion(Int)
        case noWrapForKey(identityId: String, keyId: String)

        var errorDescription: String? {
            switch self {
            case .notFound(let id):
                return "No local identity \"\(id)\" found on this machine"
            case .malformed(let id):
                return "Invalid identity file format for identity: \(id)"
            case .unsupportedVersion(let version):
                return "unsupported identity file version \(version); upgrade varlock"
            case .noWrapForKey(let identityId, let keyId):
                return "Identity \"\(identityId)\" has no wrap for key \"\(keyId)\" on this machine"
            }
        }

        var code: String {
            switch self {
            case .notFound: return "IDENTITY_NOT_FOUND"
            case .malformed: return "IDENTITY_MALFORMED"
            case .unsupportedVersion: return "IDENTITY_VERSION_UNSUPPORTED"
            case .noWrapForKey: return "IDENTITY_NO_WRAP_FOR_KEY"
            }
        }
    }

    /// Mirror of `getUserVarlockDir()` in the TS library, legacy directory included,
    /// so both sides look in the same place.
    static var userVarlockDir: String {
        if let xdg = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"], !xdg.isEmpty {
            return xdg + "/varlock"
        }
        let legacy = NSHomeDirectory() + "/.varlock"
        if FileManager.default.fileExists(atPath: legacy) {
            return legacy
        }
        return NSHomeDirectory() + "/.config/varlock"
    }

    static func identityFilePath(_ identityId: String) -> String {
        return userVarlockDir + "/identities/\(identityId).json"
    }

    static func read(identityId: String) throws -> StoredIdentity {
        let path = identityFilePath(identityId)
        guard let data = FileManager.default.contents(atPath: path) else {
            throw IdentityStoreError.notFound(identityId)
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw IdentityStoreError.malformed(identityId)
        }
        guard let version = json["version"] as? Int else {
            throw IdentityStoreError.malformed(identityId)
        }
        guard version == fileVersion else {
            throw IdentityStoreError.unsupportedVersion(version)
        }
        guard let publicKey = json["publicKey"] as? String,
              let wraps = json["wraps"] as? [String: String],
              !publicKey.isEmpty else {
            throw IdentityStoreError.malformed(identityId)
        }
        return StoredIdentity(
            id: (json["id"] as? String) ?? identityId,
            publicKeyBase64: publicKey,
            wraps: wraps
        )
    }
}
