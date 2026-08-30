import Foundation

/// Editing one field of the user-level config file.
///
/// That file is shared: telemetry settings live in it, and so will anything
/// varlock adds later. So this is a read, a single change, and a write of
/// everything else back untouched. It never starts from a blank object when the
/// file already has content, and it refuses to write at all rather than replace
/// something it could not parse, since clobbering a config that only failed to
/// parse because of a typo would lose settings the user wrote by hand.
public enum MachineConfigEdit {
    public enum EditError: LocalizedError {
        case unparseable
        case notAnObject

        public var errorDescription: String? {
            switch self {
            case .unparseable:
                return "The varlock config file could not be parsed, so it was left alone. Fix or remove it first."
            case .notAnObject:
                return "The varlock config file is not a JSON object, so it was left alone."
            }
        }
    }

    /// The contents to write so that `sessions.lockOn` says `policy`.
    ///
    /// - Parameter existing: current file contents, or nil when there is no file.
    public static func settingLockOn(_ policy: SessionLockPolicy, in existing: Data?) throws -> Data {
        return try setting(
            section: LockPolicyResolution.configSectionKey,
            field: LockPolicyResolution.configFieldKey,
            to: policy.rawValue,
            in: existing
        )
    }

    static func setting(section: String, field: String, to value: String, in existing: Data?) throws -> Data {
        var root: [String: Any] = [:]
        if let existing, !existing.isEmpty {
            guard let parsed = try? JSONSerialization.jsonObject(with: existing) else {
                throw EditError.unparseable
            }
            guard let object = parsed as? [String: Any] else {
                throw EditError.notAnObject
            }
            root = object
        }

        var sectionObject = (root[section] as? [String: Any]) ?? [:]
        sectionObject[field] = value
        root[section] = sectionObject

        // Sorted and pretty-printed: this file is edited by hand as well, and a
        // write from the menu should not reshuffle it into one long line.
        let data = try JSONSerialization.data(
            withJSONObject: root,
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        )
        return data + Data("\n".utf8)
    }
}
