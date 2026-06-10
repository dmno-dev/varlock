/**
 * Shared duration parsing and unit conversion.
 *
 * Powers both the `cacheTtl` plugin option (which always needs milliseconds)
 * and the `duration` data type (which lets users pick an output unit).
 *
 * The 1ms = 1 unit "base" lets the parser stay a pure number-in / number-out
 * function with no Duration object allocations.
 */

const MS_UNITS: Record<string, number> = {
  ms: 1,
  millis: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  wk: 604_800_000,
  wks: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

export type DurationUnit = 'ms' | 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks';

const UNIT_TO_MS: Record<DurationUnit, number> = {
  ms: 1,
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

/**
 * Parse a duration string or number into milliseconds.
 *
 * - `"30s"`, `"5m"`, `"1h"`, `"1d"`, `"1w"`, `"1500ms"` — with optional plurals/long forms
 * - Bare number → treated as milliseconds (e.g. `parseDuration(500) === 500`)
 * - Bare number strings must be plain decimals — hex/exponent/Infinity notation is rejected
 *
 * Throws on negative, non-finite, sub-millisecond, or unparseable input.
 * Zero is allowed; any other duration must round to at least 1ms.
 */
export function parseDuration(input: string | number): number {
  let ms: number;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`Invalid duration: ${input} — must be a non-negative finite number`);
    }
    ms = input;
  } else {
    const trimmed = input.trim();
    if (!trimmed) throw new Error('Duration string cannot be empty');

    // bare number (ms) — plain decimal only, so "1e3"/"0x10"/"Infinity" are rejected
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      ms = parseFloat(trimmed);
    } else {
      const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/i);
      if (!match) {
        throw new Error(
          `Invalid duration: "${input}" — expected a number with a unit suffix (e.g. "1h", "30m", "500ms", "2days")`,
        );
      }

      const value = parseFloat(match[1]);
      const unit = match[2].toLowerCase();
      const multiplier = MS_UNITS[unit];

      if (!multiplier) {
        throw new Error(
          `Invalid duration unit: "${match[2]}" — valid units: ms, s, m, h, d, w (and long forms / plurals)`,
        );
      }

      ms = value * multiplier;
    }
  }

  const rounded = Math.round(ms);
  if (ms > 0 && rounded === 0) {
    throw new Error(`Invalid duration: "${input}" — durations under 1ms are not supported`);
  }
  return rounded;
}

/** Convert milliseconds to another unit. Always returns a plain number. */
export function convertDurationFromMs(ms: number, unit: DurationUnit): number {
  return ms / UNIT_TO_MS[unit];
}
