//! ISO 8601 formatting, without pulling in a date crate.
//!
//! Two formats are produced here. Key metadata uses whole seconds, which is what
//! the key files have always carried. The authorization log uses milliseconds,
//! because that is what `ISO8601DateFormatter` with `.withFractionalSeconds`
//! writes on the Swift side, and the two daemons' logs have to be uniform enough
//! to concatenate and sort.

use std::time::{SystemTime, UNIX_EPOCH};

/// `2026-08-30T12:34:56Z`
pub fn now_iso8601_seconds() -> String {
    format_iso8601(epoch_ms_now(), false)
}

/// `2026-08-30T12:34:56.789Z`
pub fn now_iso8601_millis() -> String {
    format_iso8601(epoch_ms_now(), true)
}

fn epoch_ms_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Format epoch milliseconds as UTC ISO 8601.
///
/// UTC only, and proleptic-Gregorian, so no leap seconds and no zone database.
/// Timestamps before the epoch are clamped rather than formatted as negative
/// years: nothing here can legitimately produce one.
pub fn format_iso8601(epoch_ms: i64, with_millis: bool) -> String {
    let epoch_ms = epoch_ms.max(0);
    let total_secs = epoch_ms / 1000;
    let millis = epoch_ms % 1000;

    let days = total_secs / 86_400;
    let time_of_day = total_secs % 86_400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    let (year, month, day) = civil_from_days(days);

    if with_millis {
        format!(
            "{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z"
        )
    } else {
        format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
    }
}

/// Days since the epoch to a calendar date.
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, i64) {
    let mut year = 1970i64;
    let mut remaining = days_since_epoch;
    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }

    let days_in_months: [i64; 12] = if is_leap_year(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month = 1u32;
    for days_in_month in days_in_months {
        if remaining < days_in_month {
            break;
        }
        remaining -= days_in_month;
        month += 1;
    }

    (year, month, remaining + 1)
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_the_epoch() {
        assert_eq!(format_iso8601(0, false), "1970-01-01T00:00:00Z");
        assert_eq!(format_iso8601(0, true), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn formats_a_known_instant() {
        // 2026-08-30T12:34:56.789Z
        assert_eq!(format_iso8601(1_788_093_296_789, true), "2026-08-30T12:34:56.789Z");
        assert_eq!(format_iso8601(1_788_093_296_789, false), "2026-08-30T12:34:56Z");
    }

    #[test]
    fn handles_a_leap_day() {
        // 2024-02-29T00:00:00Z
        assert_eq!(format_iso8601(1_709_164_800_000, false), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn handles_the_last_day_of_a_year() {
        // 2023-12-31T23:59:59.999Z
        assert_eq!(format_iso8601(1_704_067_199_999, true), "2023-12-31T23:59:59.999Z");
    }

    #[test]
    fn sorts_lexicographically_in_the_order_time_runs() {
        let earlier = format_iso8601(1_788_093_296_000, true);
        let later = format_iso8601(1_788_093_296_001, true);
        assert!(earlier < later);
    }

    #[test]
    fn now_is_after_2024() {
        assert!(now_iso8601_millis().starts_with("20"));
        assert!(now_iso8601_millis().as_str() > "2024-01-01T00:00:00.000Z");
        assert!(now_iso8601_seconds().ends_with('Z'));
    }
}
