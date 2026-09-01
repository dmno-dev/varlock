/**
 * Shared rules about sensitive values themselves, independent of where they are
 * used (log redaction, proxy response scrubbing).
 */

import { redactString } from '../runtime/lib/redaction';

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


/**
 * Redacted display form of a sensitive value, whatever its type.
 *
 * `redactString` only handles strings, so callers that guarded on `isString`
 * silently rendered non-string sensitive values in cleartext - an item like
 * `PIN=987654` coerces to a number, and printed raw. Coercing here means the
 * masking follows the item's sensitivity rather than its inferred type.
 */
export function redactSensitiveDisplayValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return redactString(typeof value === 'string' ? value : String(value));
}
