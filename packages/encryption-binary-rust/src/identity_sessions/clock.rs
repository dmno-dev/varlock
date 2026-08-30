//! The two clocks a grant's lifetime is measured against.
//!
//! Wall-clock time is what a person reads ("expires at 4pm"), so it has to be
//! recorded. It is also settable: anything that trusted it alone could be given
//! more life by moving the system clock backwards. So every deadline carries a
//! monotonic twin taken at the same instant.
//!
//! The monotonic side must keep counting while the machine is asleep, or a
//! suspended laptop could hold a grant well past its real 12h, which is the
//! opposite of what the cap is for. `std::time::Instant` is not good enough on
//! its own for that: on Linux it reads `CLOCK_MONOTONIC`, which stops during
//! suspend. Each platform therefore gets the sleep-inclusive counter it has,
//! matching what the Swift daemon reads (`CLOCK_MONOTONIC_RAW` on Darwin).

use std::time::{SystemTime, UNIX_EPOCH};

/// Epoch milliseconds. Settable, and only ever half of a deadline.
pub fn wall_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Milliseconds on a counter that no one can set, and that sleep does not pause.
///
/// The origin is arbitrary and differs per platform: only differences between
/// two readings mean anything.
pub fn monotonic_now_ms() -> i64 {
    platform_monotonic_ms()
}

/// Linux: `CLOCK_BOOTTIME` rather than `CLOCK_MONOTONIC`, because only the
/// former keeps counting across suspend.
#[cfg(target_os = "linux")]
fn platform_monotonic_ms() -> i64 {
    clock_gettime_ms(libc::CLOCK_BOOTTIME)
}

/// macOS (development and the shared unit tests): the same clock the Swift
/// daemon uses, so the two implementations measure lifetimes identically.
#[cfg(target_os = "macos")]
fn platform_monotonic_ms() -> i64 {
    clock_gettime_ms(libc::CLOCK_MONOTONIC_RAW)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn clock_gettime_ms(clock_id: libc::clockid_t) -> i64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // Safety: `ts` is a valid, correctly sized output parameter.
    let rc = unsafe { libc::clock_gettime(clock_id, &mut ts) };
    if rc != 0 {
        // A failing clock_gettime would be extraordinary. Falling back to the
        // process-start baseline keeps deadlines monotonic rather than letting
        // a zero reading make every grant look brand new.
        return fallback_monotonic_ms();
    }
    // The widths of tv_sec and tv_nsec vary by platform and libc, so the casts
    // are load-bearing on some targets and redundant on others.
    #[allow(clippy::unnecessary_cast)]
    let millis = (ts.tv_sec as i64) * 1000 + (ts.tv_nsec as i64) / 1_000_000;
    millis
}

/// Windows: `QueryInterruptTime` is the biased interrupt-time count, meaning it
/// includes time the machine spent asleep. `GetTickCount64` and
/// `QueryUnbiasedInterruptTime` both exclude it, so neither can be used here.
#[cfg(target_os = "windows")]
fn platform_monotonic_ms() -> i64 {
    use windows::Win32::System::WindowsProgramming::QueryInterruptTime;
    // Safety: takes no arguments and reads a kernel-maintained counter.
    let interrupt_time = unsafe { QueryInterruptTime() };
    if interrupt_time == 0 {
        return fallback_monotonic_ms();
    }
    // 100-nanosecond units
    (interrupt_time / 10_000) as i64
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn platform_monotonic_ms() -> i64 {
    fallback_monotonic_ms()
}

/// Milliseconds since the first call, via `Instant`. Only a fallback: on some
/// platforms `Instant` pauses during suspend, which is exactly what the
/// platform-specific readings above avoid.
fn fallback_monotonic_ms() -> i64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static BASE: OnceLock<Instant> = OnceLock::new();
    let base = BASE.get_or_init(Instant::now);
    base.elapsed().as_millis() as i64
}

/// The pair of clock readings a deadline is built from or checked against.
///
/// Taken together so both halves describe the same instant. Injected as a
/// closure by the grant table, which is how the tests drive the two clocks
/// independently: moving only the wall clock is the one way to prove that
/// resetting the system clock cannot buy a grant more life.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockReading {
    pub wall: i64,
    pub monotonic: i64,
}

impl ClockReading {
    pub fn now() -> Self {
        Self { wall: wall_now_ms(), monotonic: monotonic_now_ms() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_clock_is_a_plausible_epoch_ms() {
        // Later than 2020-01-01, which is enough to catch a unit mix-up
        // (seconds vs milliseconds) without pinning the test to a date.
        assert!(wall_now_ms() > 1_577_836_800_000);
    }

    #[test]
    fn monotonic_clock_does_not_go_backwards() {
        let first = monotonic_now_ms();
        let second = monotonic_now_ms();
        assert!(second >= first, "{second} < {first}");
    }

    #[test]
    fn monotonic_clock_advances_over_a_real_sleep() {
        let before = monotonic_now_ms();
        std::thread::sleep(std::time::Duration::from_millis(25));
        let after = monotonic_now_ms();
        assert!(after - before >= 10, "advanced only {}ms", after - before);
    }
}
