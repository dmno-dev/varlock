import { parseDuration } from '../duration';

/** Sentinel value for "cache forever" (until manually cleared) */
export const TTL_FOREVER = Infinity;

/**
 * Parse a cache-TTL string or number into milliseconds.
 *
 * Wraps {@link parseDuration} with cache-specific semantics: the keyword
 * `"forever"` means "cache until manually cleared" and returns
 * {@link TTL_FOREVER}. A TTL of `0` is rejected as ambiguous.
 *
 * @example
 *   parseTtl("30s")      // 30_000
 *   parseTtl("1h")       // 3_600_000
 *   parseTtl("forever")  // Infinity (TTL_FOREVER)
 */
export function parseTtl(ttl: string | number): number {
  if (typeof ttl === 'string' && ttl.trim().toLowerCase() === 'forever') {
    return TTL_FOREVER;
  }
  const ms = parseDuration(ttl);
  if (ms === 0) {
    throw new Error(
      'Cache TTL of 0 is ambiguous — use "forever" to cache until manually cleared, or false to disable caching',
    );
  }
  return ms;
}
