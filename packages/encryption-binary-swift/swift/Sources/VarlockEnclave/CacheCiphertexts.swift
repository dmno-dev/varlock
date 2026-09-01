import Foundation
import IdentitySessions

/// The ciphertexts varlock's own value cache is holding for one key, by digest.
///
/// This is how "the value cache is never item scoped" becomes something the
/// daemon ENFORCES rather than something it takes the client's word for.
///
/// The alternative was a flag on the request saying "this batch is a cache
/// read", which is not a rule, it is a request to be excused from one: any
/// client could set it and a narrow approval would cover everything again. So
/// the daemon answers the question itself. It computes the cache's path from its
/// own idea of the user varlock directory, reads the file, and admits a
/// ciphertext only if the cache is actually holding it. No path, name, or
/// membership claim from the socket is involved.
///
/// What this does NOT defend against: anything running as this user can write
/// into that file, so a determined client could park a ciphertext there and read
/// it back. That is worth being plain about. Item scope is a guard against a
/// legitimate client opening more than the panel described, and it holds
/// completely against that; it is not a boundary against a hostile process
/// running as the user, which the cache file was never one either.
///
/// Cached in memory against the file's identity, so a batch of cache reads costs
/// one parse rather than one per payload, and a rewritten cache is picked up on
/// the next read rather than at some interval.
enum CacheCiphertexts {
    /// Mirror of `CacheStore`'s own path in the TS library.
    static func cacheFilePath(keyId: String) -> String {
        return IdentityStore.userVarlockDir + "/cache/\(keyId).json"
    }

    private struct Snapshot {
        let modified: Date
        let size: Int
        let digests: Set<String>
    }

    private static var snapshots: [String: Snapshot] = [:]
    private static let lock = NSLock()

    /// The digests the cache for this key is currently holding.
    ///
    /// Empty for a key with no cache file, which is the common case and costs a
    /// single `stat`.
    static func digests(keyId: String) -> Set<String> {
        let path = cacheFilePath(keyId: keyId)
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let modified = attributes[.modificationDate] as? Date,
              let size = (attributes[.size] as? NSNumber)?.intValue else {
            lock.lock()
            snapshots.removeValue(forKey: keyId)
            lock.unlock()
            return []
        }

        lock.lock()
        if let cached = snapshots[keyId], cached.modified == modified, cached.size == size {
            defer { lock.unlock() }
            return cached.digests
        }
        lock.unlock()

        let digests = read(path: path)
        lock.lock()
        snapshots[keyId] = Snapshot(modified: modified, size: size, digests: digests)
        lock.unlock()
        return digests
    }

    /// Parse the cache file's shape: `{ "<cache key>": { "v": "<base64>", ... } }`.
    ///
    /// Only the ciphertexts are read. Cache keys name providers and resolver
    /// paths and are nobody's business here; nothing is decrypted, and a file
    /// that will not parse contributes nothing rather than failing a decrypt.
    private static func read(path: String) -> Set<String> {
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return []
        }
        var digests = Set<String>()
        for (_, entry) in json {
            guard let entry = entry as? [String: Any],
                  let ciphertext = entry["v"] as? String,
                  let payload = Data(base64Encoded: ciphertext) else { continue }
            digests.insert(GrantItemDigest.of(payload))
        }
        return digests
    }

    /// Forget what was read, so a test can move the file around underneath us.
    static func resetForTesting() {
        lock.lock()
        snapshots.removeAll()
        lock.unlock()
    }
}
