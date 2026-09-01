import Foundation
import IdentitySessions

/// Where the remembered narrowings live on disk.
///
/// Under the user's varlock directory, beside the identities, the audit log and
/// the machine config. Never in a project: what this machine will hand over is
/// this machine's business, and a preference committed to a repository is a
/// preference anyone who can open a pull request gets to set.
///
/// Read fresh at every panel, like the machine config, so deleting the file (or
/// a `varlock lock --forget-preferences`) takes effect on the next unlock with
/// no daemon restart.
enum UnlockPreferenceStore {
    static var filePath: String {
        return IdentityStore.userVarlockDir + "/" + UnlockPreferences.fileName
    }

    static func load() -> [String: UnlockNarrowing] {
        guard let data = FileManager.default.contents(atPath: filePath) else { return [:] }
        return UnlockPreferences.decode(data)
    }

    /// What is remembered for one project and key, if anything.
    static func narrowing(projectPath: String?, keyId: String) -> UnlockNarrowing? {
        guard let rowKey = UnlockPreferences.rowKey(projectPath: projectPath, keyId: keyId) else { return nil }
        return load()[rowKey]
    }

    /// Fold an approval in: remember what was tightened, forget what was not.
    ///
    /// Best effort. A preference that cannot be written costs the next panel a
    /// slightly broader preselection, which is a nuisance; failing an unlock the
    /// user already approved over it would be worse.
    static func record(
        projectPath: String?,
        keyIds: [String],
        breadth: SessionGrantBreadth,
        window: GrantWindow
    ) {
        guard projectPath != nil, !keyIds.isEmpty else { return }
        var rows = load()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        for keyId in keyIds {
            rows = UnlockPreferences.apply(
                rows: rows,
                rowKey: UnlockPreferences.rowKey(projectPath: projectPath, keyId: keyId),
                breadth: breadth,
                window: window,
                now: now
            )
        }
        write(rows)
    }

    /// Forget rows. No arguments forgets everything on this machine.
    @discardableResult
    static func forget(projectPath: String? = nil, keyId: String? = nil) -> Int {
        let result = UnlockPreferences.forget(rows: load(), projectPath: projectPath, keyId: keyId)
        write(result.rows)
        return result.forgotten
    }

    private static func write(_ rows: [String: UnlockNarrowing]) {
        guard let data = UnlockPreferences.encode(rows) else { return }
        let directory = (filePath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        // Written through a temporary file so a crash mid-write cannot leave a
        // half-parsed preferences file behind. A file that fails to parse is
        // treated as empty, which is safe, but it would also silently throw away
        // every narrowing the user had chosen.
        let temporary = filePath + ".tmp"
        guard FileManager.default.createFile(
            atPath: temporary,
            contents: data,
            attributes: [.posixPermissions: 0o600]
        ) else { return }
        _ = try? FileManager.default.replaceItemAt(
            URL(fileURLWithPath: filePath),
            withItemAt: URL(fileURLWithPath: temporary)
        )
        try? FileManager.default.removeItem(atPath: temporary)
    }
}
