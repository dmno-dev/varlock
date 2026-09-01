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
    /// `requester` is derived by the daemon from the peer process itself and is
    /// the trust-bearing part. `display` is decoration the client sent: it changes
    /// the wording, never the decision.
    struct UnlockRequestContext {
        var requester: PanelRequester = PanelRequester(summary: "")
        var display: UnlockDisplayInfo = UnlockDisplayInfo()
        /// The ciphertexts this unlock is being asked to cover, by key id.
        ///
        /// The one part of a request that is neither derived nor decoration. The
        /// client sends payloads; the daemon hashes them itself, and those
        /// digests are what an item-scoped grant is bound to. A label the client
        /// attached to a payload never reaches here: that decides what the panel
        /// says, this decides what the grant opens.
        var itemDigests: [String: Set<String>] = [:]
    }

    /// The answer to an approval panel, or the reason there wasn't one.
    enum UnlockPromptOutcome {
        /// Approved, with the presence check that approved it. The proof is what
        /// keeps a single scan covering the enclave work that follows.
        case approved(PanelDecision, PresenceProof?)
        case denied
        /// No window server, so nobody could be asked.
        case noUi
    }

    enum IdentitySessionError: LocalizedError {
        case noSessionIdentity
        case noKeysRequested
        case biometricFailed(String)
        case sessionKeyMissing
        case notUtf8
        case approvalDenied
        case noUi

        var errorDescription: String? {
            switch self {
            case .noSessionIdentity:
                return "Cannot scope an unlock session for this process; no session identity could be determined"
            case .noKeysRequested:
                return "No key ids were named to unlock; send keyIds (or keyId) in the payload"
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
            case .noKeysRequested: return "NO_KEYS_REQUESTED"
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
    private let audit: AuthorizationAuditLog
    private let queue = DispatchQueue(label: "dev.varlock.identity-session")
    private var pruneTimer: DispatchSourceTimer?

    /// Shows the approval panel. Injected so the manager never imports the view,
    /// and so a caller with no display can be told `NO_UI` instead of guessing.
    ///
    /// The panel is handed the presence attempt so it can bind the embedded prompt
    /// to that context, and hands back the authenticated context it produced.
    var promptHandler: ((PanelContent, String, PresenceAttempt?) -> UnlockPromptOutcome)?

    /// How often a given key must be re-approved. Injected for the same reason:
    /// the policy lives on disk next to the key, which is not this type's job.
    var keyPolicy: (String) -> KeyAuthPolicy = { _ in .standard }

    /// Whether Touch ID still has to be set up for varlock on this machine (or
    /// set up again, after the enrolment changed). Injected because where that is
    /// recorded is the store's business, not this type's.
    var needsBiometricSetup: () -> Bool = { false }

    /// Remember that the setup scan just happened.
    var recordBiometricSetup: () -> Void = {}

    init(
        grants: SessionGrantTable = SessionGrantTable(),
        audit: AuthorizationAuditLog = AuthorizationAuditLog(directoryPath: IdentityStore.auditDir)
    ) {
        self.grants = grants
        self.audit = audit
        startPruneTimer()
    }

    deinit {
        pruneTimer?.cancel()
    }

    // MARK: - Unlock

    /// Open (or extend) a session: one approval, one user-presence check, however
    /// many keys.
    ///
    /// The approval and the scan are the same gesture. The panel arms an embedded
    /// Touch ID prompt bound to the context this unlock will run under, so the
    /// window that says who is asking is also the window the finger lands on, and
    /// no separate system dialog appears. The context that scan authenticated is
    /// then handed straight to the enclave operation, which is what keeps one scan
    /// covering the whole unlock. `probe-embedded-unlock` proves that handoff on a
    /// real machine; see the package README.
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
        // A caller that named no key has asked for nothing. Picking a key for it
        // would hand it a grant it never requested, so say so instead.
        guard !keyIds.isEmpty else {
            throw IdentitySessionError.noKeysRequested
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
        // The broad answer, which is what an unlock covered before there was a
        // choice. Only a panel can narrow it: a caller cannot ask for item scope
        // and a caller cannot ask to be let out of one.
        var chosenBreadth = SessionGrantBreadth.wholeKey
        var prompted = false
        var presenceProof: PresenceProof?

        if mustAsk {
            let plan = planUnlock(
                sessionId: sessionId,
                keyIds: usableKeyIds,
                scope: scope,
                durationMs: durationMs,
                display: requestContext.display,
                itemDigests: requestContext.itemDigests
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

            // Where the two controls open, and why. One rule, in one place: the
            // narrowest of the broad default, the risk this request carries, and
            // any narrowing the user chose here before.
            let projectPath = requestContext.display.projectPath
            let remembered = rememberedNarrowing(projectPath: projectPath, keyIds: plan.promptKeys.map { $0.keyId })
            let preselection = UnlockDefaults.preselect(
                signals: UnlockRiskSignals.read(
                    chain: requestContext.requester.chain,
                    projectPath: projectPath,
                    seenBefore: remembered?.approvedBefore ?? false
                ),
                remembered: remembered,
                offeredBreadths: plan.offeredBreadths,
                offeredScopes: plan.offeredScopes
            )
            let content = UnlockPanelContent.build(
                plan: plan,
                requester: requestContext.requester,
                display: requestContext.display,
                preselection: preselection
            )
            // The system's sheet is built from the same content the panel draws,
            // so the two can never tell different stories. It stays a short verb
            // phrase: the sheet lands on top of the panel, and a sheet that
            // repeats who is asking is the panel's job done twice and worse.
            let reason = content.presenceReason
            // Setup first, alone, and only then the panel: see
            // `runBiometricSetupIfNeeded`. The attempt the panel arms is created
            // afterwards, so the scan that set Touch ID up cannot be the scan
            // that approves this unlock.
            if needsPresence {
                do {
                    try runBiometricSetupIfNeeded()
                } catch {
                    silentContext?.invalidate()
                    throw error
                }
            }

            // No presence check to make when the key is ungated: the panel is only
            // up because a prompt was forced, so it keeps its plain button.
            let attempt = needsPresence ? beginPresence() : nil

            switch promptHandler?(content, reason, attempt) ?? .noUi {
            case .noUi:
                silentContext?.invalidate()
                attempt?.context.invalidate()
                throw IdentitySessionError.noUi
            case .denied:
                silentContext?.invalidate()
                attempt?.context.invalidate()
                throw IdentitySessionError.approvalDenied
            case .approved(let decision, let proof):
                chosenScope = decision.scope
                chosenDurationMs = decision.durationMs
                // A breadth the panel never offered cannot be chosen, whatever
                // comes back: the answer is clamped to the question that was asked.
                chosenBreadth = plan.offeredBreadths.contains(decision.breadth) ? decision.breadth : .wholeKey
                presenceProof = proof
                // Remember only a narrowing, and forget one by choosing the
                // default again. Best effort: a preference that will not write
                // must never cost somebody an unlock they just approved.
                UnlockPreferenceStore.record(
                    projectPath: projectPath,
                    keyIds: plan.promptKeys.map { $0.keyId },
                    breadth: chosenBreadth,
                    window: GrantWindow(scope: chosenScope, durationMs: chosenDurationMs)
                )
            }

            prompted = true
            keysToOpen = plan.promptKeys.map { $0.keyId }
            carriedGrants = liveGrants(sessionId: sessionId, keyIds: plan.coveredKeys.map { $0.keyId })
        }

        let context: LAContext
        let policy: UnlockPolicy
        // The scan (or password) the user already gave. Reusing that exact context
        // is the single-scan promise: a fresh one here would raise a second prompt.
        let probeKeyId = keysToOpen.first
        let usableProof = presenceProof.flatMap { proof in
            proofOpensKey(proof, keyId: probeKeyId, wrap: probeKeyId.flatMap { identity.wraps[$0] })
                ? proof
                : nil
        }
        if let silentContext {
            context = silentContext
            policy = .none
        } else if let usableProof {
            context = usableProof.context
            policy = usableProof.policy
        } else {
            // Nothing has asked yet, or what the panel came back with turned out
            // not to satisfy this key's gate. Asking again costs the user a second
            // prompt, which is better than failing an unlock they already answered.
            presenceProof?.context.invalidate()
            (context, policy) = try authenticate(reason: UnlockPanelContent.presenceReason(
                forKeyIds: keysToOpen,
                display: requestContext.display
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
                    lockOn: lockPolicy.policy,
                    // A narrow grant is bound to the digests the daemon computed
                    // for this request, and to nothing else. A key that arrived
                    // with no digests cannot be narrowed to them (that would be a
                    // grant that opens nothing), so it keeps the whole key.
                    coveredItems: coveredItems(
                        breadth: chosenBreadth,
                        digests: requestContext.itemDigests[keyId]
                    )
                ))
            }

            // A session the daemon holds with no record of who opened it is the
            // hole this log exists to close, so an unlock that cannot be recorded
            // gives its keys straight back.
            do {
                try audit.append(AuthorizationRecord(
                    kind: .unlock,
                    sessionId: sessionId,
                    keyIds: keysToOpen.sorted(),
                    identityId: identityId,
                    scope: chosenScope.rawValue,
                    breadth: chosenBreadth.rawValue,
                    coveredItemCount: chosenBreadth == .listedItems
                        ? granted.compactMap { $0.coveredItemCount }.reduce(0, +)
                        : nil,
                    requester: requestContext.requester.summary
                ))
            } catch {
                for keyId in keysToOpen {
                    grants.invalidate(sessionId: sessionId, keyId: keyId)
                }
                reconcileLocked()
                throw error
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

    // MARK: - Breadth

    /// What a chosen breadth means for one key's grant.
    ///
    /// `nil` is the whole key. A key that arrived with no digests keeps the
    /// whole key even under a narrow choice: binding it to an empty set would
    /// be a grant that opens nothing, which is a broken unlock dressed up as a
    /// careful one. The panel only offers the narrow choice when every key in
    /// the question brought digests, so this is the belt to that braces.
    private func coveredItems(breadth: SessionGrantBreadth, digests: Set<String>?) -> Set<String>? {
        guard breadth == .listedItems, let digests, !digests.isEmpty else { return nil }
        return digests
    }

    /// The narrowing this Mac remembers for a batch, if any.
    ///
    /// Several keys in one question are folded into the narrowest thing any of
    /// them remembers, and `approvedBefore` holds only when EVERY key has been
    /// approved here before. Both fold in the restrictive direction on purpose:
    /// a memory can only ever tighten a preselection, so a fold that guesses
    /// wrong costs a panel rather than an over-broad grant.
    private func rememberedNarrowing(projectPath: String?, keyIds: [String]) -> UnlockNarrowing? {
        guard projectPath != nil, !keyIds.isEmpty else { return nil }
        let rows = keyIds.map { UnlockPreferenceStore.narrowing(projectPath: projectPath, keyId: $0) }
        let breadths = rows.compactMap { $0?.breadth }
        let windows = rows.compactMap { $0?.window }
        let seenAll = rows.allSatisfy { $0?.approvedBefore == true }
        let folded = UnlockNarrowing(
            breadth: breadths.isEmpty ? nil : SessionGrantBreadth.narrowest(breadths),
            window: windows.isEmpty ? nil : GrantWindow.narrowest(windows),
            approvedBefore: seenAll
        )
        return folded.isEmpty ? nil : folded
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
        display: UnlockDisplayInfo,
        itemDigests: [String: Set<String>] = [:]
    ) -> UnlockPlan {
        return queue.sync {
            var existing: [String: ExistingGrantSnapshot] = [:]
            for keyId in keyIds {
                let ref = SessionGrantRef(sessionId: sessionId, keyId: keyId)
                guard let live = grants.liveGrant(ref: ref) else { continue }
                existing[keyId] = ExistingGrantSnapshot(
                    scope: live.scope,
                    remainingMs: live.remainingMs,
                    coveredItems: grants.coveredItems(ref: ref)
                )
            }
            let requested = keyIds.map { keyId in
                RequestedKey(
                    keyId: keyId,
                    policy: keyPolicy(keyId),
                    itemCount: display.itemCounts[keyId],
                    itemDigests: itemDigests[keyId] ?? [],
                    // Which of a key's sources item scope cannot reach. Read off
                    // the source kind, so a kind added later is not silently
                    // assumed to be narrowable.
                    hasUnlistableSource: display.keys[keyId]?.sources.contains { !$0.isItemScopable } ?? false
                )
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
    ///
    /// Nothing is decrypted until the authorization is on disk. If the record
    /// cannot be written the call is refused, which does spend a `once` grant on a
    /// batch that returned nothing. That is the safe direction to fail in: the
    /// alternative is handing back secrets with no record that it happened.
    func decryptV2(
        sessionId: String?,
        keyId: String,
        identityId: String,
        payloads: [Data],
        requester: String? = nil
    ) throws -> (plaintexts: [String], grant: SessionGrantInfo) {
        guard let sessionId, !sessionId.isEmpty else {
            throw IdentitySessionError.noSessionIdentity
        }

        return try queue.sync {
            let ref = SessionGrantRef(sessionId: sessionId, keyId: keyId)
            let consumed: (info: SessionGrantInfo, change: SessionGrantChange)
            do {
                // The enforcement point. Digests are computed HERE, from the
                // payloads about to be opened, so what a grant covers is decided
                // by the bytes rather than by anything the caller said about
                // them. A batch carrying something an item-scoped grant was not
                // approved over is refused whole, before the audit record, before
                // the session key is touched, and without charging the grant.
                consumed = try grants.consume(
                    ref: ref,
                    itemDigests: GrantItemDigest.of(payloads),
                    // The value cache, which is never item scoped: read out of
                    // varlock's own cache file at a path this process computes,
                    // never a membership the caller asserted. See CacheCiphertexts.
                    alsoCovered: { CacheCiphertexts.digests(keyId: keyId) }
                )
            } catch {
                reconcileLocked()
                throw error
            }

            try audit.append(AuthorizationRecord(
                kind: .decrypt,
                sessionId: sessionId,
                keyIds: [keyId],
                identityId: identityId,
                payloadCount: payloads.count,
                scope: consumed.info.scope.rawValue,
                breadth: consumed.info.breadth.rawValue,
                coveredItemCount: consumed.info.coveredItemCount,
                requester: requester
            ))

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
    func invalidate(sessionId: String? = nil, keyId: String? = nil, requester: String? = nil) -> Int {
        return queue.sync {
            let change = grants.invalidate(sessionId: sessionId, keyId: keyId)
            reconcileLocked()

            // Recorded best effort, unlike the two paths above. Refusing to erase
            // key material because a log line would not write is the wrong way
            // round: the erase is the safe outcome, and blocking it to protect the
            // record would leave the daemon holding keys it was told to drop.
            if change.dropped > 0 {
                do {
                    try audit.append(AuthorizationRecord(
                        kind: .invalidate,
                        sessionId: sessionId ?? "*",
                        keyIds: keyId.map { [$0] } ?? ["*"],
                        payloadCount: 0,
                        requester: requester
                    ))
                } catch {
                    fputs("varlock: could not record an invalidation: \(error.localizedDescription)\n", stderr)
                }
            }
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

    /// Whether the context the panel came back with can really open the key.
    ///
    /// A biometric proof is taken as read: that handoff is what
    /// `probe-embedded-unlock` proves on real hardware, and probing it again
    /// would cost every unlock an extra enclave round trip. The password path
    /// pre-authorizes through an access control instead of a policy, so it is
    /// asked once, silently (the proof context refuses interaction by now), and a
    /// credential the enclave will not take costs the user another prompt rather
    /// than costing them the unlock.
    private func proofOpensKey(_ proof: PresenceProof, keyId: String?, wrap: String?) -> Bool {
        guard proof.policy != .biometrics else { return true }
        guard let keyId, let wrap, let wrapData = Data(base64Encoded: wrap) else { return true }
        guard var probed = try? SecureEnclaveManager.decrypt(
            payload: wrapData,
            keyId: keyId,
            context: proof.context
        ) else { return false }
        scrub(&probed)
        return true
    }

    /// Do the first-use Touch ID setup, on its own, before any panel exists.
    ///
    /// macOS raises its own sheet the moment a policy is evaluated, and on first
    /// use (or after a re-enrolment) that sheet lands on top of whatever is
    /// behind it. With the approval panel behind it, one finger satisfied both:
    /// the setup and the approval, before anyone had read what was being
    /// unlocked. So this runs alone, with nothing drawn, says what it is, and
    /// throws its context away afterwards. The approval is a separate scan taken
    /// while the panel is on screen, which costs a first run two scans on
    /// purpose.
    ///
    /// Does nothing when setup is already recorded for this enrolment, or when
    /// there is no screen to ask on (the unlock then fails as `NO_UI`, which is
    /// the honest answer rather than a prompt nobody can see).
    func runBiometricSetupIfNeeded() throws {
        guard needsBiometricSetup(), UiAvailability.canShowUi() else { return }

        PanelDebug.note("setup-presence-begin")
        do {
            // A context of its own, invalidated immediately: a setup scan must
            // never be able to stand in for an approval.
            let (context, _) = try authenticate(reason: BiometricSetupPolicy.setupReason)
            context.invalidate()
        } catch {
            PanelDebug.note("setup-presence-completed", ["success": false])
            throw error
        }
        recordBiometricSetup()
        PanelDebug.note("setup-presence-completed", ["success": true])
    }

    /// One user-presence check with no key operation attached, used by
    /// `request-approval` when the caller asks for a biometric on top of the panel.
    func verifyUserPresence(reason: String) throws {
        let (context, _) = try authenticate(reason: reason)
        context.invalidate()
    }

    /// Why a presence check ended without an answer.
    ///
    /// Dismissing the system sheet is not a refusal of the request, and it is not
    /// a sensor failure either: it means "not now, not this way". The panel says
    /// something different for each, and re-arms for none of them.
    struct PresenceFailure: LocalizedError {
        enum Kind {
            /// The user dismissed the sheet.
            case cancelled
            /// The user asked for the password instead, from inside the sheet.
            case wantsPassword
            /// The check ran and did not succeed.
            case failed
        }

        let kind: Kind
        let message: String

        var errorDescription: String? { message }

        init(error: Error?) {
            message = error?.localizedDescription ?? "Authentication failed"
            switch (error as? LAError)?.code {
            case .userCancel, .systemCancel, .appCancel:
                kind = .cancelled
            case .userFallback:
                kind = .wantsPassword
            default:
                kind = .failed
            }
        }
    }

    /// A satisfied user-presence check, and the context it was satisfied under.
    ///
    /// The context is the valuable half. It is already authenticated, so handing it
    /// to the enclave operation is what keeps one scan covering the whole unlock
    /// rather than raising a second sheet.
    struct PresenceProof {
        let context: LAContext
        let policy: UnlockPolicy
    }

    /// A presence check the panel can build its UI around before running it.
    ///
    /// The context has to exist before the panel is drawn, because the embedded
    /// prompt is bound to it: `LAAuthenticationView(context:)` is what makes
    /// `evaluatePolicy` render inside our own window instead of raising the
    /// standard system dialog. So this hands the panel the context first and lets
    /// it start the evaluation when it is ready.
    ///
    /// The same instance serves a retry: the view stays bound to this context, so
    /// re-evaluating it keeps the prompt where the user is already looking.
    final class PresenceAttempt {
        /// What this attempt asks the system for.
        ///
        /// A policy is the usual one. An access control is how the password path
        /// gets a password field instead of a fingerprint: see `passwordFallback`.
        enum Check {
            case policy(LAPolicy)
            case accessControl(SecAccessControl)
        }

        let context: LAContext
        let mode: ApprovalPresenceMode
        private let check: Check
        private let resolvedPolicy: UnlockPolicy

        convenience init(
            context: LAContext,
            mode: ApprovalPresenceMode,
            policy: LAPolicy,
            resolvedPolicy: UnlockPolicy
        ) {
            self.init(context: context, mode: mode, check: .policy(policy), resolvedPolicy: resolvedPolicy)
        }

        init(context: LAContext, mode: ApprovalPresenceMode, check: Check, resolvedPolicy: UnlockPolicy) {
            self.context = context
            self.mode = mode
            self.check = check
            self.resolvedPolicy = resolvedPolicy
        }

        /// The same approval, checked the other way: a password, asked for as a
        /// password.
        ///
        /// A sensor that will not read a particular finger is common, and the way
        /// out has to stay inside the one approval. It also has to be the way out
        /// it says it is, and `evaluatePolicy(.deviceOwnerAuthentication)` is not:
        /// on a Mac with an enrolled sensor that policy draws the Touch ID sheet
        /// first and hides the password behind its "Use Password..." button, so a
        /// user who has just said "not my finger" is asked for their finger again.
        /// Apple documents that ordering, and there is no policy that skips it.
        ///
        /// `evaluateAccessControl` does skip it. An access control constrained to
        /// `.devicePasscode` cannot be satisfied by biometry, so the system goes
        /// straight to the password field. The context that comes back is
        /// authenticated for device-owner presence, which is what the custody
        /// key's own `.userPresence` gate accepts.
        ///
        /// Falls back to the policy (and its sheet) on a machine that will not
        /// build that access control, and returns nil when there is no password
        /// check to be had at all, where the caller keeps what it had.
        func passwordFallback() -> PresenceAttempt? {
            let context = LAContext()
            var error: NSError?
            guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
                context.invalidate()
                return nil
            }
            if let passcodeOnly = Self.devicePasscodeAccessControl() {
                return PresenceAttempt(
                    context: context,
                    mode: .systemDialog,
                    check: .accessControl(passcodeOnly),
                    resolvedPolicy: .deviceOwner
                )
            }
            return PresenceAttempt(
                context: context,
                mode: .systemDialog,
                policy: .deviceOwnerAuthentication,
                resolvedPolicy: .deviceOwner
            )
        }

        /// "The device password, and only that", as an access control to evaluate.
        ///
        /// The protection class matches the one the custody key is created under,
        /// so the two are asking about the same thing. `.privateKeyUsage` is
        /// deliberately not included: LocalAuthentication refuses to evaluate an
        /// access control carrying it ("Operation is not allowed"), and it says
        /// nothing about which credential is wanted, which is all this is for.
        static func devicePasscodeAccessControl() -> SecAccessControl? {
            var error: Unmanaged<CFError>?
            let control = SecAccessControlCreateWithFlags(
                nil,
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                .devicePasscode,
                &error
            )
            error?.release()
            return control
        }

        /// Run the check. `completion` lands on the main queue.
        ///
        /// No timeout here on purpose: the prompt has the system's own, and the
        /// panel bounds the whole interaction, so a second one would only give the
        /// two a way to disagree.
        func evaluate(reason: String, completion: @escaping (Result<PresenceProof, Error>) -> Void) {
            let finish = { [context, resolvedPolicy] (success: Bool, error: Error?) in
                // Not `DispatchQueue.main.async`: the panel is drawn from inside a
                // main-queue work item, so a block posted to that queue would wait
                // for the panel to close before delivering the panel's own answer.
                MainLoop.perform {
                    guard success else {
                        // Deliberately not invalidated: the panel may offer another
                        // go, on this same context.
                        completion(.failure(PresenceFailure(error: error)))
                        return
                    }
                    // From here on the context must not raise UI of its own, so a
                    // handed-off context that still wanted a prompt fails loudly
                    // instead of showing a second dialog.
                    context.interactionNotAllowed = true
                    completion(.success(PresenceProof(context: context, policy: resolvedPolicy)))
                }
            }

            switch check {
            case .policy(let policy):
                context.evaluatePolicy(policy, localizedReason: reason) { success, error in
                    finish(success, error)
                }
            case .accessControl(let accessControl):
                context.evaluateAccessControl(
                    accessControl,
                    operation: .useKeyDecrypt,
                    localizedReason: reason
                ) { success, error in
                    finish(success, error)
                }
            }
        }
    }

    /// Pick how this machine can ask for user presence right now.
    ///
    /// Biometrics get the embedded prompt, which is the whole point: one window,
    /// one gesture. Anything else (no sensor, no enrolment, biometrics locked out
    /// after too many failures) falls back to the standard system dialog driven by
    /// the panel's button, which still accepts the device password. Returns nil
    /// when there is no way to ask at all.
    func beginPresence() -> PresenceAttempt? {
        let context = LAContext()

        var biometricError: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &biometricError),
           UiAvailability.embeddedPromptEnabled {
            return PresenceAttempt(
                context: context,
                mode: .embedded,
                policy: .deviceOwnerAuthenticationWithBiometrics,
                resolvedPolicy: .biometrics
            )
        }

        var fallbackError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &fallbackError) else {
            context.invalidate()
            return nil
        }
        return PresenceAttempt(
            context: context,
            mode: .systemDialog,
            policy: .deviceOwnerAuthentication,
            resolvedPolicy: .deviceOwner
        )
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
