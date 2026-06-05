import Foundation

/// Unix domain socket IPC server using length-prefixed JSON protocol.
///
/// Protocol:
/// - 4-byte little-endian message length
/// - JSON payload: { "id": "...", "action": "...", "payload": { ... } }
/// - Response: { "id": "...", "result": "..." } or { "id": "...", "error": "..." }
final class IPCServer {
    private let socketPath: String
    private var socketFD: Int32 = -1
    private var lockFD: Int32 = -1
    private var clientHandlers: [Int32: DispatchWorkItem] = [:]
    private let queue = DispatchQueue(label: "dev.varlock.ipc", attributes: .concurrent)
    private let handlersQueue = DispatchQueue(label: "dev.varlock.ipc.handlers")
    private var isRunning = false

    /// Handler for incoming messages. Second parameter is the peer's TTY identity (nil if unknown).
    var messageHandler: ((_ message: [String: Any], _ sessionId: String?) -> [String: Any])?

    /// Called after accept (new client) and after each successfully parsed JSON message.
    var onConnectionActivity: (() -> Void)?

    init(socketPath: String) {
        self.socketPath = socketPath
    }

    // MARK: - Stuck-daemon Recovery

    /// Lock-age threshold below which a flock failure is treated as a
    /// parallel-spawn race rather than a stuck holder. See `start()`.
    static let freshLockThresholdSeconds: Double = 5.0

    /// Age of the lock file in seconds (since its mtime). Returns +Infinity
    /// if the file can't be stat'd, which makes callers treat it as "old".
    static func lockFileAgeSeconds(path: String) -> Double {
        var st = stat()
        guard stat(path, &st) == 0 else { return .infinity }
        return max(0, Double(time(nil)) - Double(st.st_mtimespec.tv_sec))
    }

    /// Probe the daemon's IPC socket with a framed `ping` request. Returns
    /// true if any bytes come back within `timeoutMs`. We don't parse the
    /// response — receipt of a reply is sufficient evidence the daemon is
    /// alive and serving requests.
    static func existingDaemonResponsive(socketPath: String, timeoutMs: Int32) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        var tv = timeval(
            tv_sec: __darwin_time_t(timeoutMs / 1000),
            tv_usec: __darwin_suseconds_t((timeoutMs % 1000) * 1000)
        )
        _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            socketPath.withCString { cstr in
                _ = strcpy(UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: CChar.self), cstr)
            }
        }
        let connectResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                connect(fd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connectResult == 0 else { return false }

        let json = #"{"id":"lock-probe","action":"ping"}"#
        guard let body = json.data(using: .utf8) else { return false }
        let lenBytes = withUnsafeBytes(of: UInt32(body.count).littleEndian) { Array($0) }

        let sentLen = lenBytes.withUnsafeBufferPointer { buf in
            send(fd, buf.baseAddress, buf.count, 0)
        }
        guard sentLen == 4 else { return false }
        let sentBody = body.withUnsafeBytes { buf in
            send(fd, buf.baseAddress, buf.count, 0)
        }
        guard sentBody == body.count else { return false }

        var rxBuf = [UInt8](repeating: 0, count: 16)
        let received = rxBuf.withUnsafeMutableBufferPointer { ptr in
            recv(fd, ptr.baseAddress, ptr.count, 0)
        }
        return received > 0
    }

    // MARK: - Server Lifecycle

    func start() throws {
        // Ensure parent directory exists with owner-only access
        let dir = (socketPath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        chmod(dir, 0o700)

        // Acquire an exclusive lock to prevent race conditions during socket setup.
        // Without this, a malicious process could create a fake socket at our path
        // between unlink() and bind(), intercepting client connections.
        //
        // Flock failures are triaged by lock age and existing-daemon responsiveness:
        //   - Fresh lock (< 5s)         → parallel-spawn race; exit cleanly.
        //   - Old + socket responds     → healthy long-running daemon; exit cleanly.
        //   - Old + socket unresponsive → kernel-stuck daemon (e.g. Secure Enclave
        //                                  wedge survives SIGKILL); take over by
        //                                  recreating the lock file inode.
        // The two-signal check prevents the original "always bypass" behavior from
        // spawning duplicate daemons during parallel-spawn races, while preserving
        // recovery from genuinely stuck daemons that even the TS-side
        // killDaemonProcess can't bring down.
        let lockPath = socketPath + ".lock"
        lockFD = open(lockPath, O_CREAT | O_RDWR, 0o600)
        guard lockFD >= 0 else {
            throw IPCError.socketCreationFailed("Failed to create lock file: \(String(cString: strerror(errno)))")
        }
        if flock(lockFD, LOCK_EX | LOCK_NB) != 0 {
            let lockAgeSeconds = IPCServer.lockFileAgeSeconds(path: lockPath)
            let isFresh = lockAgeSeconds < IPCServer.freshLockThresholdSeconds

            if isFresh || IPCServer.existingDaemonResponsive(socketPath: socketPath, timeoutMs: 1500) {
                close(lockFD)
                lockFD = -1
                throw IPCError.lockHeld
            }

            // Old + unresponsive: previous daemon is wedged in the kernel and
            // can't be signaled away. Recreate the lock file so we get a fresh
            // inode whose flock is independent of the stuck holder's.
            close(lockFD)
            unlink(lockPath)
            lockFD = open(lockPath, O_CREAT | O_RDWR, 0o600)
            guard lockFD >= 0 else {
                throw IPCError.socketCreationFailed("Failed to recreate lock file: \(String(cString: strerror(errno)))")
            }
            guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
                close(lockFD)
                lockFD = -1
                throw IPCError.socketCreationFailed("Failed to take over stuck daemon's lock")
            }
        }

        // Clean up any stale socket file (safe now — we hold the lock)
        unlink(socketPath)

        // Create socket
        socketFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFD >= 0 else {
            throw IPCError.socketCreationFailed(String(cString: strerror(errno)))
        }

        // Bind
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            socketPath.withCString { cstr in
                _ = strcpy(UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: CChar.self), cstr)
            }
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                bind(socketFD, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            close(socketFD)
            throw IPCError.bindFailed(String(cString: strerror(errno)))
        }

        // Set socket permissions (owner only)
        chmod(socketPath, 0o600)

        // Listen
        guard listen(socketFD, 5) == 0 else {
            close(socketFD)
            unlink(socketPath)
            throw IPCError.listenFailed(String(cString: strerror(errno)))
        }

        isRunning = true

        // Accept loop on background queue
        queue.async { [weak self] in
            self?.acceptLoop()
        }
    }

    func stop() {
        isRunning = false
        if socketFD >= 0 {
            close(socketFD)
            socketFD = -1
        }
        unlink(socketPath)

        // Release the startup lock
        if lockFD >= 0 {
            flock(lockFD, LOCK_UN)
            close(lockFD)
            lockFD = -1
        }
        unlink(socketPath + ".lock")

        // Cancel all client handlers
        handlersQueue.sync {
            for (fd, work) in clientHandlers {
                work.cancel()
                close(fd)
            }
            clientHandlers.removeAll()
        }
    }

    // MARK: - Accept Loop

    private func acceptLoop() {
        while isRunning {
            var clientAddr = sockaddr_un()
            var clientAddrLen = socklen_t(MemoryLayout<sockaddr_un>.size)

            let clientFD = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                    accept(socketFD, sockaddrPtr, &clientAddrLen)
                }
            }

            guard clientFD >= 0 else {
                if !isRunning { break }
                continue
            }

            onConnectionActivity?()

            let workItem = DispatchWorkItem { [weak self] in
                self?.handleClient(fd: clientFD)
            }
            handlersQueue.sync {
                clientHandlers[clientFD] = workItem
            }
            queue.async(execute: workItem)
        }
    }

    // MARK: - Client Handling

    private func handleClient(fd: Int32) {
        defer {
            close(fd)
            handlersQueue.sync {
                _ = clientHandlers.removeValue(forKey: fd)
            }
        }

        // Verify the connecting process is an allowed client
        if let peerPid = getPeerPid(fd: fd) {
            guard verifyPeerProcess(pid: peerPid) != nil else {
                let path = getProcessPath(pid: peerPid) ?? "unknown"
                fputs("varlock: rejected IPC connection from unauthorized process (pid=\(peerPid), path=\(path))\n", stderr)
                sendResponse(fd: fd, response: ["error": "Unauthorized client process"])
                return
            }
        }

        // Resolve the peer's session identity once per connection
        let sessionId: String?
        if let peerPid = getPeerPid(fd: fd) {
            sessionId = getSessionIdentifier(forPid: peerPid)
        } else {
            sessionId = nil
        }

        while isRunning {
            // Read 4-byte length prefix (little-endian)
            var lengthBytes = [UInt8](repeating: 0, count: 4)
            let bytesRead = recv(fd, &lengthBytes, 4, MSG_WAITALL)
            guard bytesRead == 4 else { break }

            let messageLength = Int(UInt32(lengthBytes[0])
                | (UInt32(lengthBytes[1]) << 8)
                | (UInt32(lengthBytes[2]) << 16)
                | (UInt32(lengthBytes[3]) << 24))

            guard messageLength > 0, messageLength < 10_000_000 else { break } // 10MB safety limit

            // Read message body
            var messageData = Data(count: messageLength)
            let bodyRead = messageData.withUnsafeMutableBytes { ptr in
                recv(fd, ptr.baseAddress!, messageLength, MSG_WAITALL)
            }
            guard bodyRead == messageLength else { break }

            // Parse JSON
            guard let json = try? JSONSerialization.jsonObject(with: messageData) as? [String: Any] else {
                sendResponse(fd: fd, response: ["error": "Invalid JSON"])
                continue
            }

            onConnectionActivity?()

            // Handle message with the peer's TTY identity
            let response = messageHandler?(json, sessionId) ?? ["error": "No handler"]
            sendResponse(fd: fd, id: json["id"] as? String, response: response)
        }
    }

    private func sendResponse(fd: Int32, id: String? = nil, response: [String: Any]) {
        var fullResponse = response
        if let id = id {
            fullResponse["id"] = id
        }

        guard let jsonData = try? JSONSerialization.data(withJSONObject: fullResponse) else {
            return
        }

        // Copy into a mutable buffer so we can zero it after sending.
        // JSONSerialization returns immutable Data backed by an internal buffer
        // that we can't scrub, so we work with our own copy.
        var mutableBuf = [UInt8](jsonData)
        defer {
            // Zero the buffer to avoid leaving plaintext in the heap
            _ = mutableBuf.withUnsafeMutableBufferPointer { ptr in
                memset_s(ptr.baseAddress!, ptr.count, 0, ptr.count)
            }
        }

        // Write length prefix (4 bytes, little-endian)
        var length = UInt32(mutableBuf.count).littleEndian
        _ = withUnsafeBytes(of: &length) { ptr in
            send(fd, ptr.baseAddress!, 4, 0)
        }

        // Write message body
        mutableBuf.withUnsafeBufferPointer { ptr in
            _ = send(fd, ptr.baseAddress!, ptr.count, 0)
        }
    }
}

// MARK: - Errors

enum IPCError: LocalizedError {
    case socketCreationFailed(String)
    case bindFailed(String)
    case listenFailed(String)
    case lockHeld

    var errorDescription: String? {
        switch self {
        case .socketCreationFailed(let msg): return "Socket creation failed: \(msg)"
        case .bindFailed(let msg): return "Socket bind failed: \(msg)"
        case .listenFailed(let msg): return "Socket listen failed: \(msg)"
        case .lockHeld: return "Another daemon instance is already running"
        }
    }
}
