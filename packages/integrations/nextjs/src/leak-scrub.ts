import * as varlockEnv from 'varlock/env';

/**
 * Redaction for leak remediation (rewriting a built file after `scanForLeaks` caught a value).
 *
 * Unlike `redactSensitiveConfig`, `redactAllSensitiveValues` also redacts values marked
 * `@sensitive={redact=false}`, which only opt out of log redaction, not leak prevention.
 * `varlock` is a peer dependency, so fall back for older versions, whose
 * `redactSensitiveConfig` redacts every sensitive value anyway.
 */
export const scrubLeakedSecrets: (str: string) => string = (varlockEnv as any).redactAllSensitiveValues
  ?? varlockEnv.redactSensitiveConfig;
