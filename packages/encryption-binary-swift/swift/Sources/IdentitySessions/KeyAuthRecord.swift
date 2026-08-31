import Foundation

/// What is recorded next to a key about how it must be authorized.
///
/// Two independent things live here, and they are not the same question:
///
///   - `requireAuth`: whether the key carries a presence gate at all. False only
///     for keys created with `--no-auth`, which is the CI and headless case.
///   - `policy`: for a gated key, how often the user must be asked. See
///     `KeyAuthPolicy`.
///
/// The enclave knows the first as an access-control flag baked into the key, but
/// that flag cannot be read back off a stored key, so it is recorded here too.
/// Anything reading this file gets only policy, never key material, so losing the
/// file is a downgrade in strictness and never a leak.
///
/// Both fields are optional on disk. A file written before `requireAuth` existed
/// reads as `true`, matching the Rust helper, whose `StoredKey.require_auth`
/// defaults the same way: never silently drop a prompt someone asked for.
public struct KeyAuthRecord: Equatable {
    public static let fileVersion = 1

    public let policy: KeyAuthPolicy
    public let requireAuth: Bool

    public init(policy: KeyAuthPolicy = .standard, requireAuth: Bool = true) {
        self.policy = policy
        self.requireAuth = requireAuth
    }

    /// Parse a sidecar file's contents. A missing or unreadable file is the
    /// default record, which is the strictest reading of both fields.
    public init(json: [String: Any]?) {
        guard let json else {
            self.init()
            return
        }
        self.init(
            policy: KeyAuthPolicy(wireValue: json["authMode"] as? String),
            requireAuth: (json["requireAuth"] as? Bool) ?? true
        )
    }

    /// The object form written back to the sidecar file.
    public var jsonObject: [String: Any] {
        return [
            "version": Self.fileVersion,
            "authMode": policy.rawValue,
            "requireAuth": requireAuth,
        ]
    }
}
