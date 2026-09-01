/**
 * Shared rules about sensitive values themselves, independent of where they are
 * used (log redaction, proxy response scrubbing).
 */

/**
 * Below this length, a sensitive value is likely to also occur as ordinary text
 * (an org slug, a short account id, `dev`, a weak dev password).
 *
 * Redaction is substring replacement with no token boundary: it cannot tell a
 * leaked secret from prose that happens to match, so a short value gets rewritten
 * everywhere it appears, corrupting console output and proxied response bodies. A
 * string that common is not meaningfully protected by redacting it either, so
 * varlock warns rather than silently mangling output. `@sensitive=false` is the
 * fix when the value is not really a secret; some secrets are short by nature (an
 * OTP, a PIN) and the warning is only a heads-up about the collision risk.
 */
export const SHORT_SENSITIVE_VALUE_LENGTH = 12;

/** Whether a resolved value is short enough to collide with ordinary content. */
export function isShortSensitiveValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const str = typeof value === 'string' ? value : String(value);
  return str.length > 0 && str.length < SHORT_SENSITIVE_VALUE_LENGTH;
}
