import Foundation

/// The clock a grant's lifetime is actually measured against.
///
/// `CLOCK_MONOTONIC_RAW` counts from an arbitrary point, is unaffected by NTP
/// steps and by anyone setting the system clock, and keeps counting while the
/// machine is asleep. That last part matters here: a clock that paused during
/// sleep (`CLOCK_UPTIME_RAW`) would let a suspended laptop hold a grant well past
/// its real 12h, which is the opposite of what the cap is for.
public enum MonotonicClock {
    public static func nowMs() -> Int64 {
        return Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) / 1_000_000)
    }
}

/// When a grant runs out, measured on both clocks at once.
///
/// Wall-clock time is what a person reads ("expires at 4pm"), so it has to be
/// recorded. It is also settable: anything that trusted it alone could be given
/// more life by moving the system clock backwards. So every deadline carries a
/// monotonic twin taken at the same instant, and whichever one runs out first
/// ends the grant. Under a normal clock the two are indistinguishable.
public struct GrantDeadline: Equatable {
    /// epoch ms
    public let wall: Int64
    /// `MonotonicClock` ms
    public let monotonic: Int64

    public init(wall: Int64, monotonic: Int64) {
        self.wall = wall
        self.monotonic = monotonic
    }

    /// A deadline `durationMs` out from the two clock readings given.
    public static func after(_ durationMs: Int64, wallNow: Int64, monotonicNow: Int64) -> GrantDeadline {
        return GrantDeadline(wall: wallNow + durationMs, monotonic: monotonicNow + durationMs)
    }

    public func isExpired(wallNow: Int64, monotonicNow: Int64) -> Bool {
        return wall <= wallNow || monotonic <= monotonicNow
    }

    /// Time left, on whichever clock has less of it. Never negative.
    ///
    /// The monotonic side is the one that governs in practice; the wall side only
    /// becomes the smaller of the two after the system clock jumps forward, and in
    /// that case the grant really does have less time than the monotonic clock
    /// thinks, so reporting the smaller number keeps the answer honest.
    public func remainingMs(wallNow: Int64, monotonicNow: Int64) -> Int64 {
        return max(0, min(wall - wallNow, monotonic - monotonicNow))
    }

    /// The earlier of two deadlines, taken per clock.
    ///
    /// Element-wise rather than picking one whole deadline: clamping a grant to
    /// its session cap has to clamp both halves, or a caller could ask for a long
    /// window and keep the session's later monotonic deadline.
    public static func earliest(_ lhs: GrantDeadline, _ rhs: GrantDeadline) -> GrantDeadline {
        return GrantDeadline(
            wall: Swift.min(lhs.wall, rhs.wall),
            monotonic: Swift.min(lhs.monotonic, rhs.monotonic)
        )
    }
}
