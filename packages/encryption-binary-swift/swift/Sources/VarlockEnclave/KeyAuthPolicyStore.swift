import Foundation
import IdentitySessions

/// Per-key record of how often the user must be asked.
///
/// The enclave itself only knows whether a key is presence gated, not whether the
/// user wanted that gate on every single read. That intent is recorded next to the
/// key when it is created, in a small sidecar file:
///
///   <key store>/<keyId>.policy.json  ->  { "version": 1, "authMode": "every-time" }
///
/// A key with no sidecar is `standard`, which is what every key created so far is.
/// The file carries no secrets, only the policy, so losing it is a downgrade in
/// strictness and never a leak. The daemon re-reads it per unlock rather than
/// caching, so editing the file takes effect on the next question rather than the
/// next daemon restart.
enum KeyAuthPolicyStore {
    static let fileVersion = 1

    static func policyFilePath(for keyId: String) -> String {
        return SecureEnclaveManager.keyStorePath + "/\(keyId).policy.json"
    }

    static func policy(for keyId: String) -> KeyAuthPolicy {
        guard let data = FileManager.default.contents(atPath: policyFilePath(for: keyId)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .standard
        }
        return KeyAuthPolicy(wireValue: json["authMode"] as? String)
    }

    /// Record a policy for a key. Only called when creating one.
    static func write(policy: KeyAuthPolicy, for keyId: String) throws {
        let path = policyFilePath(for: keyId)
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let json: [String: Any] = ["version": fileVersion, "authMode": policy.rawValue]
        let data = try JSONSerialization.data(withJSONObject: json)
        try data.write(to: URL(fileURLWithPath: path))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }

    static func remove(for keyId: String) {
        try? FileManager.default.removeItem(atPath: policyFilePath(for: keyId))
    }
}
