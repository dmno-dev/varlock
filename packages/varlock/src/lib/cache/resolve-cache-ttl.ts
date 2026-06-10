import { parseTtl } from './ttl-parser';

/**
 * Resolve and validate a cacheTtl value from a plugin's init decorator.
 *
 * Returns the validated TTL (string or number) if valid, or undefined if
 * the resolver is not set or the resolved value is false/null/empty (disabled).
 *
 * Throws on invalid TTL format — the error will be caught by the decorator
 * execution handler and surfaced as a plugin-level error.
 */
export async function resolveCacheTtl(
  cacheTtlResolver: { resolve(): Promise<any> } | undefined,
): Promise<string | number | undefined> {
  if (!cacheTtlResolver) return undefined;

  const cacheTtl = await cacheTtlResolver.resolve();

  // false, null, undefined, or '' mean caching is disabled (e.g., conditional) — note 0 is NOT
  // treated as disable: it is rejected as ambiguous by parseTtl below
  if (cacheTtl === undefined || cacheTtl === null || cacheTtl === false || cacheTtl === '') {
    return undefined;
  }

  if (typeof cacheTtl !== 'string' && typeof cacheTtl !== 'number') {
    const err = new Error(`cacheTtl resolved to an invalid type (${typeof cacheTtl})`);
    (err as any).tip = 'cacheTtl should resolve to a duration string like "1h", "forever" (until manually cleared), or false to disable caching';
    throw err;
  }

  // validate the format — parseTtl throws on invalid input
  parseTtl(cacheTtl);

  return cacheTtl;
}
