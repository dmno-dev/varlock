import Foundation
import CryptoKit
import LocalAuthentication
import IdentitySessions

/// Holds identity keys on behalf of unlocked sessions.
///
/// Two enclave keys are involved, and they do different jobs:
///
///   - the CUSTODY key is the existing biometric device key. It wraps the identity
///     private key at rest (that wrap blob is what the identity file stores), so
///     opening a session always goes through user presence.
///   - the SESSION key is created per unlock, with `.privateKeyUsage` only and no
///     presence requirement. Its key data lives in this process's memory and is
///     never written to disk.
///
/// At unlock the identity key is unwrapped once through the custody key and
/// immediately re-wrapped under the session key. Only that session-wrapped blob is
/// held. Each later decrypt unwraps it silently through the session key, uses the
/// identity key for the batch, and drops it again. Ending a session scrubs the
/// session key data, which crypto-erases every blob held under it.
///
/// Nothing here is persisted. A daemon restart loses all sessions on purpose: a
/// session-wrapped blob on disk plus a no-presence enclave key would open silently
/// after a reboot, which is exactly the biometric gate this is built to keep.
final class IdentitySessionManager {
    /// Max wait for the biometric prompt before giving up, matching `SessionManager`.
    static let biometricTimeoutSeconds: TimeInterval = 60

    /// How often expired grants are swept, so a hard-cap expiry erases key material
    /// even on a daemon nobody is talking to.
    static let pruneIntervalSeconds: TimeInterval = 60

    /// Which LocalAuthentication policy an unlock ran under.
    enum UnlockPolicy: String {
        case biometrics = "biometrics"
        case deviceOwner = "device-owner"
        /// The custody key carries no presence requirement (created with `--no-auth`
        /// for CI), so there was nothing to prompt for.
        case none = "no-presence-required"
    }

    struct UnlockOutcome {
        let grants: [SessionGrantInfo]
        let policy: UnlockPolicy
    }

    enum IdentitySessionError: LocalizedError {
        case noSessionIdentity
        case biometricFailed(String)
        case sessionKeyMissing
        case notUtf8

        var errorDescription: String? {
            switch self {
            case .noSessionIdentity:
                return "Cannot scope an unlock session for this process; no session identity could be determined"
            case .biometricFailed(let msg):
                return "Biometric authentication failed: \(msg)"
            case .sessionKeyMissing:
                return "The unlock session is no longer held by the daemon; unlock again"
            case .notUtf8:
                return "Decrypted data is not valid UTF-8"
            }
        }

        var code: String {
            switch self {
            case .noSessionIdentity: return "NO_SESSION_IDENTITY"
            case .biometricFailed: return "BIOMETRIC_FAILED"
            case .sessionKeyMissing: return "SESSION_KEY_MISSING"
            case .notUtf8: return "NOT_UTF8"
            }
        }
    }

    /// In-memory material for one unlocked session.
    private struct SessionMaterial {
        /// Ephemeral Secure Enclave key data representation. Opaque to us, useless
        /// without the enclave, and dropped (scrubbed) when the session ends.
        var sessionKeyData: Data
        /// identityId+keyId -> identity private key (PKCS#8 DER) wrapped to the session key
        var wrappedIdentities: [String: Data] = [:]
    }

    private var material: [String: SessionMaterial] = [:]
    private let grants: SessionGrantTable
    private let queue = DispatchQueue(label: "dev.varlock.identity-session")
    private var pruneTimer: DispatchSourceTimer?

    init(grants: SessionGrantTable = SessionGrantTable()) {
        self.grants = grants
        startPruneTimer()
    }

    deinit {
        pruneTimer?.cancel()
    }

    // MARK: - Unlock

    /// Open (or extend) a session: one user-presence check, however many keys.
    ///
    /// The single check is the whole point of the two-key model. We drive the
    /// biometric ourselves with `LAContext.evaluatePolicy` and then hand that
    /// authenticated context to the enclave operation, so the custody unwrap does
    /// not raise a second system sheet. `probe-session-unlock` proves that on a
    /// real machine; see the package README.
    func unlock(
        sessionId: String?,
        keyIds: [String],
        identityId: String,
        scope: SessionGrantScope,
        durationMs: Int64?
    ) throws -> UnlockOutcome {
        guard let sessionId, !sessionId.isEmpty else {
            throw IdentitySessionError.noSessionIdentity
        }
        let identity = try IdentityStore.read(identityId: identityId)

        // Fail before prompting if none of the requested keys can open this identity
        let usableKeyIds = keyIds.filter { identity.wraps[$0] != nil }
        guard !usableKeyIds.isEmpty else {
            throw IdentityStore.IdentityStoreError.noWrapForKey(
                identityId: identityId,
                keyId: keyIds.first ?? "unknown"
            )
        }

        let (context, policy) = try contextForUnlock(
            identityId: identityId,
            keyIds: usableKeyIds,
            probeWrap: identity.wraps[usableKeyIds[0]],
            probeKeyId: usableKeyIds[0]
        )
        defer { context.invalidate() }

        return try queue.sync {
            var granted: [SessionGrantInfo] = []

            for keyId in usableKeyIds {
                guard let wrapBase64 = identity.wraps[keyId] else { continue }
                guard let wrapData = Data(base64Encoded: wrapBase64) else {
                    throw IdentityStore.IdentityStoreError.malformed(identityId)
                }

                // Custody unwrap, under the context we already authenticated
                var identityKeyBase64 = try SecureEnclaveManager.decrypt(
                    payload: wrapData,
                    keyId: keyId,
                    context: context
                )
                defer { scrub(&identityKeyBase64) }
                var identityKeyDer = try RawBase64.decode(identityKeyBase64)
                defer { scrub(&identityKeyDer) }

                let sessionPublicKey = try ensureSessionKeyLocked(sessionId: sessionId)
                let rewrapped = try Ecies.encrypt(
                    plaintext: identityKeyDer,
                    to: sessionPublicKey,
                    version: Ecies.devicePayloadVersion
                )
                material[sessionId]?.wrappedIdentities[Self.blobKey(identityId, keyId)] = rewrapped

                granted.append(grants.grant(
                    ref: SessionGrantRef(sessionId: sessionId, keyId: keyId),
                    identityId: identityId,
                    scope: scope,
                    durationMs: durationMs
                ))
            }

            reconcileLocked()
            return UnlockOutcome(grants: granted, policy: policy)
        }
    }

    // MARK: - Decrypt

    /// Decrypt a batch of v2 payloads under a live grant. No prompt, no key on the wire.
    ///
    /// The batch is one grant use: a `once` grant covers this call and is then spent,
    /// however many payloads it carried.
    func decryptV2(
        sessionId: String?,
        keyId: String,
        identityId: String,
        payloads: [Data]
    ) throws -> (plaintexts: [String], grant: SessionGrantInfo) {
        guard let sessionId, !sessionId.isEmpty else {
            throw IdentitySessionError.noSessionIdentity
        }

        return try queue.sync {
            let ref = SessionGrantRef(sessionId: sessionId, keyId: keyId)
            let consumed: (info: SessionGrantInfo, change: SessionGrantChange)
            do {
                consumed = try grants.consume(ref: ref)
            } catch {
                reconcileLocked()
                throw error
            }

            guard let held = material[sessionId],
                  let wrapped = held.wrappedIdentities[Self.blobKey(identityId, keyId)] else {
                reconcileLocked()
                throw IdentitySessionError.sessionKeyMissing
            }

            // Silent unwrap through the session key: no presence flag, no prompt
            let sessionKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(
                dataRepresentation: held.sessionKeyData
            )
            var identityKeyDer = try Ecies.decrypt(
                payload: wrapped,
                using: sessionKey,
                acceptedVersions: [Ecies.devicePayloadVersion]
            )
            defer { scrub(&identityKeyDer) }
            let identityKey = try IdentityKeyImport.p256KeyAgreementKey(fromPkcs8: identityKeyDer)

            var plaintexts: [String] = []
            plaintexts.reserveCapacity(payloads.count)
            for payload in payloads {
                var decrypted = try Ecies.decrypt(
                    payload: payload,
                    using: identityKey,
                    acceptedVersions: [Ecies.identityPayloadVersion]
                )
                defer { scrub(&decrypted) }
                guard let text = String(data: decrypted, encoding: .utf8) else {
                    throw IdentitySessionError.notUtf8
                }
                plaintexts.append(text)
            }

            if !consumed.change.closedSessions.isEmpty {
                reconcileLocked()
            }
            return (plaintexts, consumed.info)
        }
    }

    // MARK: - Listing and invalidation

    func listGrants() -> [[String: Any]] {
        return queue.sync {
            reconcileLocked()
            let now = grants.nowMs()
            return grants.list().map { $0.toDictionary(now: now) }
        }
    }

    /// Drop grants and crypto-erase any session left holding nothing.
    ///
    /// Omitting both arguments drops everything, which is what the argument-less
    /// `invalidate-session` has always done.
    @discardableResult
    func invalidate(sessionId: String? = nil, keyId: String? = nil) -> Int {
        return queue.sync {
            let change = grants.invalidate(sessionId: sessionId, keyId: keyId)
            reconcileLocked()
            return change.dropped
        }
    }

    /// Whether the daemon is holding anything. Gates the idle auto-quit.
    func hasLiveSessions() -> Bool {
        return queue.sync {
            reconcileLocked()
            return grants.hasLiveSessions()
        }
    }

    // MARK: - Authentication

    /// Get a context the custody unwrap can run under, prompting only if it must.
    ///
    /// A key created with `--no-auth` (CI) has no presence requirement, and asking
    /// the machine is more reliable than trying to read the access control back off
    /// a stored key. So we try one non-interactive unwrap first: it either works,
    /// which proves there was no gate to satisfy, or it fails and we authenticate
    /// for real. A gated key can never be opened by that probe, so this cannot
    /// weaken the gate; it only avoids prompting where there is nothing to prompt for.
    private func contextForUnlock(
        identityId: String,
        keyIds: [String],
        probeWrap: String?,
        probeKeyId: String
    ) throws -> (LAContext, UnlockPolicy) {
        if let probeWrap, let probeData = Data(base64Encoded: probeWrap) {
            let silent = LAContext()
            silent.interactionNotAllowed = true
            if var probed = try? SecureEnclaveManager.decrypt(
                payload: probeData,
                keyId: probeKeyId,
                context: silent
            ) {
                scrub(&probed)
                return (silent, .none)
            }
            silent.invalidate()
        }
        return try authenticate(identityId: identityId, keyIds: keyIds)
    }

    /// One user-presence check, then hand the authenticated context to the enclave.
    private func authenticate(identityId: String, keyIds: [String]) throws -> (LAContext, UnlockPolicy) {
        let context = LAContext()

        // Prefer biometrics. Machines with no enrolled sensor (or a locked-out one)
        // fall back to the broader policy, which also accepts Apple Watch and the
        // device password, rather than losing the feature entirely.
        var policy: LAPolicy = .deviceOwnerAuthenticationWithBiometrics
        var resolved: UnlockPolicy = .biometrics
        var policyError: NSError?
        if !context.canEvaluatePolicy(policy, error: &policyError) {
            policy = .deviceOwnerAuthentication
            resolved = .deviceOwner
            var fallbackError: NSError?
            guard context.canEvaluatePolicy(policy, error: &fallbackError) else {
                throw IdentitySessionError.biometricFailed(
                    fallbackError?.localizedDescription ?? "Authentication not available"
                )
            }
        }

        let semaphore = DispatchSemaphore(value: 0)
        var evalError: Error?
        context.evaluatePolicy(policy, localizedReason: Self.unlockReason(identityId: identityId, keyIds: keyIds)) { success, error in
            if !success { evalError = error }
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + Self.biometricTimeoutSeconds) == .timedOut {
            context.invalidate()
            throw IdentitySessionError.biometricFailed(
                "Prompt timed out after \(Int(Self.biometricTimeoutSeconds))s"
            )
        }
        if let evalError {
            throw IdentitySessionError.biometricFailed(evalError.localizedDescription)
        }

        // From here on the context must not raise UI of its own. If the enclave
        // operation still wanted a prompt we would rather fail loudly than show the
        // user a second sheet for one unlock.
        context.interactionNotAllowed = true
        return (context, resolved)
    }

    /// Plain, informative prompt copy. No new dialogs in this change: this is the
    /// system sheet's reason line.
    static func unlockReason(identityId: String, keyIds: [String]) -> String {
        let keyList = keyIds.sorted().joined(separator: ", ")
        if identityId == IdentityStore.defaultIdentityId {
            return "unlock varlock encryption key \(keyList)"
        }
        return "unlock varlock identity \"\(identityId)\" with key \(keyList)"
    }

    // MARK: - Session key material

    /// Create the session's enclave key if it has none, and return its public key.
    /// Caller must hold `queue`.
    @discardableResult
    private func ensureSessionKeyLocked(sessionId: String) throws -> P256.KeyAgreement.PublicKey {
        if let existing = material[sessionId] {
            let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: existing.sessionKeyData)
            return key.publicKey
        }
        let key = try SecureEnclaveManager.createEphemeralSessionKey()
        material[sessionId] = SessionMaterial(sessionKeyData: key.dataRepresentation)
        return key.publicKey
    }

    /// Erase material for every session the grant table no longer considers live.
    /// Caller must hold `queue`.
    private func reconcileLocked() {
        grants.pruneExpired()
        let live = Set(grants.liveSessionIds())
        for sessionId in material.keys where !live.contains(sessionId) {
            eraseLocked(sessionId: sessionId)
        }
    }

    /// Crypto-erase: scrubbing the session key data makes every blob wrapped under
    /// it unreadable, since the enclave half of that key is unreachable without it.
    /// Caller must hold `queue`.
    private func eraseLocked(sessionId: String) {
        guard var held = material.removeValue(forKey: sessionId) else { return }
        scrub(&held.sessionKeyData)
        for key in Array(held.wrappedIdentities.keys) {
            if var blob = held.wrappedIdentities.removeValue(forKey: key) {
                scrub(&blob)
            }
        }
    }

    private static func blobKey(_ identityId: String, _ keyId: String) -> String {
        return "\(identityId)\u{0}\(keyId)"
    }

    private func startPruneTimer() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + Self.pruneIntervalSeconds, repeating: Self.pruneIntervalSeconds)
        timer.setEventHandler { [weak self] in
            self?.reconcileLocked()
        }
        timer.resume()
        pruneTimer = timer
    }
}
