/**
 * Shared rules about sensitive values themselves, independent of where they are
 * used (log redaction, proxy response scrubbing).
 */

import { redactString } from '../runtime/lib/redaction';

/**
 * Below this length a sensitive value cannot be redacted safely at all: a one or two
 * character string occurs constantly in ordinary text, so registering it for redaction
 * shreds every log line and proxied response body it touches. `allowShortValue` does not
 * opt out of this - it acknowledges a collision risk, and at this length it is a certainty.
 * An error for an explicit `@sensitive`, a warning when `@defaultSensitive` swept it in.
 */
export const MIN_SENSITIVE_VALUE_LENGTH = 3;

/**
 * Below this length a sensitive value is likely to also occur as ordinary text (an org
 * slug, a short account id, `dev`). Redaction is substring replacement with no token
 * boundary, so it rewrites the value everywhere it appears - and a string that common is
 * not meaningfully protected by redacting it either. A warning rather than an error,
 * since plenty of real secrets are short by nature (an OTP, a PIN).
 */
export const SHORT_SENSITIVE_VALUE_LENGTH = 12;

/**
 * A value's leaves, split by whether runtime redaction can match them.
 *
 * A composite is not one value: the redaction map registers each element of an array or
 * object individually, and only strings (`collectSensitiveStrings` in `runtime/env.ts`).
 * So `["averylongsecret", 1]` registers one long key and leaves the `1` untouched, which
 * is what both the length rules and the collision check need to know.
 */
export function collectLeaves(value: unknown): { redactable: Array<string>, unredactable: Array<string> } {
  const redactable: Array<string> = [];
  const unredactable: Array<string> = [];
  const walk = (val: unknown) => {
    if (Array.isArray(val)) {
      val.forEach(walk);
    } else if (val && typeof val === 'object') {
      Object.values(val).forEach(walk);
    } else if (typeof val === 'string') {
      if (val) redactable.push(val);
    } else if (val !== undefined && val !== null) {
      unredactable.push(String(val));
    }
  };
  walk(value);
  return { redactable, unredactable };
}

/**
 * Redacted display form of a sensitive value, whatever its type.
 *
 * `redactString` only handles strings, so callers that guarded on `isString` silently
 * rendered non-string sensitive values in cleartext - an item like `PIN=987654` coerces
 * to a number, and printed raw.
 */
export function redactSensitiveDisplayValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return redactString(typeof value === 'string' ? value : String(value));
}
