import Foundation
import LocalAuthentication
import AppKit
import IdentitySessions

/// Manages biometric authentication sessions for the daemon, scoped per-session.
///
/// Each terminal or parent application must independently authenticate via
/// Touch ID. This prevents rogue processes from piggybacking on an existing
/// session. Sessions are identified by TTY device (for terminal processes)
/// or by a stable ancestor PID (for GUI-spawned processes like VSCode extensions).
///
/// Biometric reuse timeout is handled by macOS via `touchIDAuthenticationAllowableReuseDuration`.
/// This manager handles per-session scoping, explicit invalidation (lock command),
/// and system events (sleep, screen lock).
final class SessionManager {
    /// How long Touch ID stays unlocked per terminal before re-prompting (seconds).
    /// Passed to macOS via `touchIDAuthenticationAllowableReuseDuration`.
    static let sessionTimeout: TimeInterval = 300 // 5 minutes

    /// Max time to wait for evaluatePolicy (biometric prompt) before giving up.
    /// Prevents the daemon from hanging forever if the prompt is dismissed oddly
    /// or the Secure Enclave stops responding.
    static let biometricTimeoutSeconds: TimeInterval = 60

    /// How long the daemon stays alive with no connections at all
    static let daemonInactivityTimeout: TimeInterval = 1800 // 30 minutes

    /// Per-session cached LAContext (macOS owns the timeout via reuse duration)
    private var contexts: [String: LAContext] = [:]
    private let queue = DispatchQueue(label: "dev.varlock.session")

    /// Called when the daemon should shut down due to inactivity
    var onDaemonTimeout: (() -> Void)?

    /// Whether something is still being held that must outlive an idle stretch.
    ///
    /// Identity unlock sessions live only in daemon memory, so quitting while one is
    /// open would silently throw away an unlock the user paid a fingerprint for. When
    /// this returns true the idle timer re-arms instead of firing.
    var hasLiveWork: (() -> Bool)?

    /// Called on an explicit lock, alongside dropping cached biometric contexts.
    /// An explicit lock always erases everything, whatever any lock policy says.
    var onSystemLock: (() -> Void)?

    /// Called on a system lock event (sleep, screen lock), which erases identity
    /// sessions selectively according to each session's own policy.
    var onLockEvent: ((SessionLockEvent) -> Void)?

    /// How to get the user's approval before a device-key read.
    ///
    /// Injected, and set by the daemon to the approval panel. Without it this
    /// path evaluated a policy directly, which on macOS means the system's own
    /// sheet appearing with nothing behind it: no statement of who was asking or
    /// what they wanted, and after a lock it looked like the machine demanding a
    /// fingerprint out of nowhere. Every presence check now happens with our
    /// panel already on screen; the only exception is the one-time setup step,
    /// which says what it is.
    var authorize: ((_ reason: String, _ peerPid: pid_t?) throws -> LAContext)?

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
    /// Processes with no identifiable session always require fresh authentication.
    func getAuthenticatedContext(sessionId: String?, peerPid: pid_t? = nil) throws -> LAContext {
        return try queue.sync {
            // Check for cached context from a previous auth in this session
            if let key = sessionId, let context = contexts[key] {
                resetDaemonTimer()
                return context
            }

            // Need fresh auth (first time for this session, or always for
            // unidentifiable callers). Through the panel where one is wired up,
            // so the user is asked rather than merely prompted.
            if let authorize {
                let approved = try authorize("decrypt your secrets", peerPid)
                if let key = sessionId { contexts[key] = approved }
                resetDaemonTimer()
                return approved
            }

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

            let waitResult = semaphore.wait(timeout: .now() + SessionManager.biometricTimeoutSeconds)
            if waitResult == .timedOut {
                context.invalidate()
                throw EnclaveError.biometricFailed("Biometric prompt timed out after \(Int(SessionManager.biometricTimeoutSeconds))s")
            }

            if let error = evalError {
                throw EnclaveError.biometricFailed(error.localizedDescription)
            }

            // Only cache if the process has a session identity to scope to.
            // Unidentifiable callers get a fresh context every time.
            if let key = sessionId {
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

    /// An explicit lock (menu bar, `varlock lock`): drop cached biometric contexts,
    /// and erase every identity session regardless of its lock policy.
    func handleSystemLock() {
        invalidateAllSessions()
        onSystemLock?()
    }

    /// A system lock event. Cached biometric contexts always go, as they always
    /// have. Identity sessions are judged one at a time against their own policy,
    /// so a session set to survive screen lock does.
    ///
    /// The notification observers do nothing but call this, so the policy behavior
    /// is testable without real sleep events.
    func handleLockEvent(_ event: SessionLockEvent) {
        invalidateAllSessions()
        onLockEvent?(event)
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
    func isSessionWarm(sessionId: String?) -> Bool {
        guard let key = sessionId else { return false }
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
            guard let self else { return }
            // An open unlock session outranks idleness: re-arm rather than quit.
            if self.hasLiveWork?() == true {
                self.resetDaemonTimer()
                return
            }
            self.onDaemonTimeout?()
        }
        timer.resume()
        daemonTimer = timer
    }

    // MARK: - System Notifications

    private func setupSystemNotifications() {
        let workspace = NSWorkspace.shared
        let notificationCenter = workspace.notificationCenter

        // The machine going to sleep is the one event treated as "sleep". Display
        // sleep and fast user switching are screen-lock events: a display that
        // sleeps after a couple of idle minutes must not read as the lid closing.
        notificationCenter.addObserver(
            forName: NSWorkspace.willSleepNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleLockEvent(.sleep)
        }

        notificationCenter.addObserver(
            forName: NSWorkspace.sessionDidResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleLockEvent(.screenLock)
        }

        notificationCenter.addObserver(
            forName: NSWorkspace.screensDidSleepNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleLockEvent(.screenLock)
        }

        // Also fire when screens lock (available on macOS 13+)
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("com.apple.screenIsLocked"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleLockEvent(.screenLock)
        }
    }
}
