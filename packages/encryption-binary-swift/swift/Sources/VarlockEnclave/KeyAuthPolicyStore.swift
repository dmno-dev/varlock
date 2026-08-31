import Foundation
import IdentitySessions

/// Per-key record of whether the user must be asked, and how often.
///
/// The enclave knows whether a key is presence gated only as an access-control
/// flag baked into the key, which cannot be read back, and it knows nothing at
/// all about whether the user wanted that gate on every single read. Both are
/// recorded next to the key when it is created, in a small sidecar file:
///
///   <key store>/<keyId>.policy.json
///     ->  { "version": 1, "authMode": "every-time", "requireAuth": true }
///
/// A key with no sidecar reads as gated and `standard`, which is what every key
/// created before this file existed is assumed to be. That includes keys made
/// with `--no-auth` before the flag was recorded: they keep taking the daemon
/// path they always took until they are regenerated, which is the safe way to be
/// wrong. The file carries no secrets, so losing it is a downgrade in strictness
/// and never a leak. The daemon re-reads it per unlock rather than caching, so
/// editing the file takes effect on the next question rather than the next
/// daemon restart.
///
/// Parsing and serializing live in `IdentitySessions.KeyAuthRecord`, which is
/// unit-tested; this type is only the file handling around it.
enum KeyAuthPolicyStore {
    static func policyFilePath(for keyId: String) -> String {
        return SecureEnclaveManager.keyStorePath + "/\(keyId).policy.json"
    }

    static func record(for keyId: String) -> KeyAuthRecord {
        guard let data = FileManager.default.contents(atPath: policyFilePath(for: keyId)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return KeyAuthRecord(json: nil)
        }
        return KeyAuthRecord(json: json)
    }

    static func policy(for keyId: String) -> KeyAuthPolicy {
        return record(for: keyId).policy
    }

    /// Record how a key must be authorized. Only called when creating one.
    static func write(record: KeyAuthRecord, for keyId: String) throws {
        let path = policyFilePath(for: keyId)
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: record.jsonObject)
        try data.write(to: URL(fileURLWithPath: path))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }

    static func remove(for keyId: String) {
        try? FileManager.default.removeItem(atPath: policyFilePath(for: keyId))
    }
}
