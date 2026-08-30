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
        /// The resolved lock policy and where it came from
        let lockOn: SessionLockPolicy
        let lockOnSource: LockPolicyResolution.Source
        /// Whether the user was actually shown the approval panel for this call.
        let prompted: Bool
    }

    /// What the daemon knows about who is asking, gathered before any panel.
    ///
    /// `requesterLines` are derived by the daemon from the peer process itself and
    /// are the trust-bearing part. `display` is decoration the client sent: it
    /// changes the wording, never the decision.
    struct UnlockRequestContext {
        var requesterLines: [String] = []
        var display: UnlockDisplayInfo = UnlockDisplayInfo()
    }

    /// The answer to an approval panel, or the reason there wasn't one.
    enum UnlockPromptOutcome {
        case approved(PanelDecision)
        case denied
        /// No window server, so nobody could be asked.
        case noUi
    }

    enum IdentitySessionError: LocalizedError {
        case noSessionIdentity
        case biometricFailed(String)
        case sessionKeyMissing
        case notUtf8
        case approvalDenied
        case noUi

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
            case .approvalDenied:
                return "The unlock was not approved"
            case .noUi:
                return "This Mac has no screen available to approve on; run this from a desktop session"
            }
        }

        var code: String {
            switch self {
            case .noSessionIdentity: return "NO_SESSION_IDENTITY"
            case .biometricFailed: return "BIOMETRIC_FAILED"
            case .sessionKeyMissing: return "SESSION_KEY_MISSING"
            case .notUtf8: return "NOT_UTF8"
            case .approvalDenied: return "APPROVAL_DENIED"
            case .noUi: return "NO_UI"
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

    /// Shows the approval panel. Injected so the manager never imports the view,
    /// and so a caller with no display can be told `NO_UI` instead of guessing.
    var promptHandler: ((PanelContent) -> UnlockPromptOutcome)?

    /// How often a given key must be re-approved. Injected for the same reason:
    /// the policy lives on disk next to the key, which is not this type's job.
    var keyPolicy: (String) -> KeyAuthPolicy = { _ in .standard }

    init(grants: SessionGrantTable = SessionGrantTable()) {
        self.grants = grants
        startPruneTimer()
    }

    deinit {
        pruneTimer?.cancel()
    }

    // MARK: - Unlock

    /// Open (or extend) a session: one approval, one user-presence check, however
    /// many keys.
    ///
    /// The order matters. The panel comes first, because it is the part that says
    /// who is asking and what they get; the system's biometric sheet can only say
    /// "varlock wants something". Only after the user has approved do we drive
    /// `LAContext.evaluatePolicy` and hand that authenticated context to the
    /// enclave operation, so the custody unwrap does not raise a second sheet.
    /// `probe-session-unlock` proves that handoff on a real machine; see the
    /// package README.
    func unlock(
        sessionId: String?,
        keyIds: [String],
        identityId: String,
        scope: SessionGrantScope,
        durationMs: Int64?,
        lockOnOverride: String? = nil,
        requestContext: UnlockRequestContext = UnlockRequestContext()
    ) throws -> UnlockOutcome {
        guard let sessionId, !sessionId.isEmpty else {
            throw IdentitySessionError.noSessionIdentity
        }
        let identity = try IdentityStore.read(identityId: identityId)

        // What this unlock asked for, else the machine config, else the default.
        // Read fresh so editing the config file needs no daemon restart.
        let lockPolicy = LockPolicyResolution.resolve(
            overrideWireValue: lockOnOverride,
            machineConfigData: IdentityStore.readMachineConfigData()
        )

        // Fail before prompting if none of the requested keys can open this identity
        let usableKeyIds = keyIds.filter { identity.wraps[$0] != nil }
        guard !usableKeyIds.isEmpty else {
            throw IdentityStore.IdentityStoreError.noWrapForKey(
                identityId: identityId,
                keyId: keyIds.first ?? "unknown"
            )
        }

        // A key created with `--no-auth` has no gate to satisfy, so there is
        // nothing to approve and nothing to scan: that path stays silent.
        let silentContext = silentContextIfUngated(
            probeWrap: identity.wraps[usableKeyIds[0]],
            probeKeyId: usableKeyIds[0]
        )
        let needsPresence = silentContext == nil
        let mustAsk = needsPresence || UiAvailability.isPromptForced

        var keysToOpen = usableKeyIds
        var carriedGrants: [SessionGrantInfo] = []
        var chosenScope = scope
        var chosenDurationMs = durationMs
        var prompted = false

        if mustAsk {
            let plan = planUnlock(
                sessionId: sessionId,
                keyIds: usableKeyIds,
                scope: scope,
                durationMs: durationMs,
                display: requestContext.display
            )

            guard plan.requiresPrompt else {
                // Everything asked for is already covered by a live grant. Asking
                // again would be a prompt that changes nothing, so we hand back
                // what the session already holds.
                silentContext?.invalidate()
                let live = liveGrants(sessionId: sessionId, keyIds: usableKeyIds)
                return UnlockOutcome(
                    grants: live,
                    policy: needsPresence ? .biometrics : .none,
                    // Nothing was re-granted, so the live grants keep the policy
                    // they were opened under rather than taking this call's.
                    lockOn: live.first?.lockOn ?? lockPolicy.policy,
                    lockOnSource: lockPolicy.source,
                    prompted: false
                )
            }

            let content = UnlockPanelContent.build(
                plan: plan,
                requesterLines: requestContext.requesterLines,
                display: requestContext.display
            )
            switch promptHandler?(content) ?? .noUi {
            case .noUi:
                silentContext?.invalidate()
                throw IdentitySessionError.noUi
            case .denied:
                silentContext?.invalidate()
                throw IdentitySessionError.approvalDenied
            case .approved(let decision):
                chosenScope = decision.scope
                chosenDurationMs = decision.durationMs
            }

            prompted = true
            keysToOpen = plan.promptKeys.map { $0.keyId }
            carriedGrants = liveGrants(sessionId: sessionId, keyIds: plan.coveredKeys.map { $0.keyId })
        }

        let context: LAContext
        let policy: UnlockPolicy
        if let silentContext {
            context = silentContext
            policy = .none
        } else {
            // The system sheet repeats what the panel just said, so the two cannot
            // disagree about which keys this scan is paying for.
            (context, policy) = try authenticate(reason: Self.unlockReason(
                identityId: identityId,
                keyIds: keysToOpen,
                requesterSummary: requestContext.requesterLines.first
            ))
        }
        defer { context.invalidate() }

        return try queue.sync {
            var granted: [SessionGrantInfo] = carriedGrants

            for keyId in keysToOpen {
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

                // A key set to ask every time only ever takes a `once` grant, no
                // matter what the rest of the batch was approved for.
                let policyForKey = keyPolicy(keyId)
                granted.append(grants.grant(
                    ref: SessionGrantRef(sessionId: sessionId, keyId: keyId),
                    identityId: identityId,
                    scope: UnlockPlanner.effectiveScope(chosen: chosenScope, policy: policyForKey),
                    durationMs: UnlockPlanner.effectiveDurationMs(
                        chosen: chosenScope,
                        chosenDurationMs: chosenDurationMs,
                        policy: policyForKey
                    ),
                    lockOn: lockPolicy.policy
                ))
            }

            reconcileLocked()
            return UnlockOutcome(
                grants: granted,
                policy: policy,
                lockOn: lockPolicy.policy,
                lockOnSource: lockPolicy.source,
                prompted: prompted
            )
        }
    }

    // MARK: - Planning

    /// Work out what this unlock still has to ask about.
    ///
    /// The rules themselves live in `UnlockPlanner`, which knows nothing about
    /// enclaves or windows and is unit tested on its own. All this does is read
    /// the live grants and each key's policy and hand them over.
    private func planUnlock(
        sessionId: String,
        keyIds: [String],
        scope: SessionGrantScope,
        durationMs: Int64?,
        display: UnlockDisplayInfo
    ) -> UnlockPlan {
        return queue.sync {
            var existing: [String: ExistingGrantSnapshot] = [:]
            for keyId in keyIds {
                guard let live = grants.liveGrant(ref: SessionGrantRef(sessionId: sessionId, keyId: keyId)) else {
                    continue
                }
                existing[keyId] = ExistingGrantSnapshot(scope: live.scope, remainingMs: live.remainingMs)
            }
            let requested = keyIds.map {
                RequestedKey(keyId: $0, policy: keyPolicy($0), itemCount: display.itemCounts[$0])
            }
            return UnlockPlanner.plan(
                requested: requested,
                requestedScope: scope,
                requestedDurationMs: durationMs,
                existing: existing
            )
        }
    }

    /// Live grants for the named keys, for the keys that still have one.
    private func liveGrants(sessionId: String, keyIds: [String]) -> [SessionGrantInfo] {
        return queue.sync {
            keyIds.compactMap { grants.liveGrant(ref: SessionGrantRef(sessionId: sessionId, keyId: $0)) }
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

    /// Every live grant, typed. The menu bar reads this; `listGrants` is the same
    /// thing flattened for the wire.
    func liveGrantInfos() -> [SessionGrantInfo] {
        return queue.sync {
            reconcileLocked()
            return grants.list()
        }
    }

    func listGrants() -> [[String: Any]] {
        return liveGrantInfos().map { $0.toDictionary() }
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

    /// Handle a system lock event, erasing only the sessions whose own policy says
    /// this event ends them.
    ///
    /// Separate from `invalidate()`, which is the explicit lock and always erases
    /// everything. Called by the notification observers, and directly by tests.
    @discardableResult
    func handleLockEvent(_ event: SessionLockEvent) -> Int {
        return queue.sync {
            let change = grants.invalidate(onLockEvent: event)
            reconcileLocked()
            return change.dropped
        }
    }

    /// The lock policy a live session resolved to, for tests and diagnostics.
    func lockPolicy(forSession sessionId: String) -> SessionLockPolicy? {
        return queue.sync {
            return grants.lockPolicy(forSession: sessionId)
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

    /// A context the custody unwrap can run under with no gate at all, if this key
    /// turns out not to have one. Returns nil when the key is presence gated.
    ///
    /// A key created with `--no-auth` (CI) has no presence requirement, and asking
    /// the machine is more reliable than trying to read the access control back off
    /// a stored key. So we try one non-interactive unwrap first: it either works,
    /// which proves there was no gate to satisfy, or it fails and the caller has to
    /// ask for real. A gated key can never be opened by that probe, so this cannot
    /// weaken the gate; it only avoids asking where there is nothing to ask about.
    private func silentContextIfUngated(probeWrap: String?, probeKeyId: String) -> LAContext? {
        guard let probeWrap, let probeData = Data(base64Encoded: probeWrap) else { return nil }
        let silent = LAContext()
        silent.interactionNotAllowed = true
        if var probed = try? SecureEnclaveManager.decrypt(
            payload: probeData,
            keyId: probeKeyId,
            context: silent
        ) {
            scrub(&probed)
            return silent
        }
        silent.invalidate()
        return nil
    }

    /// One user-presence check with no key operation attached, used by
    /// `request-approval` when the caller asks for a biometric on top of the panel.
    func verifyUserPresence(reason: String) throws {
        let (context, _) = try authenticate(reason: reason)
        context.invalidate()
    }

    /// One user-presence check, then hand the authenticated context to the enclave.
    private func authenticate(reason: String) throws -> (LAContext, UnlockPolicy) {
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
        context.evaluatePolicy(policy, localizedReason: reason) { success, error in
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

    /// Plain, informative prompt copy for the system sheet's reason line. It says
    /// the same thing the panel said, so a user who reads only one of them is not
    /// told two different stories.
    static func unlockReason(identityId: String, keyIds: [String], requesterSummary: String? = nil) -> String {
        let keyList = keyIds.sorted().joined(separator: ", ")
        var reason: String
        if identityId == IdentityStore.defaultIdentityId {
            reason = "unlock varlock encryption key \(keyList)"
        } else {
            reason = "unlock varlock identity \"\(identityId)\" with key \(keyList)"
        }
        if let requesterSummary, !requesterSummary.isEmpty {
            reason += ", \(requesterSummary.prefix(80))"
        }
        return reason
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
