import Foundation
import LocalAuthentication
import AppKit

/// Manages biometric authentication sessions for the daemon, scoped per-session.
///
/// Each terminal or parent application must independently authenticate via
/// Touch ID. This prevents rogue processes from piggybacking on an existing
/// session. Sessions are identified by TTY device (for terminal processes)
/// or by session leader PID (for GUI-spawned processes like VSCode extensions).
///
/// Biometric reuse timeout is handled by macOS via `touchIDAuthenticationAllowableReuseDuration`.
/// This manager handles per-session scoping, explicit invalidation (lock command),
/// and system events (sleep, screen lock).
final class SessionManager {
    /// How long Touch ID stays unlocked per terminal before re-prompting (seconds).
    /// Passed to macOS via `touchIDAuthenticationAllowableReuseDuration`.
    static let sessionTimeout: TimeInterval = 300 // 5 minutes

    /// How long the daemon stays alive with no connections at all
    static let daemonInactivityTimeout: TimeInterval = 1800 // 30 minutes

    /// Per-session cached LAContext (macOS owns the timeout via reuse duration)
    private var contexts: [String: LAContext] = [:]
    private let queue = DispatchQueue(label: "dev.varlock.session")

    /// Called when the daemon should shut down due to inactivity
    var onDaemonTimeout: (() -> Void)?

    private var daemonTimer: DispatchSourceTimer?

    init() {
        setupSystemNotifications()
        resetDaemonTimer()
    }

    deinit {
        daemonTimer?.cancel()
    }

    // MARK: - Public API

    /// Get or create an authenticated LAContext for the given session.
    /// On first call per session, triggers Touch ID. Subsequent calls within the
    /// reuse duration return the cached context without re-prompting.
    ///
    /// Sessions are identified by TTY device (terminal) or session leader PID
    /// (GUI-spawned processes). Processes with no identifiable session always
    /// require fresh authentication.
    func getAuthenticatedContext(ttyId: String?) throws -> LAContext {
        return try queue.sync {
            // Check for cached context from a previous auth in this session
            if let key = ttyId, let context = contexts[key] {
                resetDaemonTimer()
                return context
            }

            // Need fresh auth (always for no-TTY, or first time for this TTY)
            let context = LAContext()
            context.touchIDAuthenticationAllowableReuseDuration = SessionManager.sessionTimeout

            // Use deviceOwnerAuthentication which accepts Touch ID, Apple Watch,
            // or device password — works on machines without biometrics and
            // supports the "Use Password" fallback in the Touch ID dialog.
            var authError: NSError?
            guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) else {
                let msg = authError?.localizedDescription ?? "Authentication not available"
                throw EnclaveError.biometricFailed(msg)
            }

            // Synchronous authentication evaluation
            let semaphore = DispatchSemaphore(value: 0)
            var evalError: Error?

            context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "decrypt your secrets"
            ) { success, error in
                if !success {
                    evalError = error
                }
                semaphore.signal()
            }

            semaphore.wait()

            if let error = evalError {
                throw EnclaveError.biometricFailed(error.localizedDescription)
            }

            // Only cache if the process has a session identity to scope to.
            // Unidentifiable callers get a fresh context every time.
            if let key = ttyId {
                contexts[key] = context
            }
            resetDaemonTimer()

            return context
        }
    }

    /// Invalidate all sessions (used by lock command, sleep/lock events).
    func invalidateAllSessions() {
        queue.sync {
            for (_, context) in contexts {
                context.invalidate()
            }
            contexts.removeAll()
        }
    }

    /// Resets the daemon shutdown timer (no Touch ID). Call for any IPC so the
    /// process stays up while clients use ping, encrypt, etc., not only decrypt.
    func noteIpcActivity() {
        queue.async { [weak self] in
            self?.resetDaemonTimer()
        }
    }

    /// Whether the given session has a cached context.
    /// Always returns false for unidentifiable callers (they never cache).
    /// Note: the session may still re-prompt if macOS's reuse duration has expired.
    func isSessionWarm(ttyId: String?) -> Bool {
        guard let key = ttyId else { return false }
        return queue.sync {
            return contexts[key] != nil
        }
    }

    /// Whether any session has a cached context.
    func hasAnySessions() -> Bool {
        return queue.sync {
            return !contexts.isEmpty
        }
    }

    // MARK: - Private

    private func resetDaemonTimer() {
        daemonTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + SessionManager.daemonInactivityTimeout)
        timer.setEventHandler { [weak self] in
            self?.onDaemonTimeout?()
        }
        timer.resume()
        daemonTimer = timer
    }

    // MARK: - System Notifications

    private func setupSystemNotifications() {
        let workspace = NSWorkspace.shared
        let notificationCenter = workspace.notificationCenter

        // Screen lock / sleep → invalidate ALL sessions
        notificationCenter.addObserver(
            forName: NSWorkspace.willSleepNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.invalidateAllSessions()
        }

        notificationCenter.addObserver(
            forName: NSWorkspace.sessionDidResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.invalidateAllSessions()
        }

        notificationCenter.addObserver(
            forName: NSWorkspace.screensDidSleepNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.invalidateAllSessions()
        }

        // Also invalidate when screens lock (available on macOS 13+)
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("com.apple.screenIsLocked"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.invalidateAllSessions()
        }
    }
}
