import Foundation

/// The append-only record of what the daemon authorized.
///
/// One line of JSON per authorization, in a file only the user can read. The
/// point is answerability: if a session key was used, there is a durable line
/// saying when, for which key, under which grant, and which process asked. A
/// decrypt whose line cannot be written is refused, so the log has no holes
/// where the interesting cases would be.
///
/// What a record must never contain is anything worth stealing. Every field
/// here is an identifier, a count, or a description of a process; no plaintext,
/// no ciphertext, and no key material passes through this type at all.
public struct AuthorizationRecord: Equatable {
    public enum Kind: String {
        /// Plaintext was about to be handed back for a batch of payloads.
        case decrypt = "decrypt-v2"
        /// A session took (or extended) its hold on one or more keys.
        case unlock = "unlock-session"
        /// Someone dropped grants on purpose.
        case invalidate = "invalidate-session"
    }

    public let kind: Kind
    /// Session identity as resolved from the peer, never as claimed by it.
    public let sessionId: String
    public let keyIds: [String]
    public let identityId: String?
    /// How many payloads this call covered. Zero for anything but a decrypt.
    public let payloadCount: Int
    /// The grant scope the call ran under, when there was one.
    public let scope: String?
    /// One line describing the process that asked, derived by the daemon.
    public let requester: String?

    public init(
        kind: Kind,
        sessionId: String,
        keyIds: [String],
        identityId: String? = nil,
        payloadCount: Int = 0,
        scope: String? = nil,
        requester: String? = nil
    ) {
        self.kind = kind
        self.sessionId = sessionId
        self.keyIds = keyIds
        self.identityId = identityId
        self.payloadCount = payloadCount
        self.scope = scope
        self.requester = requester
    }

    public func jsonObject(timestamp: String) -> [String: Any] {
        var object: [String: Any] = [
            "ts": timestamp,
            "event": kind.rawValue,
            "sessionId": sessionId,
            "keyIds": keyIds,
            "payloadCount": payloadCount,
        ]
        if let identityId { object["identityId"] = identityId }
        if let scope { object["scope"] = scope }
        if let requester { object["requester"] = requester }
        return object
    }
}

public enum AuthorizationAuditError: LocalizedError {
    /// The record did not make it to disk, whatever the reason.
    case notPersisted(String)

    public var errorDescription: String? {
        switch self {
        case .notPersisted(let reason):
            return "Refusing to release secrets: the authorization could not be recorded (\(reason))"
        }
    }

    /// Stable code the TS client can branch on without matching message text.
    public var code: String {
        switch self {
        case .notPersisted: return "AUDIT_WRITE_FAILED"
        }
    }
}

/// Appends authorization records, synchronously, and proves each one landed.
///
/// Deliberately small and blocking. It runs on the path that is about to hand
/// back plaintext, so it has no queue to fall behind on, no buffer to lose on a
/// crash, and no way to report success for a line that is not on disk: every
/// append is flushed with `fsync` and then read back off the file before the
/// caller is told it worked.
public final class AuthorizationAuditLog {
    public static let fileName = "authorizations.jsonl"

    public let directoryPath: String
    public var filePath: String { return directoryPath + "/" + Self.fileName }

    private let timestamp: () -> String
    /// Serialized so a read-back can trust the offset its own write returned.
    private let queue = DispatchQueue(label: "dev.varlock.audit")

    public init(
        directoryPath: String,
        timestamp: @escaping () -> String = { AuthorizationAuditLog.iso8601(Date()) }
    ) {
        self.directoryPath = directoryPath
        self.timestamp = timestamp
    }

    public static func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }

    /// Write one record, or throw. There is no third outcome.
    public func append(_ record: AuthorizationRecord) throws {
        let line = try encode(record)
        try queue.sync {
            try ensureDirectory()
            let fd = open(filePath, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)
            guard fd >= 0 else {
                throw AuthorizationAuditError.notPersisted("cannot open \(filePath): \(errnoText())")
            }
            defer { close(fd) }

            try writeFully(fd: fd, bytes: line)
            guard fsync(fd) == 0 else {
                throw AuthorizationAuditError.notPersisted("fsync failed: \(errnoText())")
            }

            let end = lseek(fd, 0, SEEK_CUR)
            guard end >= Int64(line.count) else {
                throw AuthorizationAuditError.notPersisted("could not locate the record just written")
            }
            try verifyReadBack(bytes: line, at: end - Int64(line.count))
        }
    }

    // MARK: - Private

    private func encode(_ record: AuthorizationRecord) throws -> [UInt8] {
        let object = record.jsonObject(timestamp: timestamp())
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            throw AuthorizationAuditError.notPersisted("record could not be serialized")
        }
        // One record per line is the whole format, so a record that somehow
        // carried a raw newline would corrupt the next one. JSON escaping already
        // rules this out; the check is here so a future field cannot break it
        // quietly.
        guard !data.contains(UInt8(ascii: "\n")) else {
            throw AuthorizationAuditError.notPersisted("record contains a line break")
        }
        return [UInt8](data) + [UInt8(ascii: "\n")]
    }

    private func ensureDirectory() throws {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: directoryPath, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else {
                throw AuthorizationAuditError.notPersisted("\(directoryPath) is not a directory")
            }
            return
        }
        do {
            try FileManager.default.createDirectory(
                atPath: directoryPath,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            throw AuthorizationAuditError.notPersisted(
                "cannot create \(directoryPath): \(error.localizedDescription)"
            )
        }
    }

    private func writeFully(fd: Int32, bytes: [UInt8]) throws {
        var written = 0
        while written < bytes.count {
            let result = bytes.withUnsafeBufferPointer { buffer -> Int in
                guard let base = buffer.baseAddress else { return -1 }
                return write(fd, base.advanced(by: written), bytes.count - written)
            }
            if result <= 0 {
                if result < 0 && errno == EINTR { continue }
                throw AuthorizationAuditError.notPersisted("short write: \(errnoText())")
            }
            written += result
        }
    }

    /// Read the bytes back off the file. A write that returned success but left
    /// nothing behind (a full disk that only reports at flush time, a file
    /// swapped underneath us) has to be caught here or not at all.
    private func verifyReadBack(bytes: [UInt8], at offset: off_t) throws {
        let fd = open(filePath, O_RDONLY | O_CLOEXEC)
        guard fd >= 0 else {
            throw AuthorizationAuditError.notPersisted("cannot re-open \(filePath): \(errnoText())")
        }
        defer { close(fd) }

        var readBack = [UInt8](repeating: 0, count: bytes.count)
        let got = readBack.withUnsafeMutableBufferPointer { buffer -> Int in
            guard let base = buffer.baseAddress else { return -1 }
            return pread(fd, base, bytes.count, offset)
        }
        guard got == bytes.count, readBack == bytes else {
            throw AuthorizationAuditError.notPersisted("the record did not read back from disk")
        }
    }

    private func errnoText() -> String {
        return String(cString: strerror(errno))
    }
}
