import fs from 'node:fs';
import path from 'node:path';
import type { SerializedEnvGraph } from '../env-graph';
import { isEncryptedBlob, decryptEnvBlobSync } from '../runtime/crypto';
import { readVarlockPackageJsonConfig } from './package-json-config';
import { envValueMatchesBlobItem } from './injected-env-provenance';

/**
 * Decides whether a consumer (`varlock/auto-load`, or a `varlock run` that finds a blob
 * in its environment) can reuse an already-injected `__VARLOCK_ENV` blob instead of
 * re-resolving from .env files.
 *
 * Two goals drive this:
 *  1. A command "unnecessarily" wrapped in `varlock run` (same directory the app would
 *     resolve in anyway) should not pay for a second resolution.
 *  2. A blob can be handed into an environment with no .env files at all (e.g. a sandbox)
 *     and auto-load hydrates everything from it.
 *
 * Goal 1 is the automatic path, gated on conservative checks; any failed check falls back
 * to spawning the CLI, which is exactly today's behavior (including the nested-invocation
 * override-provenance handling in load-graph). Goal 2 is explicit, via
 * `_VARLOCK_USE_INJECTED_ENV=1`, since a blob from another machine can never pass the
 * directory check and there is nothing to fall back to.
 */

/** user-controllable behavior flag (leading single underscore per convention) */
export const USE_INJECTED_ENV_VAR = '_VARLOCK_USE_INJECTED_ENV';

export type InjectedEnvReuseDecision = | {
  reuse: true,
  parsedEnv: SerializedEnvGraph,
  /** plaintext JSON of the (sanitized) blob - used when it needs re-serialization/re-encryption */
  blobJson: string,
  /**
   * `@internal` item keys that were stripped from the blob on consumption. Fresh-resolution
   * blobs never carry internal items, but the inspection command (`load --format json-full
   * --include-internal`) is a supported producer, and a secret-zero value must never reach
   * the app or a child process through reuse. Non-empty means parsedEnv/blobJson were
   * rewritten without those entries; consumers must also drop any ambient env values for
   * these keys before handing env to a child.
   */
  strippedInternalKeys: Array<string>,
}
  | { reuse: false, reason: string };

type EnvRecord = Record<string, string | undefined>;

/**
 * Same accepted values as `parseEnvToggle` (see `_VARLOCK_REDACT_STDOUT`): only `1`/`true`
 * and `0`/`false`, case-insensitive. Anything else falls back to auto rather than being
 * treated as an opt-in - `=f`/`=no`/`=off` must never silently grant blob trust.
 */
export function getUseInjectedEnvMode(env: EnvRecord): 'auto' | 'force' | 'never' {
  const rawValue = env[USE_INJECTED_ENV_VAR];
  if (rawValue === undefined) return 'auto';
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return 'force';
  if (normalized === '0' || normalized === 'false') return 'never';
  return 'auto';
}

/**
 * Replicates how load-graph/loader would pick the resolution base dir for a default
 * (flag-less) load: package.json `varlock.loadPath` if configured, otherwise cwd.
 * Returns undefined when it can't be determined (e.g. loadPath points at a missing
 * path) - the CLI should run and surface its own error in that case.
 */
function getExpectedResolutionBasePath(cwd: string): string | undefined {
  const pkgLoadPath = readVarlockPackageJsonConfig({ cwd })?.loadPath;
  if (!pkgLoadPath) return cwd;

  const rawPaths = Array.isArray(pkgLoadPath) ? pkgLoadPath : [pkgLoadPath];
  // multiple entry paths -> loader keeps basePath = cwd
  if (rawPaths.length !== 1) return cwd;

  const resolved = path.resolve(cwd, rawPaths[0]);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return undefined;
  }
}

/** compare two paths after realpath normalization (symlinks, /private/tmp, worktrees) */
function isSamePath(a: string, b: string): boolean {
  const normalize = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return normalize(a) === normalize(b);
}

export function evaluateInjectedEnvReuse(opts: {
  /** env holding the blob/key/flags - normally the live process.env */
  env: EnvRecord,
  /**
   * Snapshot of process.env from before varlock injected anything. Needed because the
   * runtime's module-level auto-init may have already re-injected the parent blob's
   * values into the live process.env by the time auto-load's body runs, which would
   * mask a command-local override (`FOO=bar node app.js` under a parent `varlock run`).
   */
  preInjectionEnv?: EnvRecord,
  cwd?: string,
}): InjectedEnvReuseDecision {
  const { env } = opts;
  const preInjectionEnv = opts.preInjectionEnv ?? env;
  const cwd = opts.cwd ?? process.cwd();

  const mode = getUseInjectedEnvMode(env);
  if (mode === 'never') return { reuse: false, reason: `${USE_INJECTED_ENV_VAR} disabled reuse` };

  // _VARLOCK_FILTER is the env-var form of --filter, honored by any fresh resolution
  // (see getCliItemFilter) - reusing an unscoped blob would bypass it and hand over
  // values the caller expected to exclude
  if (env._VARLOCK_FILTER) {
    if (mode === 'force') {
      throw new Error(`[varlock] ${USE_INJECTED_ENV_VAR} cannot be combined with _VARLOCK_FILTER - capture the blob with --filter instead`);
    }
    return { reuse: false, reason: '_VARLOCK_FILTER is set' };
  }

  const rawBlob = env.__VARLOCK_ENV;
  if (!rawBlob) {
    if (mode === 'force') {
      throw new Error(`[varlock] ${USE_INJECTED_ENV_VAR} is enabled but no __VARLOCK_ENV blob is present in the environment`);
    }
    return { reuse: false, reason: 'no injected env blob present' };
  }

  let blobJson = rawBlob;
  if (isEncryptedBlob(rawBlob)) {
    const key = env._VARLOCK_ENV_KEY;
    if (!key) {
      if (mode === 'force') {
        throw new Error(`[varlock] ${USE_INJECTED_ENV_VAR} is enabled but __VARLOCK_ENV is encrypted and _VARLOCK_ENV_KEY is not set`);
      }
      return { reuse: false, reason: 'blob is encrypted and no _VARLOCK_ENV_KEY is set' };
    }
    try {
      blobJson = decryptEnvBlobSync(rawBlob, key);
    } catch (err) {
      if (mode === 'force') {
        throw new Error(`[varlock] failed to decrypt __VARLOCK_ENV blob: ${(err as Error).message}`);
      }
      return { reuse: false, reason: 'failed to decrypt blob' };
    }
  }

  let parsedEnv: SerializedEnvGraph;
  try {
    parsedEnv = JSON.parse(blobJson);
    if (!parsedEnv || typeof parsedEnv !== 'object' || !parsedEnv.config || typeof parsedEnv.config !== 'object') {
      throw new Error('not a serialized env graph');
    }
  } catch {
    if (mode === 'force') {
      throw new Error(`[varlock] ${USE_INJECTED_ENV_VAR} is enabled but the __VARLOCK_ENV blob is not a valid serialized env graph`);
    }
    return { reuse: false, reason: 'blob is not a valid serialized env graph' };
  }

  // @internal items are never handed to the app/child by any fresh resolution path, but a
  // blob produced by the inspection command (`load --format json-full --include-internal`)
  // can carry them - strip on consumption, in every mode, and re-serialize so a forwarded
  // blob is clean too
  const strippedInternalKeys: Array<string> = [];
  for (const itemKey of Object.keys(parsedEnv.config)) {
    if (parsedEnv.config[itemKey].isInternal) {
      strippedInternalKeys.push(itemKey);
      delete parsedEnv.config[itemKey];
    }
  }
  if (strippedInternalKeys.length) blobJson = JSON.stringify(parsedEnv);

  // explicit trust - the sandbox path. The blob is authoritative regardless of where it
  // was resolved; directory/drift checks make no sense for a blob from another machine.
  if (mode === 'force') {
    return {
      reuse: true, parsedEnv, blobJson, strippedInternalKeys,
    };
  }

  // -- automatic path: reuse only when a fresh resolution would clearly produce the same result

  // a blob carrying errors means the producer's load failed - let the CLI re-run and
  // surface a proper failure rather than booting the app on known-bad values
  if (parsedEnv.errors) return { reuse: false, reason: 'blob contains resolution errors' };

  // older producers may not have recorded basePath - we can't verify locality, so re-resolve
  if (!parsedEnv.basePath) return { reuse: false, reason: 'blob has no basePath recorded' };

  const expectedBasePath = getExpectedResolutionBasePath(cwd);
  if (!expectedBasePath || !isSamePath(parsedEnv.basePath, expectedBasePath)) {
    return {
      reuse: false,
      reason: `blob was resolved in a different directory (${parsedEnv.basePath})`,
    };
  }

  // Env drift: if ANY blob config key's ambient value differs from what the parent
  // injected (e.g. `varlock run -- sh -c 'FOO=x node app.js'`, whether or not FOO was
  // already an override at the parent), reusing the blob would clobber FOO back to the
  // stale value - re-resolving honors the new value via the nested-invocation override
  // handling in load-graph. An unchanged value is just this blob's own value echoing back
  // (injected form, or the raw pre-coercion override string the parent recorded), and a
  // key *absent* from the env is not drift (`--inject blob` mode injects no individual
  // vars at all).
  for (const itemKey of Object.keys(parsedEnv.config)) {
    if (!(itemKey in preInjectionEnv)) continue;
    if (!envValueMatchesBlobItem(preInjectionEnv[itemKey], parsedEnv.config[itemKey])) {
      return { reuse: false, reason: `env value for ${itemKey} changed since the blob was created` };
    }
  }

  return {
    reuse: true, parsedEnv, blobJson, strippedInternalKeys,
  };
}
