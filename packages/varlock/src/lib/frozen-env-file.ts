import fs from 'node:fs';
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
 */

import {
  FROZEN_ENV_FILE_NAME, USE_FROZEN_ENV_VAR, resolveFrozenEnvFileMode,
} from './frozen-env-guard';

export { FROZEN_ENV_FILE_NAME, USE_FROZEN_ENV_VAR, resolveFrozenEnvFileMode };

type EnvRecord = Record<string, string | undefined>;

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

/** A frozen env file that is in play but cannot be used */
export class FrozenEnvFileError extends PreResolvedEnvError {
  constructor(message: string, suggestion = RECREATE_FROZEN_FILE) {
    super(message, suggestion);
    this.name = 'FrozenEnvFileError';
  }
}

/**
 * `fs.statSync` without throwing on absence: undefined when nothing is at the path. When the
 * file is only being auto-discovered, a path we are not allowed to look at counts as absent
 * too: `varlock run` from a cwd it cannot enter (EACCES) has nothing to discover there, and
 * must not fail on a frozen file nobody asked for. A required file still errors.
 */
function statFrozenEnvPath(filePath: string, required: boolean): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    if (!required && (code === 'EACCES' || code === 'EPERM')) return undefined;
    throw new FrozenEnvFileError(`failed to read frozen env file ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * The frozen env file this invocation will consume, if any: a required one (present or
 * not), or one present at the auto-discovered path. Callers use this to reject flags that
 * would change what gets loaded, rather than silently ignoring the frozen env.
 */
export function getFrozenEnvFileInPlay(env: EnvRecord, cwd: string): string | undefined {
  const mode = resolveFrozenEnvFileMode(env, cwd);
  if (!mode) return undefined;
  if (mode.required || statFrozenEnvPath(mode.filePath, false)) return mode.filePath;
  return undefined;
}

/**
 * Read + decrypt the frozen env file, if one applies. Only ABSENCE of an auto-discovered
 * file returns undefined; any other problem (a required file missing, not a regular file,
 * unreadable, encrypted with no or the wrong key) throws. Falling back would silently
 * unfreeze the deploy and re-resolve at boot, which is exactly what freezing exists to
 * eliminate.
 */
export function readFrozenEnvFile(opts: {
  env: EnvRecord,
  cwd?: string,
  /** skip a file that would only be auto-discovered (see findExplicitFrozenEnv) */
  explicitOnly?: boolean,
}): { filePath: string, blobJson: string } | undefined {
  const { env } = opts;
  const mode = resolveFrozenEnvFileMode(env, opts.cwd ?? process.cwd());
  if (!mode || (opts.explicitOnly && !mode.required)) return undefined;
  const { filePath } = mode;

  const stat = statFrozenEnvPath(filePath, mode.required);
  if (!stat) {
    if (!mode.required) return undefined;
    throw new FrozenEnvFileError(
      `${USE_FROZEN_ENV_VAR} requires a frozen env file at ${filePath}, but none is present`,
      'The file did not make it into this deploy: check that your build copies it and that the path is right '
        + `(relative paths resolve against the working directory). To resolve from .env files instead, unset ${USE_FROZEN_ENV_VAR} and drop --frozen.`,
    );
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
      `Unset _VARLOCK_FILTER to use the frozen env, or set ${USE_FROZEN_ENV_VAR}=0 to resolve from .env files instead.`,
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
