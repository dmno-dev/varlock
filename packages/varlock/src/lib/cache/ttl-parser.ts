import { parseDuration } from '../duration';

/** Sentinel value for "cache forever" (until manually cleared) */
export const TTL_FOREVER = Infinity;

/**
 * Parse a cache-TTL string or number into milliseconds.
 *
 * Wraps {@link parseDuration} with cache-specific semantics: `0` means
 * "forever" (until manually cleared), so it returns {@link TTL_FOREVER}.
 *
 * @example
 *   parseTtl("30s")  // 30_000
 *   parseTtl("1h")   // 3_600_000
 *   parseTtl(0)      // Infinity (TTL_FOREVER)
 */
export function parseTtl(ttl: string | number): number {
  const ms = parseDuration(ttl);
  if (ms === 0) return TTL_FOREVER;
  return ms;
}
