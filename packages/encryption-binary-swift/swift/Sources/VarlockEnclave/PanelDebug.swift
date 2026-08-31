import Foundation
import AppKit

/// Timestamped lifecycle logging for the approval panel, and the scheduling
/// primitive it depends on.
///
/// The panel runs in a place with an awkward shape: the IPC handler is on a
/// background queue, so it reaches the main thread with `DispatchQueue.main.sync`,
/// and the panel then spins a nested modal run loop inside that work item. Work
/// posted with `DispatchQueue.main.async` from there never runs, because the main
/// queue is serial and its current item has not returned. The nested loop keeps
/// drawing, so the panel looks fine while everything scheduled behind it starves.
///
/// That is not theoretical: it is what stopped the Touch ID evaluation from ever
/// being armed in the daemon, while the same code worked in the probe, which owns
/// its run loop through `NSApplication.run()` and so has no outer work item.
enum PanelDebug {
    /// Streams the panel's lifecycle to the daemon's stderr.
    static let envVar = "_VARLOCK_PANEL_DEBUG"

    static var isEnabled: Bool {
        let value = ProcessInfo.processInfo.environment[envVar]
        return value == "1" || value == "true"
    }

    private static let start = Date()

    static func note(_ event: String, _ detail: [String: Any] = [:]) {
        guard isEnabled else { return }
        let atMs = Int(Date().timeIntervalSince(start) * 1000)
        let rendered = detail.isEmpty
            ? ""
            : " " + detail.keys.sorted().map { "\($0)=\(detail[$0] ?? "")" }.joined(separator: " ")
        let thread = Thread.isMainThread ? "main" : "background"
        FileHandle.standardError.write(Data("varlock-panel [\(atMs)ms] \(event) thread=\(thread)\(rendered)\n".utf8))
    }
}

/// Scheduling that survives a nested modal loop.
///
/// `RunLoop.perform` posts a run-loop source rather than a main-queue work item,
/// so it is not held behind whatever item is currently occupying the main queue.
/// The modal panel mode is named explicitly alongside the common modes, so a block
/// posted while an `NSAlert` is up still runs. This is the same mechanism
/// `SecureInputDialog` already relies on to focus its text field.
enum MainLoop {
    private static let modes: [RunLoop.Mode] = [.common, .modalPanel, .default]

    /// Run `block` on the main thread, even from inside a nested modal loop.
    static func perform(_ block: @escaping () -> Void) {
        RunLoop.main.perform(inModes: modes, block: block)
        // A loop parked waiting for input has to be told there is new work.
        CFRunLoopWakeUp(CFRunLoopGetMain())
    }

    /// Run `block` on the main thread after `delay` seconds, with the same
    /// guarantee. Returns a handle that cancels it.
    static func after(_ delay: TimeInterval, _ block: @escaping () -> Void) -> Cancellable {
        let timer = Timer(timeInterval: delay, repeats: false) { _ in block() }
        for mode in modes { RunLoop.main.add(timer, forMode: mode) }
        CFRunLoopWakeUp(CFRunLoopGetMain())
        return Cancellable(timer: timer)
    }

    /// Repeat `block` on the main thread every `interval` seconds.
    static func every(_ interval: TimeInterval, _ block: @escaping () -> Void) -> Cancellable {
        let timer = Timer(timeInterval: interval, repeats: true) { _ in block() }
        for mode in modes { RunLoop.main.add(timer, forMode: mode) }
        CFRunLoopWakeUp(CFRunLoopGetMain())
        return Cancellable(timer: timer)
    }

    struct Cancellable {
        let timer: Timer
        func cancel() { timer.invalidate() }
    }
}
