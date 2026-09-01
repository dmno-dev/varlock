/**
 * Shared rules about sensitive values themselves, independent of where they are
 * used (log redaction, proxy response scrubbing).
 */

import { redactString } from '../runtime/lib/redaction';

/**
 * Below this length, a sensitive value cannot be redacted safely at all: a one to
 * three character string occurs constantly in ordinary text, so registering it for
 * redaction shreds every log line and proxied response body it touches. Nothing is
 * meaningfully protected either - a value that short is guessable. This is an error
 * rather than a warning, since there is no output in which the redaction is harmless.
 */
export const MIN_SENSITIVE_VALUE_LENGTH = 4;

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

/**
 * Every distinct string a sensitive value contributes, which is what any
 * length/collision rule has to measure.
 *
 * Composite values are *not* one string: the runtime redaction map registers each
 * element of an array/object individually (see `collectSensitiveStrings` in
 * `runtime/env.ts`), so `["averylongsecret", "x"]` puts `"x"` in the map even though
 * the joined form is long. Measuring `String(value)` would miss that entirely, and
 * for a plain object would only ever see `"[object Object]"`.
 */
export function sensitiveValueStrings(value: unknown, collected: Array<string> = []): Array<string> {
  if (Array.isArray(value)) {
    for (const el of value) sensitiveValueStrings(el, collected);
  } else if (value && typeof value === 'object') {
    for (const key in value) sensitiveValueStrings((value as any)[key], collected);
  } else if (value !== undefined && value !== null && value !== '') {
    // scalars are measured by their string form - an item like `PIN=987654` coerces to
    // a number, but what reaches logs (and what redaction has to match) is `"987654"`
    collected.push(String(value));
  }
  return collected;
}

/**
 * Length of the shortest string this value contributes, or undefined if it
 * contributes none (empty/unset). The shortest is what matters: it is the piece most
 * likely to collide with ordinary text.
 */
export function shortestSensitiveValueLength(value: unknown): number | undefined {
  const lengths = sensitiveValueStrings(value).map((s) => s.length);
  return lengths.length ? Math.min(...lengths) : undefined;
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
