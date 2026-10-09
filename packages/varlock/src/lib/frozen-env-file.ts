import fs from 'node:fs';
import path from 'node:path';
import { isEncryptedBlob, decryptEnvBlobSync } from '../runtime/crypto';

/**
 * A "frozen env" file is a deploy-time freeze: `varlock freeze` resolves every value once,
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
 *
 * A frozen env file is only ever used when asked for (`_VARLOCK_USE_FROZEN_ENV`, or the
 * `--frozen` flag that sets it). A file that merely exists is inert everywhere, so a leftover
 * from a local `varlock freeze` can never change what a dev server, `varlock run`, or
 * `varlock load` resolves.
 */

/** Default filename, resolved relative to cwd (the app dir at boot, per-package in a monorepo). */
export const FROZEN_ENV_FILE_NAME = '.varlock-frozen-env';

/** user-controllable behavior flag (leading single underscore per convention) */
export const USE_FROZEN_ENV_VAR = '_VARLOCK_USE_FROZEN_ENV';

type EnvRecord = Record<string, string | undefined>;

/**
 * The frozen env file `_VARLOCK_USE_FROZEN_ENV` asks for, if any:
 *  - unset, `0`, `false` -> none (undefined)
 *  - `1`/`true`          -> the default path
 *  - anything else       -> that path
 *
 * The file is required whenever this returns a path. Unlike `getUseInjectedEnvMode`, an
 * unrecognized value is a path, so `=off` names a file called `off` and hard-errors as missing.
 * A typo is still never silently permissive.
 */
export function getFrozenEnvFilePath(env: EnvRecord, cwd: string): string | undefined {
  const rawValue = env[USE_FROZEN_ENV_VAR]?.trim();
  if (!rawValue) return undefined;
  const normalized = rawValue.toLowerCase();
  if (normalized === '0' || normalized === 'false') return undefined;
  if (normalized === '1' || normalized === 'true') return path.resolve(cwd, FROZEN_ENV_FILE_NAME);
  return path.resolve(cwd, rawValue);
}

/**
 * A pre-resolved env (a frozen env file, or a `__VARLOCK_ENV` payload trusted via
 * `_VARLOCK_USE_INJECTED_ENV=1`) that was asked for but cannot be used. Never falls back to
 * fresh resolution. Carries a suggestion specific to what went wrong, so every consumer
 * (auto-load, `run`, `load`) shows the same remedy.
 */
export class PreResolvedEnvError extends Error {
  readonly suggestion: string;
  constructor(message: string, suggestion: string) {
    super(`[varlock] ${message}`);
    this.name = 'PreResolvedEnvError';
    this.suggestion = suggestion;
  }
}

const RECREATE_FROZEN_FILE = 'Re-create it with `varlock freeze`.';
const FROZEN_KEY_MISMATCH = '_VARLOCK_ENV_KEY must be the key it was frozen with.';

/** A frozen env file that was asked for but cannot be used */
export class FrozenEnvFileError extends PreResolvedEnvError {
  constructor(message: string, suggestion = RECREATE_FROZEN_FILE) {
    super(message, suggestion);
    this.name = 'FrozenEnvFileError';
  }
}

/**
 * Read + decrypt the frozen env file `_VARLOCK_USE_FROZEN_ENV` asks for, or undefined when it
 * asks for none. Any problem with the file (missing, not a regular file, unreadable, encrypted
 * with no or the wrong key) throws. Falling back would silently unfreeze the deploy and
 * re-resolve at boot, which is exactly what freezing exists to eliminate.
 */
export function readFrozenEnvFile(opts: {
  env: EnvRecord,
  cwd?: string,
}): { filePath: string, blobJson: string } | undefined {
  const { env } = opts;
  const filePath = getFrozenEnvFilePath(env, opts.cwd ?? process.cwd());
  if (!filePath) return undefined;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new FrozenEnvFileError(
        `${USE_FROZEN_ENV_VAR} requires a frozen env file at ${filePath}, but none is present`,
        'The file did not make it into this deploy: check that your build copies it and that the path is right '
          + `(relative paths resolve against the working directory). To resolve from .env files instead, unset ${USE_FROZEN_ENV_VAR} and drop --frozen.`,
      );
    }
    throw new FrozenEnvFileError(`failed to read frozen env file ${filePath}: ${(err as Error).message}`);
  }
  // only a regular file is readable: `readFileSync` on a FIFO with no writer blocks forever
  if (!stat.isFile()) {
    throw new FrozenEnvFileError(`frozen env file ${filePath} is not a regular file`);
  }

  // A frozen file is a complete, already-validated snapshot of the graph, so honoring
  // _VARLOCK_FILTER would hand over values the caller expected to exclude (same reasoning as
  // the blob path). `varlock freeze` deliberately has no --filter: a partial freeze would mean
  // keys outside the scope are neither frozen nor validated, which is the split-validation
  // state the whole feature exists to prevent. So the remedy is to drop one or the other,
  // never to re-freeze with a matching filter.
  if (env._VARLOCK_FILTER) {
    throw new FrozenEnvFileError(
      `a frozen env file (${filePath}) cannot be combined with _VARLOCK_FILTER`,
      `Unset _VARLOCK_FILTER to use the frozen env, or unset ${USE_FROZEN_ENV_VAR} to resolve from .env files instead.`,
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
      `Set _VARLOCK_ENV_KEY in the runtime environment. ${FROZEN_KEY_MISMATCH}`,
    );
  }
  try {
    return { filePath, blobJson: decryptEnvBlobSync(rawContents, key) };
  } catch (err) {
    throw new FrozenEnvFileError(
      `failed to decrypt frozen env file ${filePath}: ${(err as Error).message.replace(/^\[varlock\] /, '')}`,
      `${FROZEN_KEY_MISMATCH} If the key was rotated, re-create the file with \`varlock freeze\` using the new key.`,
    );
  }
}
