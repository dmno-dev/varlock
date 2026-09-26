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

/** Suggestion attached to every frozen env file failure, for callers that print one */
export const FROZEN_ENV_FILE_SUGGESTION = 'Re-create it with `varlock freeze`, '
  + 'make sure _VARLOCK_ENV_KEY matches the key it was frozen with, '
  + `or set ${USE_FROZEN_ENV_VAR}=0 to resolve from .env files instead.`;

/** Thrown when a frozen env file is in play but cannot be used. Never falls back to fresh resolution. */
export class FrozenEnvFileError extends Error {
  readonly suggestion = FROZEN_ENV_FILE_SUGGESTION;
  constructor(message: string) {
    super(`[varlock] ${message}`);
    this.name = 'FrozenEnvFileError';
  }
}

/**
 * Interpret `_VARLOCK_USE_FROZEN_ENV`:
 *  - unset         -> the default path, used if present
 *  - `1`/`true`    -> the default path, required (assert the pin is actually in effect)
 *  - `0`/`false`   -> off (undefined)
 *  - anything else -> that path, required
 *
 * Unlike `getUseInjectedEnvMode`, an unrecognized value is a path, so `=off` names a file
 * called `off` and hard-errors as missing. A typo is still never silently permissive.
 */
export function resolveFrozenEnvFileMode(
  env: EnvRecord,
  cwd: string,
): { filePath: string, required: boolean } | undefined {
  const rawValue = env[USE_FROZEN_ENV_VAR]?.trim();
  const defaultPath = path.resolve(cwd, FROZEN_ENV_FILE_NAME);
  if (!rawValue) return { filePath: defaultPath, required: false };
  const normalized = rawValue.toLowerCase();
  if (normalized === '0' || normalized === 'false') return undefined;
  if (normalized === '1' || normalized === 'true') return { filePath: defaultPath, required: true };
  return { filePath: path.resolve(cwd, rawValue), required: true };
}

/** `fs.statSync` without throwing on absence: undefined when nothing is at the path */
function statFrozenEnvPath(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new FrozenEnvFileError(`failed to read frozen env file ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * The frozen env file this invocation will consume, if any: a required one (present or
 * not), or one present at the auto-discovered path. Callers use this to reject flags that
 * would change what gets loaded, rather than silently ignoring the pin.
 */
export function getFrozenEnvFileInPlay(env: EnvRecord, cwd: string): string | undefined {
  const mode = resolveFrozenEnvFileMode(env, cwd);
  if (!mode) return undefined;
  if (mode.required || statFrozenEnvPath(mode.filePath)) return mode.filePath;
  return undefined;
}

/**
 * Read + decrypt the frozen env file, if one applies. Only ABSENCE of an auto-discovered
 * file returns undefined; any other problem (a required file missing, not a regular file,
 * unreadable, encrypted with no or the wrong key) throws. Falling back would silently
 * un-pin the deploy and re-resolve at boot, which is exactly what freezing exists to
 * eliminate.
 */
export function readFrozenEnvFile(opts: {
  env: EnvRecord,
  cwd?: string,
}): { filePath: string, blobJson: string } | undefined {
  const { env } = opts;
  const mode = resolveFrozenEnvFileMode(env, opts.cwd ?? process.cwd());
  if (!mode) return undefined;
  const { filePath } = mode;

  const stat = statFrozenEnvPath(filePath);
  if (!stat) {
    if (!mode.required) return undefined;
    throw new FrozenEnvFileError(`${USE_FROZEN_ENV_VAR} requires a frozen env file at ${filePath}, but none is present`);
  }
  // only a regular file is readable: `readFileSync` on a FIFO with no writer blocks forever
  if (!stat.isFile()) {
    throw new FrozenEnvFileError(`frozen env file ${filePath} is not a regular file`);
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
    return { filePath, blobJson: rawContents };
  }

  const key = env._VARLOCK_ENV_KEY;
  if (!key) {
    throw new FrozenEnvFileError(
      `frozen env file ${filePath} is encrypted but _VARLOCK_ENV_KEY is not set in the environment`,
    );
  }
  try {
    return { filePath, blobJson: decryptEnvBlobSync(rawContents, key) };
  } catch (err) {
    throw new FrozenEnvFileError(
      `failed to decrypt frozen env file ${filePath}: ${(err as Error).message.replace(/^\[varlock\] /, '')}`,
    );
  }
}
