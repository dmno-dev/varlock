import Foundation
import Darwin

// csops is a real syscall wrapper in libsystem_kernel but has no Swift header,
// same situation as proc_pidpath above.
@_silgen_name("csops")
private func csops(
    _ pid: pid_t,
    _ ops: UInt32,
    _ useraddr: UnsafeMutableRawPointer?,
    _ usersize: Int
) -> Int32

/// `CS_OPS_STATUS`: read a process's code-signing status word.
private let csOpsStatus: UInt32 = 0

// Code-signing status bits, from <sys/codesign.h>. Not exported to Swift.
private let csValid: UInt32 = 0x0000_0001
private let csRuntime: UInt32 = 0x0001_0000
private let csDebugged: UInt32 = 0x1000_0000

/// `P_TRACED`, from <sys/proc.h>: something has this process under ptrace.
private let pTraced: Int32 = 0x0000_0800

/// What the kernel will say about a process's own hardening.
///
/// Read off the pid rather than taken from anything the peer sent. Two questions
/// matter here:
///
///   - is somebody inside it right now (a debugger attached, a tracer running)?
///     A process under ptrace has no secrets from whoever is tracing it, so
///     handing plaintext to one hands it to the tracer too.
///   - was it built so somebody could not simply walk in? Hardened Runtime is
///     what refuses `task_for_pid`, library injection, and unsigned code at
///     load time. Without it, "the peer is not being debugged right now" is a
///     statement about this instant only.
public struct PeerPostureFacts: Equatable {
    /// A debugger or tracer is attached.
    public let isTraced: Bool
    /// The process is running with Hardened Runtime.
    public let hasHardenedRuntime: Bool
    /// The kernel has a valid code signature for it.
    public let signatureValid: Bool
    /// Whether the status word could be read at all. False means the answers
    /// above are guesses, not facts, and the caller has to decide what to do
    /// about not knowing.
    public let isReadable: Bool

    public init(isTraced: Bool, hasHardenedRuntime: Bool, signatureValid: Bool, isReadable: Bool) {
        self.isTraced = isTraced
        self.hasHardenedRuntime = hasHardenedRuntime
        self.signatureValid = signatureValid
        self.isReadable = isReadable
    }

    /// Everything unknown. What an unreadable process looks like.
    public static let unreadable = PeerPostureFacts(
        isTraced: false,
        hasHardenedRuntime: false,
        signatureValid: false,
        isReadable: false
    )
}

/// Reads posture facts from the live kernel.
public struct PeerPostureReader {
    public init() {}

    public func facts(forPid pid: pid_t) -> PeerPostureFacts {
        var status: UInt32 = 0
        let result = withUnsafeMutablePointer(to: &status) { pointer -> Int32 in
            return csops(pid, csOpsStatus, UnsafeMutableRawPointer(pointer), MemoryLayout<UInt32>.size)
        }
        guard result == 0 else { return .unreadable }

        // Asked twice on purpose. `CS_DEBUGGED` is the kernel's own view of the
        // process having been opened up; `P_TRACED` catches a tracer that attached
        // without that bit being set, which is the case on an unsigned process.
        let traced = (status & csDebugged) != 0 || isTracedBySysctl(pid: pid)

        return PeerPostureFacts(
            isTraced: traced,
            hasHardenedRuntime: (status & csRuntime) != 0,
            signatureValid: (status & csValid) != 0,
            isReadable: true
        )
    }

    /// The daemon's view of itself, which is how it decides how much to demand of
    /// anyone else.
    public func selfFacts() -> PeerPostureFacts {
        return facts(forPid: getpid())
    }

    private func isTracedBySysctl(pid: pid_t) -> Bool {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.size
        guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0 else { return false }
        return (info.kp_proc.p_flag & pTraced) != 0
    }
}
