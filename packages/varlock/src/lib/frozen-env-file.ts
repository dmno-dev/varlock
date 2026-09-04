import fs from 'node:fs';
import path from 'node:path';
import { isEncryptedBlob, decryptEnvBlobSync } from '../runtime/crypto';

/**
 * A "frozen env" file is a deploy-time pin: `varlock freeze` resolves every value once,
 * encrypts the serialized graph, and writes it to a file that ships INSIDE the deploy unit
 * (image layer, deployment bundle). At boot the app consumes that file instead of
 * re-resolving.
 *
 * The motivation is atomicity, not convenience. Setting env vars on a platform and shipping
 * code are two separate operations, so config and code can never be updated as one unit, and
 * rolling back code does not roll back config. An artifact that travels with the release
 * makes them a single versioned thing. Secondary benefits: boot stops depending on the
 * availability (and latency, and rate limits) of 1Password/Vault/etc, and every replica in a
 * deploy is guaranteed to see identical values.
 *
 * The tradeoff is the whole point, and needs to be understood before using this: rotating a
 * secret no longer takes effect on restart. It takes effect on the next deploy.
 */

/** Default filename, resolved relative to cwd (the app dir at boot, per-package in a monorepo). */
export const FROZEN_ENV_FILE_NAME = '.varlock-frozen-env';

/** user-controllable behavior flag (leading single underscore per convention) */
export const USE_FROZEN_ENV_VAR = '_VARLOCK_USE_FROZEN_ENV';

type EnvRecord = Record<string, string | undefined>;

/** Thrown when a frozen env file is in play but cannot be used. Never falls back to fresh resolution. */
export class FrozenEnvFileError extends Error {
  constructor(message: string) {
    super(`[varlock] ${message}`);
    this.name = 'FrozenEnvFileError';
  }
}

/** `off` never reads a file; `auto` uses one only if present; `required` errors when it is missing */
export type FrozenEnvFileMode = | { mode: 'off' }
  /** use the file at this path if it exists; absence falls through to normal resolution */
  | { mode: 'auto', filePath: string }
  /** the file at this path MUST exist and be usable */
  | { mode: 'required', filePath: string };

/**
 * Interpret `_VARLOCK_USE_FROZEN_ENV`:
 *  - unset      -> auto, at the default path
 *  - `1`/`true` -> required, at the default path (assert the pin is actually in effect)
 *  - `0`/`false`-> off
 *  - anything else -> required, treating the value as a path
 *
 * Note this deliberately differs from `getUseInjectedEnvMode`, which maps unrecognized
 * values back to `auto` so that `=no`/`=off` can never silently grant blob trust. Here an
 * unrecognized value is a path, so `=off` resolves to a file named `off` and hard-errors as
 * missing. That keeps the same property (a typo is never silently permissive) while letting
 * one variable carry both the toggle and the location.
 */
export function resolveFrozenEnvFileMode(env: EnvRecord, cwd: string): FrozenEnvFileMode {
  const rawValue = env[USE_FROZEN_ENV_VAR];
  const defaultPath = path.resolve(cwd, FROZEN_ENV_FILE_NAME);

  if (rawValue === undefined || rawValue.trim() === '') {
    return { mode: 'auto', filePath: defaultPath };
  }
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return { mode: 'required', filePath: defaultPath };
  if (normalized === '0' || normalized === 'false') return { mode: 'off' };

  return { mode: 'required', filePath: path.resolve(cwd, rawValue.trim()) };
}

/**
 * Whether a frozen env file will be consumed on this invocation - i.e. it is required, or it
 * is present at the auto-discovered path. Callers use this to reject flags that would change
 * what gets loaded (rather than silently ignoring the pin).
 */
export function getFrozenEnvFileInPlay(env: EnvRecord, cwd: string): string | undefined {
  const resolved = resolveFrozenEnvFileMode(env, cwd);
  if (resolved.mode === 'off') return undefined;
  if (resolved.mode === 'required') return resolved.filePath;
  return fs.existsSync(resolved.filePath) ? resolved.filePath : undefined;
}

export type FrozenEnvFileResult = | { found: false, reason: string }
  | { found: true, filePath: string, blobJson: string };

/**
 * Read + decrypt the frozen env file, if one applies.
 *
 * Only ABSENCE in auto mode falls through to normal resolution. A file that is present but
 * unusable (unreadable, encrypted with no key available, wrong key, etc) always throws.
 * Falling back there would silently un-pin the deploy and re-resolve at boot, which is
 * exactly the behavior freezing exists to eliminate, and it would do it invisibly.
 */
export function readFrozenEnvFile(opts: { env: EnvRecord, cwd?: string }): FrozenEnvFileResult {
  const { env } = opts;
  const cwd = opts.cwd ?? process.cwd();

  const resolved = resolveFrozenEnvFileMode(env, cwd);
  if (resolved.mode === 'off') {
    return { found: false, reason: `${USE_FROZEN_ENV_VAR} disabled frozen env files` };
  }
  const { filePath, mode } = resolved;

  if (!fs.existsSync(filePath)) {
    if (mode === 'required') {
      throw new FrozenEnvFileError(
        `${USE_FROZEN_ENV_VAR} requires a frozen env file at ${filePath}, but none is present`,
      );
    }
    return { found: false, reason: `no frozen env file at ${filePath}` };
  }

  // A frozen file is a complete, already-validated snapshot of the graph, so honoring
  // _VARLOCK_FILTER would hand over values the caller expected to exclude (same reasoning as
  // the blob path). `varlock freeze` deliberately has no --filter: a partial seal would mean
  // keys outside the scope are neither sealed nor validated, which is the split-validation
  // state the whole feature exists to prevent. So the remedy is to drop one or the other,
  // never to re-freeze with a matching filter.
  if (env._VARLOCK_FILTER) {
    throw new FrozenEnvFileError(
      `a frozen env file (${filePath}) cannot be combined with _VARLOCK_FILTER`
      + ' - unset _VARLOCK_FILTER to use the frozen env, or set _VARLOCK_USE_FROZEN_ENV=0 to resolve from .env files instead',
    );
  }

  let rawContents: string;
  try {
    rawContents = fs.readFileSync(filePath, 'utf8').trim();
  } catch (err) {
    throw new FrozenEnvFileError(`failed to read frozen env file ${filePath}: ${(err as Error).message}`);
  }
  if (!rawContents) {
    throw new FrozenEnvFileError(`frozen env file ${filePath} is empty`);
  }

  if (!isEncryptedBlob(rawContents)) {
    // plaintext is only produced by `varlock freeze --allow-plaintext`, which warns loudly
    // at write time - no need to re-warn on every boot
    return { found: true, filePath, blobJson: rawContents };
  }

  const key = env._VARLOCK_ENV_KEY;
  if (!key) {
    throw new FrozenEnvFileError(
      `frozen env file ${filePath} is encrypted but _VARLOCK_ENV_KEY is not set in the environment`,
    );
  }
  try {
    return { found: true, filePath, blobJson: decryptEnvBlobSync(rawContents, key) };
  } catch (err) {
    throw new FrozenEnvFileError(
      `failed to decrypt frozen env file ${filePath}: ${(err as Error).message.replace(/^\[varlock\] /, '')}`,
    );
  }
}
