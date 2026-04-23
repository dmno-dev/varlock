const TTL_UNITS: Record<string, number> = {
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

/** Sentinel value for "cache forever" (until manually cleared) */
export const TTL_FOREVER = Infinity;

/**
 * Parse a human-readable TTL string into milliseconds.
 *
 * Supported formats:
 * - `0` → forever (until manually cleared)
 * - `"30s"` → 30,000ms
 * - `"5m"` → 300,000ms
 * - `"1h"` → 3,600,000ms
 * - `"1d"` → 86,400,000ms
 * - `"1w"` → 604,800,000ms
 * - bare number → treated as milliseconds (0 = forever)
 */
export function parseTtl(ttl: string | number): number {
  if (typeof ttl === 'number') {
    if (ttl === 0) return TTL_FOREVER;
    if (ttl < 0 || !Number.isFinite(ttl)) {
      throw new Error(`Invalid TTL: ${ttl} — must be a positive number or 0 for forever`);
    }
    return ttl;
  }

  const trimmed = ttl.trim();
  if (!trimmed) throw new Error('TTL string cannot be empty');

  // try bare number (ms)
  const asNum = Number(trimmed);
  if (!Number.isNaN(asNum)) {
    if (asNum === 0) return TTL_FOREVER;
    if (asNum < 0) throw new Error(`Invalid TTL: "${ttl}" — must be positive or 0 for forever`);
    return asNum;
  }

  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/i);
  if (!match) {
    throw new Error(
      `Invalid TTL: "${ttl}" — expected a number with a unit suffix (e.g. "1h", "30m", "1hr", "2days")`,
    );
  }

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = TTL_UNITS[unit];

  if (!multiplier) {
    throw new Error(
      `Invalid TTL unit: "${match[2]}" — valid units: s, sec, m, min, h, hr, d, day, w, wk (and plurals)`,
    );
  }

  if (value <= 0) throw new Error(`Invalid TTL: "${ttl}" — must be positive`);

  return Math.round(value * multiplier);
}
