import Foundation
import Security
import LocalAuthentication
import CryptoKit

/// Manages Secure Enclave key operations and ECIES encrypt/decrypt.
///
/// Uses CryptoKit's SecureEnclave.P256 API. Key "data representations" (opaque handles
/// to the SE key, NOT the private key itself) are stored as files on disk.
/// This avoids Keychain entitlement requirements that plague CLI tools.
///
/// Crypto scheme:
/// - P-256 key stored in Secure Enclave with biometric access control
/// - ECIES: ephemeral P-256 key pair → ECDH → HKDF-SHA256 → AES-256-GCM
/// - Payload: version(1) | ephemeralPubKey(65) | nonce(12) | ciphertext(N) | tag(16)
final class SecureEnclaveManager {
    static let payloadVersion: UInt8 = 0x01

    /// Directory where key data representations are stored
    static var keyStorePath: String {
        let xdg = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
        let base = xdg ?? (NSHomeDirectory() + "/.config")
        return base + "/varlock/secure-enclave/keys"
    }

    private static func keyFilePath(for keyId: String) -> String {
        return keyStorePath + "/\(keyId).keydata"
    }

    // MARK: - Key Management

    /// Create a new Secure Enclave P-256 key.
    ///
    /// By default, requires user presence (Touch ID, Apple Watch, or device password).
    /// Pass `requireAuth: false` for CI/testing — key is still SE-backed but no biometric.
    /// Saves the key data representation to disk and returns the public key.
    static func generateKey(keyId: String, context: LAContext? = nil, requireAuth: Bool = true) throws -> Data {
        // Create access control — with or without user presence requirement
        var accessError: Unmanaged<CFError>?
        let flags: SecAccessControlCreateFlags = requireAuth
            ? [.privateKeyUsage, .userPresence]
            : [.privateKeyUsage]
        guard let accessControl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            flags,
            &accessError
        ) else {
            let err = accessError?.takeRetainedValue()
            throw EnclaveError.keyGenerationFailed(err?.localizedDescription ?? "Failed to create access control")
        }

        // Generate the SE key via CryptoKit
        let privateKey: SecureEnclave.P256.KeyAgreement.PrivateKey
        do {
            if let context = context {
                privateKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(
                    accessControl: accessControl,
                    authenticationContext: context
                )
            } else {
                privateKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(
                    accessControl: accessControl
                )
            }
        } catch {
            throw EnclaveError.keyGenerationFailed(error.localizedDescription)
        }

        // Save the data representation (an opaque handle, NOT the private key)
        let dataRepresentation = privateKey.dataRepresentation
        let filePath = keyFilePath(for: keyId)
        let dir = (filePath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

        // Restrict directory to owner-only (prevents listing key filenames)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: dir
        )

        try dataRepresentation.write(to: URL(fileURLWithPath: filePath))

        // Set file permissions to owner-only
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: filePath
        )

        return Data(privateKey.publicKey.x963Representation)
    }

    /// Delete a key by removing its data representation file.
    static func deleteKey(keyId: String) -> Bool {
        let filePath = keyFilePath(for: keyId)
        do {
            try FileManager.default.removeItem(atPath: filePath)
            return true
        } catch {
            return false
        }
    }

    /// List key IDs by scanning the key store directory.
    static func listKeys() -> [String] {
        let dir = keyStorePath
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir) else {
            return []
        }
        return files
            .filter { $0.hasSuffix(".keydata") }
            .map { String($0.dropLast(".keydata".count)) }
    }

    /// Check if a key exists.
    static func keyExists(keyId: String) -> Bool {
        return FileManager.default.fileExists(atPath: keyFilePath(for: keyId))
    }

    // MARK: - Key Loading

    /// Load a Secure Enclave private key from its stored data representation.
    private static func loadPrivateKey(keyId: String, context: LAContext?) throws -> SecureEnclave.P256.KeyAgreement.PrivateKey {
        let filePath = keyFilePath(for: keyId)
        guard let data = FileManager.default.contents(atPath: filePath) else {
            throw EnclaveError.keyNotFound(keyId)
        }

        do {
            if let context = context {
                return try SecureEnclave.P256.KeyAgreement.PrivateKey(
                    dataRepresentation: data,
                    authenticationContext: context
                )
            } else {
                return try SecureEnclave.P256.KeyAgreement.PrivateKey(
                    dataRepresentation: data
                )
            }
        } catch {
            throw EnclaveError.keyNotFound("\(keyId) - \(error.localizedDescription)")
        }
    }

    // MARK: - ECIES Encrypt

    /// Encrypt plaintext using ECIES with the Secure Enclave key.
    ///
    /// Only needs the public key, so no biometric auth required for encryption.
    /// Steps:
    /// 1. Load SE key to get public key
    /// 2. Generate ephemeral P-256 key pair
    /// 3. ECDH: ephemeral private × SE public → shared secret
    /// 4. HKDF-SHA256 derive AES-256-GCM key
    /// 5. AES-256-GCM encrypt
    /// 6. Return: version | ephemeralPub | nonce | ciphertext | tag
    static func encrypt(plaintext: Data, keyId: String) throws -> Data {
        let seKey = try loadPrivateKey(keyId: keyId, context: nil)
        let sePublicKey = seKey.publicKey
        let pubKeyData = Data(sePublicKey.x963Representation)

        // Generate ephemeral key pair (in software, not SE)
        let ephemeralPrivateKey = P256.KeyAgreement.PrivateKey()
        let ephemeralPublicKeyData = Data(ephemeralPrivateKey.publicKey.x963Representation) // 65 bytes

        // ECDH: ephemeral private × SE public
        let sharedSecret = try ephemeralPrivateKey.sharedSecretFromKeyAgreement(with: sePublicKey)

        // Extract raw shared secret bytes for HKDF
        let sharedSecretData = sharedSecret.withUnsafeBytes { Data($0) }

        // HKDF derive AES-256 key (using manual HKDF to match decrypt path)
        let symmetricKey = SecureEnclaveManager.deriveKey(
            sharedSecret: sharedSecretData,
            salt: Data("varlock-ecies-v1".utf8),
            info: ephemeralPublicKeyData + pubKeyData,
            outputByteCount: 32
        )

        // AES-256-GCM encrypt
        let sealedBox = try AES.GCM.seal(plaintext, using: symmetricKey)

        // Assemble payload: version(1) | ephemeralPub(65) | nonce(12) | ciphertext(N) | tag(16)
        var payload = Data()
        payload.append(SecureEnclaveManager.payloadVersion)
        payload.append(ephemeralPublicKeyData)            // 65 bytes
        payload.append(contentsOf: sealedBox.nonce)       // 12 bytes
        payload.append(sealedBox.ciphertext)              // N bytes
        payload.append(sealedBox.tag)                     // 16 bytes

        return payload
    }

    // MARK: - ECIES Decrypt

    /// Decrypt ciphertext using ECIES with the Secure Enclave key.
    /// Uses the provided LAContext for biometric session caching.
    ///
    /// Steps:
    /// 1. Parse payload components
    /// 2. Load SE private key with LAContext (uses cached biometric)
    /// 3. ECDH: SE private × ephemeral public → shared secret
    /// 4. HKDF-SHA256 derive AES-256-GCM key
    /// 5. AES-256-GCM decrypt
    static func decrypt(payload: Data, keyId: String, context: LAContext?) throws -> Data {
        // Parse payload
        guard payload.count > 1 + 65 + 12 + 16 else {
            throw EnclaveError.decryptionFailed("Payload too short")
        }

        let version = payload[0]
        guard version == SecureEnclaveManager.payloadVersion else {
            throw EnclaveError.decryptionFailed("Unsupported payload version: \(version)")
        }

        let ephemeralPubKeyData = payload[1..<66]         // 65 bytes
        let nonce = payload[66..<78]                       // 12 bytes
        let ciphertextAndTag = payload[78...]
        guard ciphertextAndTag.count >= 16 else {
            throw EnclaveError.decryptionFailed("Payload too short for tag")
        }
        let ciphertext = ciphertextAndTag.dropLast(16)
        let tag = ciphertextAndTag.suffix(16)

        // Load SE private key with LAContext for cached biometric session
        let seKey = try loadPrivateKey(keyId: keyId, context: context)
        let pubKeyData = Data(seKey.publicKey.x963Representation)

        // Reconstruct ephemeral public key
        let ephemeralPublicKey = try P256.KeyAgreement.PublicKey(x963Representation: ephemeralPubKeyData)

        // ECDH: SE private × ephemeral public
        // CryptoKit's SecureEnclave key performs the ECDH inside the SE
        let sharedSecret = try seKey.sharedSecretFromKeyAgreement(with: ephemeralPublicKey)
        let sharedSecretData = sharedSecret.withUnsafeBytes { Data($0) }

        // Derive symmetric key using HKDF (must match encrypt side)
        let symmetricKey = SecureEnclaveManager.deriveKey(
            sharedSecret: sharedSecretData,
            salt: Data("varlock-ecies-v1".utf8),
            info: Data(ephemeralPubKeyData) + pubKeyData,
            outputByteCount: 32
        )

        // AES-256-GCM decrypt
        let gcmNonce = try AES.GCM.Nonce(data: nonce)
        let sealedBox = try AES.GCM.SealedBox(nonce: gcmNonce, ciphertext: ciphertext, tag: tag)
        let decrypted = try AES.GCM.open(sealedBox, using: symmetricKey)

        return decrypted
    }
}

// MARK: - HKDF

// We implement HKDF manually so both encrypt and decrypt paths are consistent.
// On the encrypt side we could use CryptoKit's built-in HKDF via SharedSecret,
// but on the decrypt side the SE key's sharedSecretFromKeyAgreement also returns
// a SharedSecret, so actually both paths are consistent now.
// Keeping manual HKDF for explicitness and in case we ever need raw SecKey ECDH.
extension SecureEnclaveManager {
    /// HKDF-SHA256 key derivation from raw shared secret bytes.
    static func deriveKey(
        sharedSecret: Data,
        salt: Data,
        info: Data,
        outputByteCount: Int
    ) -> SymmetricKey {
        // HKDF-Extract
        let prk = HMAC<SHA256>.authenticationCode(for: sharedSecret, using: SymmetricKey(data: salt))
        let prkData = Data(prk)

        // HKDF-Expand
        var okm = Data()
        var t = Data()
        var counter: UInt8 = 1

        while okm.count < outputByteCount {
            var input = t
            input.append(info)
            input.append(counter)
            t = Data(HMAC<SHA256>.authenticationCode(for: input, using: SymmetricKey(data: prkData)))
            okm.append(t)
            counter += 1
        }

        return SymmetricKey(data: okm.prefix(outputByteCount))
    }
}

// MARK: - Error Types

enum EnclaveError: LocalizedError {
    case keyGenerationFailed(String)
    case keyNotFound(String)
    case encryptionFailed(String)
    case decryptionFailed(String)
    case biometricFailed(String)
    case notSupported(String)

    var errorDescription: String? {
        switch self {
        case .keyGenerationFailed(let msg): return "Key generation failed: \(msg)"
        case .keyNotFound(let keyId): return "Key not found: \(keyId)"
        case .encryptionFailed(let msg): return "Encryption failed: \(msg)"
        case .decryptionFailed(let msg): return "Decryption failed: \(msg)"
        case .biometricFailed(let msg): return "Biometric authentication failed: \(msg)"
        case .notSupported(let msg): return "Not supported: \(msg)"
        }
    }
}
