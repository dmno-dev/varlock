import Foundation

/// What ends an unlock session, short of its TTL running out.
///
/// The hard cap and explicit invalidation are not covered here: those always apply.
/// This only decides which system events erase a session's key material.
public enum SessionLockPolicy: String, CaseIterable {
    /// Erase on screen lock and on sleep.
    case screenLock
    /// Erase on sleep only. Sessions survive the screen locking.
    case sleep
    /// Erase only on TTL expiry, the 12h cap, or an explicit lock.
    ///
    /// Spelled `never` in Swift, `"none"` on the wire: a case literally named `none`
    /// collides with `Optional.none` at every optional comparison.
    case never = "none"

    /// Used when neither the session nor the machine config says otherwise.
    public static let builtInDefault: SessionLockPolicy = .sleep

    public init?(wireValue: String?) {
        guard let wireValue else { return nil }
        self.init(rawValue: wireValue)
    }

    /// Every value a caller may send, for error messages.
    public static var wireValues: [String] {
        return allCases.map(\.rawValue)
    }

    public func erases(on event: SessionLockEvent) -> Bool {
        switch self {
        case .screenLock: return true
        case .sleep: return event == .sleep
        case .never: return false
        }
    }
}

/// A system event that may end sessions, depending on their policy.
public enum SessionLockEvent: String {
    /// The machine is going to sleep.
    case sleep
    /// The screen locked, the display slept, or the login session resigned active.
    case screenLock
}

/// Resolving the effective lock policy for one unlock.
///
/// Order is: what this unlock asked for, then the machine config, then the built-in
/// default. Anything unparseable is reported and skipped rather than failing the
/// unlock, so a typo in a config file cannot lock someone out of their own secrets.
public enum LockPolicyResolution {
    /// Where the effective policy came from, for diagnostics.
    public enum Source: String {
        case sessionOverride = "session-override"
        case machineConfig = "machine-config"
        case builtInDefault = "built-in-default"
    }

    public struct Resolved {
        public let policy: SessionLockPolicy
        public let source: Source
    }

    /// Key path into the machine config file: `{ "sessions": { "lockOn": "sleep" } }`
    public static let configSectionKey = "sessions"
    public static let configFieldKey = "lockOn"

    public static func resolve(
        overrideWireValue: String?,
        machineConfigData: Data?,
        warn: (String) -> Void = { message in fputs("varlock: \(message)\n", stderr) }
    ) -> Resolved {
        if let overrideWireValue, !overrideWireValue.isEmpty {
            if let policy = SessionLockPolicy(wireValue: overrideWireValue) {
                return Resolved(policy: policy, source: .sessionOverride)
            }
            warn(invalidValueMessage(overrideWireValue, origin: "unlock-session lockOn"))
        }

        if let policy = machineLockPolicy(fromConfigData: machineConfigData, warn: warn) {
            return Resolved(policy: policy, source: .machineConfig)
        }

        return Resolved(policy: .builtInDefault, source: .builtInDefault)
    }

    /// Read `sessions.lockOn` out of the user-level config file's contents.
    ///
    /// A missing file, a missing section, or a missing field all mean "not
    /// configured", silently. Only a value that is present and wrong is worth
    /// saying something about.
    public static func machineLockPolicy(
        fromConfigData data: Data?,
        warn: (String) -> Void = { message in fputs("varlock: \(message)\n", stderr) }
    ) -> SessionLockPolicy? {
        guard let data, !data.isEmpty else { return nil }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            warn("could not parse the varlock config file; ignoring it for session lock settings")
            return nil
        }
        guard let sessions = json[configSectionKey] as? [String: Any] else { return nil }
        guard let raw = sessions[configFieldKey] else { return nil }

        guard let rawString = raw as? String else {
            warn(invalidValueMessage(String(describing: raw), origin: "config \(configSectionKey).\(configFieldKey)"))
            return nil
        }
        guard let policy = SessionLockPolicy(wireValue: rawString) else {
            warn(invalidValueMessage(rawString, origin: "config \(configSectionKey).\(configFieldKey)"))
            return nil
        }
        return policy
    }

    private static func invalidValueMessage(_ value: String, origin: String) -> String {
        return "ignoring invalid \(origin) value \"\(value)\"; expected one of "
            + SessionLockPolicy.wireValues.map { "\"\($0)\"" }.joined(separator: ", ")
    }
}
