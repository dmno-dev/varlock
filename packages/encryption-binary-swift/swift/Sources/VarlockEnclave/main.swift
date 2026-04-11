import Foundation
import AppKit

// MARK: - JSON Output Helpers

func jsonOutput(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          let str = String(data: data, encoding: .utf8) else {
        fputs("{\"error\":\"Failed to serialize output\"}\n", stderr)
        exit(1)
    }
    print(str)
}

func jsonError(_ message: String) -> Never {
    jsonOutput(["error": message])
    exit(1)
}

func jsonSuccess(_ result: [String: Any]) -> Never {
    jsonOutput(["ok": true].merging(result) { _, new in new })
    exit(0)
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

switch command {

// MARK: - generate-key

case "generate-key":
    let keyId = getArg("--key-id") ?? defaultKeyId

    do {
        let pubKeyData = try SecureEnclaveManager.generateKey(keyId: keyId, requireAuth: !noAuth)
        jsonSuccess([
            "keyId": keyId,
            "publicKey": pubKeyData.base64EncodedString(),
            "publicKeyBytes": pubKeyData.count,
        ])
    } catch {
        jsonError(error.localizedDescription)
    }

// MARK: - delete-key

case "delete-key":
    let keyId = getArg("--key-id") ?? defaultKeyId
    let deleted = SecureEnclaveManager.deleteKey(keyId: keyId)
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

    guard let dataB64 = getArg("--data") else {
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

// MARK: - status

case "status":
    let seAvailable: Bool
    #if targetEnvironment(simulator)
    seAvailable = false
    #else
    seAvailable = true // If this binary runs on real hardware, SE is available
    #endif

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
        "keys": SecureEnclaveManager.listKeys(),
    ])

// MARK: - daemon

case "daemon":
    guard let socketPath = getArg("--socket-path") else {
        jsonError("Missing --socket-path argument")
    }

    let sessionManager = SessionManager()
    let server = IPCServer(socketPath: socketPath)

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
        exit(0)
    }

    sessionManager.onDaemonTimeout = {
        shutdownDaemon()
    }

    server.onConnectionActivity = {
        sessionManager.noteIpcActivity()
    }

    // Handle IPC messages (ttyId is resolved from the peer's controlling terminal)
    server.messageHandler = { message, ttyId in
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
                let context = try sessionManager.getAuthenticatedContext(ttyId: ttyId)
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
                    "sessionWarm": sessionManager.isSessionWarm(ttyId: ttyId),
                    "ttyId": ttyId as Any,
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

            guard let value = SecureInputDialog.prompt(
                title: "Varlock — Enter Secret",
                message: promptMessage,
                itemKey: itemKey
            ) else {
                return ["error": "cancelled"]
            }

            // Encrypt the entered value immediately
            let promptKeyId = (promptPayload?["keyId"] as? String) ?? defaultKeyId
            guard let valueData = value.data(using: .utf8) else {
                return ["error": "Value is not valid UTF-8"]
            }

            do {
                let encrypted = try SecureEnclaveManager.encrypt(plaintext: valueData, keyId: promptKeyId)
                return ["result": [
                    "ciphertext": encrypted.base64EncodedString(),
                ]]
            } catch {
                return ["error": error.localizedDescription]
            }

        case "invalidate-session":
            sessionManager.invalidateAllSessions()
            statusBarMenu?.refresh()
            return ["result": "all sessions invalidated"]

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
                    return ["error": error.localizedDescription]
                }
            }

            // Password reads require biometric gate
            do {
                _ = try sessionManager.getAuthenticatedContext(ttyId: ttyId)
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
                return ["error": error.localizedDescription]
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

        default:
            return ["error": "Unknown action: \(action)"]
        }
    }

    // Start server
    do {
        try server.start()

        // Print ready message to stdout so the JS launcher knows we're ready
        jsonOutput(["ready": true, "pid": ProcessInfo.processInfo.processIdentifier, "socketPath": socketPath])
        fflush(stdout)

        // Set up status bar menu
        statusBarMenu = StatusBarMenu(
            sessionManager: sessionManager,
            onLock: {
                sessionManager.invalidateAllSessions()
                statusBarMenu?.refresh()
            },
            onQuit: {
                shutdownDaemon()
            }
        )

        // We need a run loop for NSWorkspace notifications (sleep/lock detection)
        // and for the status bar menu to work
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)

        let sigTermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        sigTermSource.setEventHandler { shutdownDaemon() }
        sigTermSource.resume()

        let sigIntSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        sigIntSource.setEventHandler { shutdownDaemon() }
        sigIntSource.resume()

        app.run()
    } catch {
        jsonError("Failed to start daemon: \(error.localizedDescription)")
    }

// MARK: - help

case "help", "--help", "-h":
    let help = """
    varlock-enclave - Secure Enclave encryption daemon for Varlock

    COMMANDS:
      generate-key [--key-id <id>]    Create a new Secure Enclave key
      delete-key [--key-id <id>]      Delete a Secure Enclave key
      list-keys                       List all Varlock Secure Enclave keys
      key-exists [--key-id <id>]      Check if a key exists
      encrypt --data <base64> [--key-id <id>]   Encrypt data (one-shot)
      decrypt --data <base64> [--key-id <id>]   Decrypt data (one-shot, testing)
      status                          Check Secure Enclave availability
      daemon --socket-path <path> [--pid-path <path>]   Start IPC daemon

    OPTIONS:
      --key-id <id>       Key identifier (default: varlock-default)
      --data <base64>     Base64-encoded data
      --socket-path <path>  Unix socket path for daemon mode
      --pid-path <path>   PID file path for daemon mode

    All output is JSON. Errors return {"error": "message"}.
    """
    print(help)
    exit(0)

default:
    jsonError("Unknown command: \(command). Run with --help for usage.")
}
