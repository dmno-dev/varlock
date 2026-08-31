import Foundation
import AppKit
import IdentitySessions
import SessionScoping

// MARK: - JSON Output Helpers

func jsonOutput(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          let str = String(data: data, encoding: .utf8) else {
        fputs("{\"error\":\"Failed to serialize output\"}\n", stderr)
        _exit(1)
    }
    print(str)
}

func jsonError(_ message: String) -> Never {
    jsonOutput(["error": message])
    // Flush stdout since _exit() won't do it for us
    fflush(stdout)
    // Use _exit to skip framework cleanup — LocalAuthentication teardown can
    // hang in the kernel (UE state) if the Secure Enclave is unresponsive.
    _exit(1)
}

func jsonSuccess(_ result: [String: Any]) -> Never {
    jsonOutput(["ok": true].merging(result) { _, new in new })
    fflush(stdout)
    _exit(0)
}

/// Attach a stable code to identity/session errors so the TS client can branch on
/// them (re-unlock, create an identity, upgrade varlock) without matching on text.
func identityErrorResponse(_ error: Error) -> [String: Any] {
    var response: [String: Any] = ["error": error.localizedDescription]
    if let grantError = error as? SessionGrantError {
        response["errorCode"] = grantError.code
    } else if let storeError = error as? IdentityStore.IdentityStoreError {
        response["errorCode"] = storeError.code
    } else if let sessionError = error as? IdentitySessionManager.IdentitySessionError {
        response["errorCode"] = sessionError.code
    } else if let approvalError = error as? ApprovalRequest.ParseError {
        response["errorCode"] = approvalError.code
    } else if let auditError = error as? AuthorizationAuditError {
        response["errorCode"] = auditError.code
    } else if let eciesError = error as? Ecies.EciesError {
        response["errorCode"] = eciesError.code
    }
    return response
}

func keychainErrorResponse(_ error: Error) -> [String: Any] {
    if let keychainError = error as? KeychainError {
        return [
            "error": keychainError.localizedDescription,
            "errorCode": keychainError.code,
        ]
    }
    return ["error": error.localizedDescription]
}

// MARK: - CLI Parsing

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : "help"

func getArg(_ flag: String) -> String? {
    guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
    return args[idx + 1]
}

let defaultKeyId = "varlock-default"
let noAuth = args.contains("--no-auth") // CI mode: skip biometric requirement

/// IPC protocol version reported by `ping`.
///
/// 1 (reported as absent) is the original action set. 2 adds the identity session
/// ops: unlock-session, decrypt-v2, list-sessions, and the per-session form of
/// invalidate-session. 3 adds the daemon-drawn approval panel: unlock-session can
/// now answer APPROVAL_DENIED or NO_UI, and request-approval exists.
let daemonProtocolVersion = 3

/// Who is asking, read off the peer rather than taken from the message.
///
/// The summary is the flattened line the audit log and the biometric prompt use;
/// the panel draws the chain. Both are derived here, so neither can be dressed
/// up by a caller.
func panelRequesterForPid(_ pid: pid_t?) -> PanelRequester {
    guard let pid else {
        return PanelRequester(summary: "Requested by an unidentified process")
    }
    let described = describeRequester(forPid: pid)
    // Best effort and bounded: a chain that could not be read costs the panel
    // its detail, never its appearance. The timing is recorded because that is
    // the failure worth catching, and it is invisible from the outside.
    let startedAt = Date()
    let chain = ExecutionChainBuilder().build(forPid: pid)
    PanelDebug.note("requester-chain", [
        "hops": chain.hops.count,
        "agent": chain.agentSession?.productName ?? "",
        "ms": Int(Date().timeIntervalSince(startedAt) * 1000),
    ])
    return PanelRequester(
        summary: described.summaryLine,
        details: described.detailLines.map { .derived($0) },
        chain: chain
    )
}

/// One line naming the peer, for the authorization log. Same derivation as the
/// panel's, flattened.
func requesterSummaryForPid(_ pid: pid_t?) -> String? {
    guard let pid else { return nil }
    return describeRequester(forPid: pid).auditSummary
}

switch command {

// MARK: - generate-key

case "generate-key":
    let keyId = getArg("--key-id") ?? defaultKeyId
    // A key that asks every time never receives a lasting grant: every batch of
    // decrypts costs a fresh approval and a fresh scan.
    let authEveryTime = args.contains("--auth-every-time")

    if authEveryTime && noAuth {
        jsonError("--auth-every-time and --no-auth ask for opposite things")
    }

    // First gated key on this machine: say what is being set up before macOS
    // starts asking for fingerprints. Once, ever.
    FirstRunSetup.showIfNeeded(requireAuth: !noAuth)

    do {
        let pubKeyData = try SecureEnclaveManager.generateKey(keyId: keyId, requireAuth: !noAuth)
        // Always written now, not just for --auth-every-time. The access-control
        // flag set above cannot be read back off a stored key, so this sidecar is
        // the only record that a --no-auth key carries no presence gate, and
        // `status` needs it to tell the TS side how to route decrypts.
        try KeyAuthPolicyStore.write(
            record: KeyAuthRecord(
                policy: authEveryTime ? .everyTime : .standard,
                requireAuth: !noAuth
            ),
            for: keyId
        )
        jsonSuccess([
            "keyId": keyId,
            "publicKey": pubKeyData.base64EncodedString(),
            "publicKeyBytes": pubKeyData.count,
            "authMode": (authEveryTime ? KeyAuthPolicy.everyTime : KeyAuthPolicy.standard).rawValue,
        ])
    } catch {
        jsonError(error.localizedDescription)
    }

// MARK: - delete-key

case "delete-key":
    let keyId = getArg("--key-id") ?? defaultKeyId
    let deleted = SecureEnclaveManager.deleteKey(keyId: keyId)
    KeyAuthPolicyStore.remove(for: keyId)
    jsonSuccess(["keyId": keyId, "deleted": deleted])

// MARK: - list-keys

case "list-keys":
    let keys = SecureEnclaveManager.listKeys()
    jsonSuccess(["keys": keys])

// MARK: - key-exists

case "key-exists":
    let keyId = getArg("--key-id") ?? defaultKeyId
    let exists = SecureEnclaveManager.keyExists(keyId: keyId)
    jsonSuccess(["keyId": keyId, "exists": exists])

// MARK: - encrypt

case "encrypt":
    let keyId = getArg("--key-id") ?? defaultKeyId

    let dataB64: String
    if args.contains("--data-stdin") {
        // read one line of base64 from stdin so plaintext never appears in argv
        // (matches the rust binary's encrypt --data-stdin interface)
        guard let line = readLine(strippingNewline: true)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !line.isEmpty else {
            jsonError("Failed to read data from stdin")
        }
        dataB64 = line
    } else if let dataArg = getArg("--data") {
        dataB64 = dataArg
    } else {
        jsonError("Missing --data argument (base64-encoded plaintext)")
    }
    guard let plaintext = Data(base64Encoded: dataB64) else {
        jsonError("Invalid base64 data")
    }

    do {
        let encrypted = try SecureEnclaveManager.encrypt(plaintext: plaintext, keyId: keyId)
        jsonSuccess(["ciphertext": encrypted.base64EncodedString()])
    } catch {
        jsonError(error.localizedDescription)
    }

// MARK: - decrypt (one-shot, for testing)

case "decrypt":
    let keyId = getArg("--key-id") ?? defaultKeyId

    guard let dataB64 = getArg("--data") else {
        jsonError("Missing --data argument (base64-encoded ciphertext)")
    }
    guard let ciphertext = Data(base64Encoded: dataB64) else {
        jsonError("Invalid base64 data")
    }

    do {
        let decrypted = try SecureEnclaveManager.decrypt(payload: ciphertext, keyId: keyId, context: nil)
        guard let plaintext = String(data: decrypted, encoding: .utf8) else {
            jsonError("Decrypted data is not valid UTF-8")
        }
        jsonSuccess(["plaintext": plaintext])
    } catch {
        jsonError(error.localizedDescription)
    }

// MARK: - probe-session-unlock (manual, needs a real Mac + enrolled biometrics)

case "probe-session-unlock":
    let probeKeyId = getArg("--key-id") ?? defaultKeyId
    jsonSuccess(SessionUnlockProbe.run(keyId: probeKeyId))

// MARK: - probe-embedded-unlock (manual, needs a real Mac + enrolled biometrics)

case "probe-laright":
    jsonSuccess(LARightProbe.run(
        verbose: args.contains("--verbose"),
        timeoutSeconds: TimeInterval(getArg("--timeout").flatMap { Double($0) } ?? 60)
    ))

case "probe-embedded-unlock":
    let embeddedProbeKeyId = getArg("--key-id") ?? defaultKeyId
    let embeddedProbeTimeout = TimeInterval(getArg("--timeout").flatMap { Double($0) } ?? 60)
    jsonSuccess(EmbeddedUnlockProbe.run(
        keyId: embeddedProbeKeyId,
        verbose: args.contains("--verbose"),
        timeoutSeconds: embeddedProbeTimeout
    ))

// MARK: - panel-preview (design tool, draws the panel without asking anything)

case "panel-preview":
    // The panel's correctness is visual, and the real one is modal, floating,
    // and impossible to look at on a headless session. This draws the same view
    // tree to a PNG. Nothing is unlocked, no key is touched, and no presence
    // check runs; the plan is built from the file so every state the panel has
    // (delta, strict keys, no biometrics) can be inspected on demand.
    guard let outPath = getArg("--out") else {
        jsonError("panel-preview needs --out <file.png>")
    }
    let previewPayload: [String: Any]
    if let payloadPath = getArg("--payload") {
        guard let data = FileManager.default.contents(atPath: payloadPath),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            jsonError("Could not read a JSON payload from \(payloadPath)")
        }
        previewPayload = parsed
    } else {
        previewPayload = ["keyIds": [defaultKeyId]]
    }

    let previewApp = NSApplication.shared
    previewApp.setActivationPolicy(.accessory)

    let previewKeyIds = UnlockRequestKeys.from(payload: previewPayload)
    let previewDisplay = UnlockDisplayInfo.from(payload: previewPayload)
    let strictKeyIds = Set((previewPayload["strictKeyIds"] as? [String]) ?? [])
    let coveredKeyIds = Set((previewPayload["coveredKeyIds"] as? [String]) ?? [])
    let previewPlan = UnlockPlanner.plan(
        requested: previewKeyIds.map {
            RequestedKey(
                keyId: $0,
                policy: strictKeyIds.contains($0) ? .everyTime : .standard,
                itemCount: previewDisplay.valueCount(forKey: $0)
            )
        },
        requestedScope: .session,
        existing: Dictionary(uniqueKeysWithValues: coveredKeyIds.map {
            ($0, ExistingGrantSnapshot(scope: .session, remainingMs: 4 * 60 * 60 * 1000))
        })
    )
    let previewRequester = panelRequesterForPid(
        (previewPayload["pid"] as? NSNumber)?.int32Value ?? getppid()
    )
    let previewContent = UnlockPanelContent.build(
        plan: previewPlan,
        requester: previewRequester,
        display: previewDisplay,
        lockOn: SessionLockPolicy(wireValue: previewPayload["lockOn"] as? String) ?? .builtInDefault
    )
    let previewMode: ApprovalPresenceMode
    switch previewPayload["mode"] as? String {
    case "systemDialog": previewMode = .systemDialog
    case "none": previewMode = .none
    default: previewMode = .embedded
    }
    guard let png = ApprovalPanel.previewPng(
        content: previewContent,
        mode: previewMode,
        expandChain: (previewPayload["expandChain"] as? NSNumber)?.boolValue ?? false
    ) else {
        jsonError("Could not render the panel")
    }
    do {
        try png.write(to: URL(fileURLWithPath: outPath))
    } catch {
        jsonError("Could not write \(outPath): \(error.localizedDescription)")
    }
    jsonSuccess(["path": outPath, "title": previewContent.title])

// MARK: - status

case "status":
    let seAvailable: Bool
    #if targetEnvironment(simulator)
    seAvailable = false
    #else
    seAvailable = true // If this binary runs on real hardware, SE is available
    #endif

    let keyIds = SecureEnclaveManager.listKeys()

    jsonSuccess([
        "secureEnclaveAvailable": seAvailable,
        "backend": "secure-enclave",
        "hardwareBacked": seAvailable,
        "biometricAvailable": seAvailable,
        "platform": "darwin",
        "arch": {
            #if arch(arm64)
            return "arm64"
            #elseif arch(x86_64)
            return "x86_64"
            #else
            return "unknown"
            #endif
        }(),
        "keys": keyIds,
        // Per-key metadata, so the TS side can tell which keys carry a presence
        // gate without opening any of them. Same shape as the Rust helper's
        // `key_details()`, since one client reads both.
        "keyDetails": keyIds.map { keyId -> [String: Any] in
            var detail: [String: Any] = [
                "keyId": keyId,
                "requireAuth": KeyAuthPolicyStore.record(for: keyId).requireAuth,
                "protection": "secure-enclave",
            ]
            if let createdAt = SecureEnclaveManager.keyCreatedAt(keyId: keyId) {
                detail["createdAt"] = createdAt
            }
            return detail
        },
    ])

// MARK: - daemon

case "daemon":
    guard let socketPath = getArg("--socket-path") else {
        jsonError("Missing --socket-path argument")
    }

    let sessionManager = SessionManager()
    let identitySessions = IdentitySessionManager()
    let server = IPCServer(socketPath: socketPath)

    // The panel is drawn by this process on purpose: the daemon is the one that
    // verified the peer and holds the keys, so it is the only party that can say
    // truthfully who is asking.
    identitySessions.promptHandler = { content, reason, attempt in
        guard let outcome = ApprovalPanel.present(
            content: content,
            presenceReason: reason,
            attempt: attempt
        ) else { return .noUi }
        return outcome.decision.approved
            ? .approved(outcome.decision, outcome.proof)
            : .denied
    }
    identitySessions.keyPolicy = { keyId in KeyAuthPolicyStore.policy(for: keyId) }
    // Where "has Touch ID been set up for varlock here" is recorded. Kept out of
    // the manager so it never has to know about the file system.
    identitySessions.needsBiometricSetup = { BiometricSetupStore.needsSetup() }
    identitySessions.recordBiometricSetup = { BiometricSetupStore.markSetupComplete() }

    /// Approval for a device-key read (the pre-identity payload format).
    ///
    /// These values are as sensitive as any other, and until now this path went
    /// straight to `evaluatePolicy`, which is the system sheet with nothing
    /// behind it. It now draws the same panel every other release goes through,
    /// so there is no path to a secret that does not say who is asking first.
    sessionManager.authorize = { [weak identitySessions] peerPid in
        guard let identitySessions else {
            throw IdentitySessionManager.IdentitySessionError.noUi
        }
        // Setup first and alone, exactly as an identity unlock does it.
        try identitySessions.runBiometricSetupIfNeeded()

        let requester = panelRequesterForPid(peerPid)
        let content = PanelContent(
            titleSegments: [.plain("Unlock "), .code(UnlockPanelContent.defaultKeyDisplayName)],
            subtitle: nil,
            requester: requester,
            keyRows: [PanelKeyRow(
                keyId: defaultKeyId,
                displayName: UnlockPanelContent.defaultKeyDisplayName
            )],
            notes: [
                "These values are encrypted to this Mac's device key, the format varlock "
                + "used before unlock sessions. Approving covers this terminal for a few minutes.",
            ],
            factLine: "Recorded to the audit log",
            scopes: [.once],
            defaultScope: .once,
            confirmButtonTitle: "Unlock"
        )
        let attempt = identitySessions.beginPresence()
        // The sheet says what the panel says, in the shortest form that is true.
        guard let outcome = ApprovalPanel.present(
            content: content,
            presenceReason: content.presenceReason,
            attempt: attempt
        ) else {
            attempt?.context.invalidate()
            throw IdentitySessionManager.IdentitySessionError.noUi
        }
        guard outcome.decision.approved else {
            outcome.proof?.context.invalidate()
            throw IdentitySessionManager.IdentitySessionError.approvalDenied
        }
        guard let proof = outcome.proof else {
            // Approved with no presence check behind it. Nothing here may open a
            // key on the strength of a click alone.
            throw IdentitySessionManager.IdentitySessionError.biometricFailed(
                "The approval completed without a presence check"
            )
        }
        return proof.context
    }

    // Never idle-quit while the daemon is holding an identity key for someone.
    // Session state is memory-only, so quitting would silently cost them their
    // unlock; the idle timer only applies when nothing is held.
    sessionManager.hasLiveWork = {
        identitySessions.hasLiveSessions()
    }

    // An explicit lock erases every identity session, whatever their lock policy.
    sessionManager.onSystemLock = {
        identitySessions.invalidate()
    }

    // Sleep and screen lock are judged per session: each one is erased only if its
    // own resolved lockOn policy says that event ends it.
    sessionManager.onLockEvent = { event in
        identitySessions.handleLockEvent(event)
    }

    // Write PID file
    let pidPath = getArg("--pid-path")
    if let pidPath = pidPath {
        let pidDir = (pidPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: pidDir, withIntermediateDirectories: true)
        try? "\(ProcessInfo.processInfo.processIdentifier)".write(toFile: pidPath, atomically: true, encoding: .utf8)
    }

    // Status bar menu (must be created before run loop starts)
    // NSApplication is needed for status bar items to work
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory) // no Dock icon

    var statusBarMenu: StatusBarMenu?

    // Handle daemon shutdown
    func shutdownDaemon() {
        statusBarMenu?.remove()
        server.stop()
        if let pidPath = pidPath {
            try? FileManager.default.removeItem(atPath: pidPath)
        }
        // Use _exit to skip framework cleanup — LocalAuthentication teardown
        // can hang in the kernel (UE state) if Secure Enclave is unresponsive.
        _exit(0)
    }

    sessionManager.onDaemonTimeout = {
        shutdownDaemon()
    }

    server.onConnectionActivity = {
        sessionManager.noteIpcActivity()
    }

    // Handle IPC messages (sessionId is resolved from the peer's TTY or process tree)
    server.messageHandler = { message, sessionId, peerPid in
        guard let action = message["action"] as? String else {
            return ["error": "Missing action"]
        }

        switch action {
        case "decrypt":
            guard let payload = message["payload"] as? [String: Any],
                  let ciphertextB64 = payload["ciphertext"] as? String,
                  let ciphertext = Data(base64Encoded: ciphertextB64) else {
                return ["error": "Missing or invalid ciphertext in payload"]
            }

            let keyId = (payload["keyId"] as? String) ?? defaultKeyId

            do {
                let context = try sessionManager.getAuthenticatedContext(
                    sessionId: sessionId,
                    peerPid: peerPid
                )
                let decrypted = try SecureEnclaveManager.decrypt(
                    payload: ciphertext,
                    keyId: keyId,
                    context: context
                )
                guard let plaintext = String(data: decrypted, encoding: .utf8) else {
                    return ["error": "Decrypted data is not valid UTF-8"]
                }
                statusBarMenu?.refresh()
                return ["result": plaintext]
            } catch {
                return ["error": error.localizedDescription]
            }

        case "ping":
            return [
                "result": [
                    "pong": true,
                    "sessionWarm": sessionManager.isSessionWarm(sessionId: sessionId),
                    "sessionId": sessionId as Any,
                    // Absent means 1 (a daemon predating identity sessions), so a
                    // client can tell a stale daemon from one that speaks these ops.
                    "protocolVersion": daemonProtocolVersion,
                ],
            ]

        case "encrypt":
            guard let payload = message["payload"] as? [String: Any],
                  let plaintextStr = payload["plaintext"] as? String else {
                return ["error": "Missing plaintext in payload"]
            }

            let encKeyId = (payload["keyId"] as? String) ?? defaultKeyId
            guard let plaintextData = plaintextStr.data(using: .utf8) else {
                return ["error": "Plaintext is not valid UTF-8"]
            }

            do {
                let encrypted = try SecureEnclaveManager.encrypt(plaintext: plaintextData, keyId: encKeyId)
                return ["result": encrypted.base64EncodedString()]
            } catch {
                return ["error": error.localizedDescription]
            }

        case "prompt-secret":
            let promptPayload = message["payload"] as? [String: Any]
            let itemKey = promptPayload?["itemKey"] as? String
            let promptMessage = promptPayload?["message"] as? String
                ?? "Enter the secret value to encrypt:"
            let promptKeyId = (promptPayload?["keyId"] as? String) ?? defaultKeyId

            // Check the recipient key before drawing anything. Finding out after
            // the dialog means the user types a secret into a prompt that was
            // never going to work, and leaves a modal on screen with nobody to
            // dismiss it if the caller was a script.
            var identityPublicKey: Data?
            if let identityPublicKeyB64 = promptPayload?["identityPublicKey"] as? String {
                do {
                    identityPublicKey = try Ecies.recipientPublicKeyData(base64: identityPublicKeyB64)
                } catch {
                    return identityErrorResponse(error)
                }
            }

            guard let value = SecureInputDialog.prompt(
                title: "Varlock: Enter Secret",
                message: promptMessage,
                itemKey: itemKey
            ) else {
                return ["error": "cancelled"]
            }

            // Encrypt the entered value immediately
            guard let valueData = value.data(using: .utf8) else {
                return ["error": "Value is not valid UTF-8"]
            }

            do {
                let encrypted: Data
                if let identityPublicKey {
                    // Encrypt to the identity here, so only ciphertext crosses the
                    // socket and the value never exists outside this process.
                    encrypted = try Ecies.encrypt(
                        plaintext: valueData,
                        toPublicKeyData: identityPublicKey,
                        version: Ecies.identityPayloadVersion
                    )
                } else {
                    // Legacy path: encrypt straight to the device key
                    encrypted = try SecureEnclaveManager.encrypt(plaintext: valueData, keyId: promptKeyId)
                }
                return ["result": [
                    "ciphertext": encrypted.base64EncodedString(),
                ]]
            } catch {
                return ["error": error.localizedDescription]
            }

        // MARK: Identity session actions

        case "unlock-session":
            // A malformed message is refused rather than guessed at, the same way
            // decrypt-v2 refuses one. Guessing here would mean unlocking a key the
            // caller never named and dropping its display metadata in silence.
            guard let payload = message["payload"] as? [String: Any] else {
                return ["error": "Missing payload"]
            }
            let identityId = (payload["identityId"] as? String) ?? IdentityStore.defaultIdentityId
            let scope = SessionGrantScope(wireValue: payload["scope"] as? String) ?? .session

            // Accept one key or several: one unlock, one scan, however many keys.
            let requestedKeyIds = UnlockRequestKeys.from(payload: payload)

            // A caller may name the session it believes it is in, but it never
            // overrides the identity we resolved from the peer process itself.
            let durationMs = (payload["durationMs"] as? NSNumber)?.int64Value

            // Optional decoration from the client (item counts, project name). It
            // only ever changes the wording on the panel.
            let requestContext = IdentitySessionManager.UnlockRequestContext(
                requester: panelRequesterForPid(peerPid),
                display: UnlockDisplayInfo.from(payload: payload)
            )

            do {
                let outcome = try identitySessions.unlock(
                    sessionId: sessionId,
                    keyIds: requestedKeyIds,
                    identityId: identityId,
                    scope: scope,
                    durationMs: durationMs,
                    lockOnOverride: payload["lockOn"] as? String,
                    requestContext: requestContext
                )
                statusBarMenu?.refresh()
                return ["result": [
                    "sessionId": sessionId as Any,
                    "policy": outcome.policy.rawValue,
                    "lockOn": outcome.lockOn.rawValue,
                    "lockOnSource": outcome.lockOnSource.rawValue,
                    "prompted": outcome.prompted,
                    "grants": outcome.grants.map { $0.toDictionary() },
                ]]
            } catch {
                return identityErrorResponse(error)
            }

        case "request-approval":
            // Generic and stateless: put a question on the trusted display and
            // report the answer. Nothing is unlocked and nothing is recorded here,
            // so the caller (the proxy) keeps its own record of what it may do.
            guard let approvalPayload = message["payload"] as? [String: Any] else {
                return ["error": "Missing payload"]
            }
            do {
                let request = try ApprovalRequest.from(payload: approvalPayload)
                let content = request.panelContent(requester: panelRequesterForPid(peerPid))
                // A request that wants a biometric gets the same embedded prompt as
                // an unlock: the scan is the approval. Without one, the panel keeps
                // its plain button.
                let attempt = request.requireBiometric ? identitySessions.beginPresence() : nil
                guard let outcome = ApprovalPanel.present(
                    content: content,
                    presenceReason: request.title,
                    attempt: attempt
                ) else {
                    attempt?.context.invalidate()
                    return identityErrorResponse(IdentitySessionManager.IdentitySessionError.noUi)
                }
                // Nothing here holds a key, so the proof has done its job by
                // existing and is dropped rather than handed on.
                outcome.proof?.context.invalidate()
                if outcome.decision.approved && request.requireBiometric && outcome.proof == nil {
                    // The panel approved without a presence check, which can only
                    // happen if none could be started. Do not report an approval
                    // the caller asked to have verified.
                    try identitySessions.verifyUserPresence(reason: request.title)
                }
                return ["result": ApprovalOutcome(decision: outcome.decision).toDictionary()]
            } catch {
                return identityErrorResponse(error)
            }

        case "decrypt-v2":
            guard let payload = message["payload"] as? [String: Any] else {
                return ["error": "Missing payload"]
            }
            let keyId = (payload["keyId"] as? String) ?? defaultKeyId
            let identityId = (payload["identityId"] as? String) ?? IdentityStore.defaultIdentityId

            // Batch form is the normal one (a whole env file resolves at once);
            // the single-ciphertext form is accepted for one-off callers.
            var ciphertexts = (payload["ciphertexts"] as? [String]) ?? []
            if let single = payload["ciphertext"] as? String { ciphertexts.append(single) }
            guard !ciphertexts.isEmpty else {
                return ["error": "Missing ciphertext in payload"]
            }
            let payloadDatas = ciphertexts.compactMap { Data(base64Encoded: $0) }
            guard payloadDatas.count == ciphertexts.count else {
                return ["error": "Invalid base64 in ciphertext payload"]
            }

            do {
                let outcome = try identitySessions.decryptV2(
                    sessionId: sessionId,
                    keyId: keyId,
                    identityId: identityId,
                    payloads: payloadDatas,
                    requester: requesterSummaryForPid(peerPid)
                )
                statusBarMenu?.refresh()
                return ["result": [
                    "plaintexts": outcome.plaintexts,
                    "grant": outcome.grant.toDictionary(),
                ]]
            } catch {
                return identityErrorResponse(error)
            }

        case "list-sessions":
            return ["result": ["sessions": identitySessions.listGrants()]]

        case "invalidate-session":
            let payload = message["payload"] as? [String: Any]
            let targetSessionId = payload?["sessionId"] as? String
            let targetKeyId = payload?["keyId"] as? String

            // No arguments keeps the original meaning: drop everything, including
            // the cached biometric contexts.
            if targetSessionId == nil && targetKeyId == nil {
                sessionManager.invalidateAllSessions()
            }
            let invalidated = identitySessions.invalidate(
                sessionId: targetSessionId,
                keyId: targetKeyId,
                requester: requesterSummaryForPid(peerPid)
            )
            statusBarMenu?.refresh()
            return ["result": ["invalidated": invalidated]]

        // MARK: Keychain actions

        case "keychain-get":
            guard let payload = message["payload"] as? [String: Any] else {
                return ["error": "Missing payload"]
            }

            let service = payload["service"] as? String
            let account = payload["account"] as? String
            let keychainName = payload["keychain"] as? String
            let field = payload["field"] as? String

            guard service != nil || account != nil else {
                return ["error": "At least one of service or account is required"]
            }

            // Metadata fields (account, label, etc.) don't need biometric gating
            // since they're not secret values
            if let field = field {
                do {
                    let value = try KeychainManager.getItemField(
                        service: service,
                        account: account,
                        keychainName: keychainName,
                        field: field
                    )
                    return ["result": value]
                } catch {
                    return keychainErrorResponse(error)
                }
            }

            // Password reads require biometric gate
            do {
                _ = try sessionManager.getAuthenticatedContext(sessionId: sessionId, peerPid: peerPid)
            } catch {
                return ["error": error.localizedDescription]
            }

            do {
                let value = try KeychainManager.getItem(
                    service: service,
                    account: account,
                    keychainName: keychainName
                )
                statusBarMenu?.refresh()
                return ["result": value]
            } catch {
                return keychainErrorResponse(error)
            }

        case "keychain-search":
            let payload = message["payload"] as? [String: Any]
            let query = payload?["query"] as? String
            let keychainName = payload?["keychain"] as? String

            let items = KeychainManager.searchItems(query: query, keychainName: keychainName)
            let itemDicts = items.map { $0.toDictionary() }
            return ["result": itemDicts]

        case "keychain-pick":
            let pickPayload = message["payload"] as? [String: Any]
            let pickItemKey = pickPayload?["itemKey"] as? String
            guard let selected = KeychainPickerDialog.pick(itemKey: pickItemKey) else {
                return ["error": "cancelled"]
            }
            return ["result": selected]

        case "keychain-fix-access":
            guard let payload = message["payload"] as? [String: Any] else {
                return ["error": "Missing payload"]
            }
            guard let service = payload["service"] as? String else {
                return ["error": "Missing service"]
            }
            let account = payload["account"] as? String
            let keychainName = payload["keychain"] as? String
            let appPath = Bundle.main.executablePath ?? ProcessInfo.processInfo.arguments[0]

            do {
                let modified = try KeychainManager.addToACL(
                    service: service,
                    account: account,
                    keychainName: keychainName,
                    appPath: appPath
                )
                return ["result": ["modified": modified]]
            } catch {
                return keychainErrorResponse(error)
            }

        case "keychain-set":
            guard let payload = message["payload"] as? [String: Any] else {
                return ["error": "Missing payload"]
            }
            guard let service = payload["service"] as? String else {
                return ["error": "Missing service"]
            }
            guard let value = payload["value"] as? String else {
                return ["error": "Missing value"]
            }
            let account = payload["account"] as? String ?? ""
            let update = payload["update"] as? Bool ?? false

            do {
                let updated = try KeychainManager.setGenericPassword(
                    service: service,
                    account: account,
                    value: value,
                    update: update
                )
                return ["result": ["updated": updated]]
            } catch {
                return keychainErrorResponse(error)
            }

        default:
            return ["error": "Unknown action: \(action)"]
        }
    }

    // Start server
    do {
        try server.start()

        // Signal handling goes in before anything announces itself, and the
        // dispatch sources go in before the default action is turned off.
        //
        // Order matters both ways. A SIGTERM arriving between `SIG_IGN` and a
        // resumed source would be neither killed nor handled, and the daemon
        // would sit there holding session keys with nothing left to stop it; the
        // other way round, the worst case is the default action, which at least
        // ends the process. And doing all of it before the status item is built
        // means a slow window server cannot leave a stretch of startup where the
        // daemon cannot be asked to stop.
        let sigTermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        sigTermSource.setEventHandler { shutdownDaemon() }
        sigTermSource.resume()

        let sigIntSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        sigIntSource.setEventHandler { shutdownDaemon() }
        sigIntSource.resume()

        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)

        // Print ready message to stdout so the JS launcher knows we're ready
        jsonOutput(["ready": true, "pid": ProcessInfo.processInfo.processIdentifier, "socketPath": socketPath])
        fflush(stdout)

        // Set up status bar menu
        statusBarMenu = StatusBarMenu(
            sessionManager: sessionManager,
            actions: StatusBarMenu.Actions(
                liveGrants: {
                    identitySessions.liveGrantInfos()
                },
                lockAll: {
                    // Explicit lock: cached biometric contexts AND every identity
                    // session, whatever lock policy those sessions were opened with.
                    sessionManager.handleSystemLock()
                    statusBarMenu?.refresh()
                },
                lockSession: { sessionId in
                    identitySessions.invalidate(sessionId: sessionId, requester: "menu bar")
                    statusBarMenu?.refresh()
                },
                currentLockPolicy: {
                    // Read from the file rather than cached, for the same reason
                    // unlock does: an edit applies without a restart.
                    LockPolicyResolution.machineLockPolicy(
                        fromConfigData: IdentityStore.readMachineConfigData()
                    ) ?? .builtInDefault
                },
                setLockPolicy: { policy in
                    let updated = try MachineConfigEdit.settingLockOn(
                        policy,
                        in: IdentityStore.readMachineConfigData()
                    )
                    try IdentityStore.writeMachineConfigData(updated)
                },
                quit: {
                    shutdownDaemon()
                }
            )
        )

        // We need a run loop for NSWorkspace notifications (sleep/lock detection)
        // and for the status bar menu to work
        app.run()
    } catch IPCError.lockHeld {
        // Another daemon won the race (parallel spawn — e.g. turbo tasks).
        // Emit a marker the JS launcher can recognize and exit cleanly without
        // touching any shared state. We deliberately skip removing pidPath here
        // since the existing daemon owns it.
        jsonOutput(["alreadyRunning": true])
        fflush(stdout)
        _exit(0)
    } catch {
        jsonError("Failed to start daemon: \(error.localizedDescription)")
    }

// MARK: - help

case "help", "--help", "-h":
    let help = """
    varlock-enclave - Secure Enclave encryption daemon for Varlock

    COMMANDS:
      generate-key [--key-id <id>] [--auth-every-time]
                                      Create a new Secure Enclave key
      delete-key [--key-id <id>]      Delete a Secure Enclave key
      list-keys                       List all Varlock Secure Enclave keys
      key-exists [--key-id <id>]      Check if a key exists
      encrypt --data <base64> [--key-id <id>]   Encrypt data (one-shot)
      encrypt --data-stdin [--key-id <id>]      Encrypt data read from stdin
      decrypt --data <base64> [--key-id <id>]   Decrypt data (one-shot, testing)
      status                          Check Secure Enclave availability
      daemon --socket-path <path> [--pid-path <path>]   Start IPC daemon
      probe-session-unlock [--key-id <id>]   Check that one biometric scan covers a
                                             whole unlock on this machine
      probe-embedded-unlock [--key-id <id>]  Same check for the panel's embedded
                                             Touch ID prompt
      probe-laright                          Spike: does LARight draw its prompt
                                             inline, and can its key hold our wrap
      panel-preview --out <file.png> [--payload <file.json>]
                                      Draw the approval panel to a PNG, without
                                      showing it or unlocking anything

    OPTIONS:
      --key-id <id>       Key identifier (default: varlock-default)
      --data <base64>     Base64-encoded data
      --data-stdin        Read base64 data from stdin (one line)
      --socket-path <path>  Unix socket path for daemon mode
      --pid-path <path>   PID file path for daemon mode
      --no-auth           Create a key with no user-presence requirement (CI)
      --auth-every-time   Create a key that must be approved for every read

    All output is JSON. Errors return {"error": "message"}.
    """
    print(help)
    fflush(stdout)
    _exit(0)

default:
    jsonError("Unknown command: \(command). Run with --help for usage.")
}
