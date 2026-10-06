import fs from 'node:fs';
import path from 'node:path';
import type { SerializedEnvGraph } from '../env-graph';
import { isEncryptedBlob, decryptEnvBlobSync } from '../runtime/crypto';
import { readVarlockPackageJsonConfig } from './package-json-config';
import { envValueMatchesBlobItem } from './injected-env-provenance';
import { hashEnvSourceContents } from './env-source-fingerprint';
import { applyFrozenBootKeys, getBootItems } from './frozen-boot-keys';
import {
  FrozenEnvFileError, PreResolvedEnvError, readFrozenEnvFile, resolveFrozenEnvFileMode,
} from './frozen-env-file';

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
  /** where the graph came from - an ambient `__VARLOCK_ENV`, or a `varlock freeze` artifact on disk */
  source: 'env-blob' | 'frozen-file',
  /**
   * `@internal` item keys that were stripped from the blob on consumption. Fresh-resolution
   * blobs never carry internal items, but the inspection command (`load --format json-full
   * --include-internal`) is a supported producer, and a secret-zero value must never reach
   * the app or a child process through reuse. Non-empty means parsedEnv/blobJson were
   * rewritten without those entries; consumers must also drop any ambient env values for
   * these keys before handing env to a child.
   */
  strippedInternalKeys: Array<string>,
  /**
   * Whether parsedEnv/blobJson differ from the ambient `__VARLOCK_ENV` - it came from a frozen
   * file, had `@internal` items stripped, or had boot-time values applied. When false the
   * ambient blob can be forwarded byte-for-byte; when true it must be re-serialized, or a child
   * would see a different graph than this process.
   */
  rewritten: boolean,
  /** path of the consumed `varlock freeze` file (frozen-file source only) */
  filePath?: string,
}
  | { reuse: false, reason: string };

/** A frozen env a fresh view should be shown from (see findExplicitFrozenEnv) */
export type FrozenEnvInfo = {
  /** with any boot-time values for `@dynamic=boot` items already applied */
  graph: SerializedEnvGraph,
  source: 'env-blob' | 'frozen-file',
  /** frozen-file source only */
  filePath?: string,
};

type SanitizedGraph = NonNullable<ReturnType<typeof parseAndSanitizeBlob>>;

/**
 * The final step for any usable pre-resolved graph. A `varlock freeze` payload with
 * `@dynamic=boot` items gets their boot-time values applied first (checked against the types
 * the freeze recorded, no schema needed), so the result is always complete. Invalid boot
 * values fail closed, like any other unusable frozen env.
 */
function reuseOrApplyBoot(
  sanitized: SanitizedGraph,
  source: FrozenEnvInfo['source'],
  bootEnv: EnvRecord,
  filePath?: string,
): InjectedEnvReuseDecision {
  if (!Object.keys(getBootItems(sanitized.parsedEnv)).length) {
    return {
      reuse: true,
      ...sanitized,
      rewritten: source === 'frozen-file' || sanitized.strippedInternalKeys.length > 0,
      source,
      filePath,
    };
  }
  const { graph, problems } = applyFrozenBootKeys(sanitized.parsedEnv, bootEnv);
  if (problems.length) {
    const what = source === 'frozen-file' ? `frozen env file ${filePath}` : 'frozen __VARLOCK_ENV payload';
    const message = `invalid @dynamic=boot value${problems.length === 1 ? '' : 's'} for the ${what}:\n${problems.map((p) => `  - ${p}`).join('\n')}`;
    const suggestion = 'Fix the value set in the environment at boot. It is checked against the type recorded when the env was frozen.';
    throw source === 'frozen-file' ? new FrozenEnvFileError(message, suggestion) : new PreResolvedEnvError(message, suggestion);
  }
  return {
    reuse: true,
    parsedEnv: graph,
    blobJson: JSON.stringify(graph),
    strippedInternalKeys: sanitized.strippedInternalKeys,
    rewritten: true,
    source,
    filePath,
  };
}

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

/**
 * Parse a serialized graph and strip anything that must never reach the app.
 *
 * `@internal` items are never handed to the app/child by any fresh resolution path, but a
 * blob produced by the inspection command (`load --format json-full --include-internal`)
 * can carry them - strip on consumption and re-serialize so a forwarded blob is clean too.
 *
 * Returns undefined when the input isn't a serialized env graph, so each caller can frame
 * the failure in terms of where the graph came from.
 */
function parseAndSanitizeBlob(rawJson: string): {
  parsedEnv: SerializedEnvGraph, blobJson: string, strippedInternalKeys: Array<string>,
} | undefined {
  let parsedEnv: SerializedEnvGraph;
  try {
    parsedEnv = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  if (!parsedEnv || typeof parsedEnv !== 'object' || !parsedEnv.config || typeof parsedEnv.config !== 'object') {
    return undefined;
  }

  const strippedInternalKeys: Array<string> = [];
  for (const itemKey of Object.keys(parsedEnv.config)) {
    if (parsedEnv.config[itemKey].isInternal) {
      strippedInternalKeys.push(itemKey);
      delete parsedEnv.config[itemKey];
    }
  }
  return {
    parsedEnv,
    blobJson: strippedInternalKeys.length ? JSON.stringify(parsedEnv) : rawJson,
    strippedInternalKeys,
  };
}

// Suggestions for explicit-trust failures. Two producers feed this path: `varlock freeze --out -`
// (a deploy payload) and a `load --format json-full --compact` capture (handing env into a
// sandbox), so remedies name both rather than assuming one.
const UNSET_FORCE = `Or unset ${USE_INJECTED_ENV_VAR} to resolve from .env files instead.`;
const RECAPTURE_BLOB = 'Re-capture it with `varlock freeze --out -` (or `varlock load --format json-full --compact`), '
  + `and fail the pipeline when that command exits non-zero. ${UNSET_FORCE}`;

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
  /** only consume a frozen env file named by `_VARLOCK_USE_FROZEN_ENV`, never a discovered one */
  explicitFrozenOnly?: boolean,
}): InjectedEnvReuseDecision {
  const { env } = opts;
  const preInjectionEnv = opts.preInjectionEnv ?? env;
  const cwd = opts.cwd ?? process.cwd();

  // A frozen env file (`varlock freeze`) is a deploy-time freeze that ships inside the deploy
  // unit. It wins over an ambient __VARLOCK_ENV: a file on disk is the more deliberate act,
  // and the two are governed by separate flags so _VARLOCK_USE_INJECTED_ENV=0 does not
  // disable it (use _VARLOCK_USE_FROZEN_ENV=0).
  //
  // Like the force path it is authoritative with no directory/drift verification, because
  // the checks below compare a blob against local .env files which a frozen deploy by design
  // does not carry. Any problem with a present or required file throws, so a broken frozen env can never
  // silently degrade into a boot-time re-resolution.
  const frozen = readFrozenEnvFile({ env, cwd, explicitOnly: opts.explicitFrozenOnly });
  if (frozen) {
    const sanitizedFrozen = parseAndSanitizeBlob(frozen.blobJson);
    if (!sanitizedFrozen) {
      throw new FrozenEnvFileError(`frozen env file ${frozen.filePath} is not a valid serialized env graph`);
    }
    if (sanitizedFrozen.parsedEnv.errors) {
      throw new FrozenEnvFileError(`frozen env file ${frozen.filePath} was created from a failed resolution and contains errors`);
    }
    return reuseOrApplyBoot(sanitizedFrozen, 'frozen-file', preInjectionEnv, frozen.filePath);
  }

  const mode = getUseInjectedEnvMode(env);
  if (mode === 'never') return { reuse: false, reason: `${USE_INJECTED_ENV_VAR} disabled reuse` };

  // _VARLOCK_FILTER is the env-var form of --filter, honored by any fresh resolution
  // (see getCliItemFilter) - reusing an unscoped blob would bypass it and hand over
  // values the caller expected to exclude
  if (env._VARLOCK_FILTER) {
    if (mode === 'force') {
      throw new PreResolvedEnvError(
        `${USE_INJECTED_ENV_VAR} cannot be combined with _VARLOCK_FILTER`,
        'Unset _VARLOCK_FILTER, or capture a scoped blob with `varlock load --filter ... --format json-full --compact` '
          + '(a `varlock freeze` payload is always complete).',
      );
    }
    return { reuse: false, reason: '_VARLOCK_FILTER is set' };
  }
  // same for a `varlock.filter` configured in package.json (validated by the CLI on load)
  if (readVarlockPackageJsonConfig({ cwd })?.filter) {
    if (mode === 'force') {
      throw new PreResolvedEnvError(
        `${USE_INJECTED_ENV_VAR} cannot be combined with package.json varlock.filter`,
        `Capture a scoped blob with \`varlock load --format json-full --compact\`, which applies the filter. ${
          UNSET_FORCE}`,
      );
    }
    return { reuse: false, reason: 'package.json varlock.filter is set' };
  }

  const rawBlob = env.__VARLOCK_ENV;
  if (!rawBlob) {
    if (mode === 'force') {
      throw new PreResolvedEnvError(
        `${USE_INJECTED_ENV_VAR} is enabled but no __VARLOCK_ENV blob is present in the environment`,
        'The payload did not reach this process: set __VARLOCK_ENV to the output of `varlock freeze --out -` '
          + `(or a \`varlock load --format json-full --compact\` capture) on your platform. ${UNSET_FORCE}`,
      );
    }
    return { reuse: false, reason: 'no injected env blob present' };
  }

  let blobJson = rawBlob;
  if (isEncryptedBlob(rawBlob)) {
    const key = env._VARLOCK_ENV_KEY;
    if (!key) {
      if (mode === 'force') {
        throw new PreResolvedEnvError(
          `${USE_INJECTED_ENV_VAR} is enabled but __VARLOCK_ENV is encrypted and _VARLOCK_ENV_KEY is not set`,
          'Set _VARLOCK_ENV_KEY in the runtime environment, to the key the payload was encrypted with.',
        );
      }
      return { reuse: false, reason: 'blob is encrypted and no _VARLOCK_ENV_KEY is set' };
    }
    try {
      blobJson = decryptEnvBlobSync(rawBlob, key);
    } catch (err) {
      if (mode === 'force') {
        throw new PreResolvedEnvError(
          `failed to decrypt __VARLOCK_ENV blob: ${(err as Error).message.replace(/^\[varlock\] /, '')}`,
          '_VARLOCK_ENV_KEY must be the key the payload was encrypted with. If the key was rotated, re-capture the payload with the new key.',
        );
      }
      return { reuse: false, reason: 'failed to decrypt blob' };
    }
  }

  const sanitized = parseAndSanitizeBlob(blobJson);
  if (!sanitized) {
    if (mode === 'force') {
      throw new PreResolvedEnvError(
        `${USE_INJECTED_ENV_VAR} is enabled but the __VARLOCK_ENV blob is not a valid serialized env graph`,
        `It may have been truncated or mangled by quoting on its way into the environment. ${RECAPTURE_BLOB}`,
      );
    }
    return { reuse: false, reason: 'blob is not a valid serialized env graph' };
  }
  const { parsedEnv } = sanitized;

  // A blob carrying errors means the producer's load failed. On the automatic path below
  // that just means re-resolving, but this check has to come BEFORE the force return too:
  // explicit trust is about *where* the blob was resolved, not whether it resolved. Without
  // it, a capture that ignored the producer's non-zero exit (`load --format json-full`
  // prints its JSON either way) boots the app on known-bad values, and the only signal is a
  // warning on each ENV access. Matches how a frozen file refuses the same payload.
  if (parsedEnv.errors) {
    if (mode === 'force') {
      throw new PreResolvedEnvError(
        `${USE_INJECTED_ENV_VAR} is enabled but the __VARLOCK_ENV blob was created from a failed resolution and contains errors`,
        RECAPTURE_BLOB,
      );
    }
    return { reuse: false, reason: 'blob contains resolution errors' };
  }

  // explicit trust - the sandbox path. The blob is authoritative regardless of where it
  // was resolved; directory/drift checks make no sense for a blob from another machine.
  if (mode === 'force') {
    return reuseOrApplyBoot(sanitized, 'env-blob', preInjectionEnv);
  }

  // -- automatic path: reuse only when a fresh resolution would clearly produce the same result
  // (a blob carrying errors was already rejected above, in every mode)

  // older producers may not have recorded basePath - we can't verify locality, so re-resolve
  if (!parsedEnv.basePath) return { reuse: false, reason: 'blob has no basePath recorded' };

  const expectedBasePath = getExpectedResolutionBasePath(cwd);
  if (!expectedBasePath || !isSamePath(parsedEnv.basePath, expectedBasePath)) {
    return {
      reuse: false,
      reason: `blob was resolved in a different directory (${parsedEnv.basePath})`,
    };
  }

  // Source drift: the producer fingerprints the contents of each file source it actually
  // parsed (see getSerializedGraph). If a source has been edited or removed since the blob
  // was made (e.g. an env file edit followed by a dev-server restart inside the same
  // `varlock run`), reuse could serve pre-edit values - re-resolve instead. Disabled
  // sources are verified too: `@disable` lives in the source's own content, so an edit can
  // re-enable it (an edit that leaves it disabled just costs one harmless re-resolution).
  // Known gap: a matching env file *created* after the blob won't appear in its sources
  // list and isn't detected here.
  if (!Array.isArray(parsedEnv.sources)) {
    return { reuse: false, reason: 'blob has no sources recorded' };
  }
  for (const source of parsedEnv.sources) {
    if (source.path === undefined) continue;
    // older producers didn't record fingerprints - we can't verify, so re-resolve
    if (!source.contentHash) {
      return { reuse: false, reason: `blob has no content fingerprint for source ${source.path}` };
    }
    const sourceFullPath = path.resolve(parsedEnv.basePath, source.path);
    let currentContents: string;
    try {
      // stat-gate before reading - env sources can legitimately be FIFOs (e.g. 1Password
      // Environments serves .env files as pipes), and reading one here would have side
      // effects (the serving process rewrites it) or block forever on a writerless pipe.
      // A non-regular file's content can't be verified without reading it, so fall back
      // to a fresh resolution, which reads it once the same way any normal load does.
      if (!fs.statSync(sourceFullPath).isFile()) {
        return { reuse: false, reason: `source ${source.path} is not a regular file` };
      }
      currentContents = fs.readFileSync(sourceFullPath, 'utf8');
    } catch {
      return { reuse: false, reason: `source file ${source.path} is missing or unreadable` };
    }
    if (hashEnvSourceContents(currentContents) !== source.contentHash) {
      return { reuse: false, reason: `source file ${source.path} changed since the blob was created` };
    }
  }

  // Env drift: if ANY blob config key's ambient value differs from what the parent
  // injected (e.g. `varlock run -- sh -c 'FOO=x node app.js'`, whether or not FOO was
  // already an override at the parent), reusing the blob would clobber FOO back to the
  // stale value - re-resolving honors the new value via the nested-invocation override
  // handling in load-graph. An unchanged value is just this blob's own value echoing back
  // (injected form, or the raw pre-coercion override string the parent recorded), and a
  // key *absent* from the env is not drift (`--inject blob` mode injects no individual
  // vars at all).
  // (`@dynamic=boot` keys of a frozen payload are meant to differ - they are applied below)
  const bootKeys = getBootItems(parsedEnv);
  for (const itemKey of Object.keys(parsedEnv.config)) {
    if (!(itemKey in preInjectionEnv) || itemKey in bootKeys) continue;
    if (!envValueMatchesBlobItem(preInjectionEnv[itemKey], parsedEnv.config[itemKey], parsedEnv.settings)) {
      return { reuse: false, reason: `env value for ${itemKey} changed since the blob was created` };
    }
  }

  return reuseOrApplyBoot(sanitized, 'env-blob', preInjectionEnv);
}

/**
 * The frozen env `varlock load` should show instead of resolving, if any, with boot-time values
 * for `@dynamic=boot` items applied.
 *
 * Unlike `varlock run` and auto-load, only an explicitly requested frozen env counts: a frozen env file named by
 * `_VARLOCK_USE_FROZEN_ENV` (`1` or a path) or `--frozen`, or a
 * `varlock freeze --out -` payload trusted via `_VARLOCK_USE_INJECTED_ENV=1`. `load` is what
 * every framework integration shells out to at dev and build time, so a frozen file merely
 * sitting in a project directory must not take over those; `load` says so instead (see
 * load.command). An ordinary blob (a parent `varlock run`, a `load --format json-full`
 * capture) is never shown as one.
 *
 * Throws the same way evaluateInjectedEnvReuse does when a frozen env is present but unusable.
 */
export function findExplicitFrozenEnv(opts: { env: EnvRecord, cwd?: string }): FrozenEnvInfo | undefined {
  const { env } = opts;
  const cwd = opts.cwd ?? process.cwd();
  const forced = getUseInjectedEnvMode(env) === 'force';
  if (!forced && !resolveFrozenEnvFileMode(env, cwd)?.required) return undefined;

  const decision = evaluateInjectedEnvReuse({ env, cwd, explicitFrozenOnly: true });
  if (!decision.reuse) return undefined;
  if (decision.source === 'env-blob' && (!forced || !decision.parsedEnv.frozen)) return undefined;
  return { graph: decision.parsedEnv, source: decision.source, filePath: decision.filePath };
}
