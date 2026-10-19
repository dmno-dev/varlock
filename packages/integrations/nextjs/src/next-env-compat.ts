/**
 * Drop-in replacement for @next/env that uses varlock instead of dotenv
 *
 * This must be the default export of the module, and it must stay compatible with @next/env
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { SerializedEnvGraph } from 'varlock';
import { initVarlockEnv, resetRedactionMap } from 'varlock/env';
// namespace import: `patchProcessStreams` is missing from older varlock versions, and a missing
// named import would fail at link time rather than degrade to console-only redaction
import * as varlockPatchConsole from 'varlock/patch-console';
import { execSyncVarlock, VarlockExecError } from 'varlock/exec-sync-varlock';
import { decryptEnvBlobSync, isEncryptedBlob } from 'varlock/encrypt-env';
import {
  FROZEN_BOOT_SOURCE_ENV_KEY, FROZEN_BUILD_ENV_KEY, NOT_FROZEN_BOOT_HINT, STANDALONE_CONFIG_SOURCE,
} from './freeze-into-bundle';

export type Env = { [key: string]: string | undefined };
export type LoadedEnvFiles = Array<{
  path: string
  contents: string
  env: Env
}>;

/** will store the original values of process.env */
export let initialEnv: Env | undefined;

let lastReloadAt: Date | undefined;

let varlockLoadedEnv: SerializedEnvGraph;
let combinedEnv: Env | undefined;
let parsedEnv: Env | undefined;
let lastLoadedSourceStateHash: string | undefined;
// this is used by next just to display the list of .env files in a startup log
let loadedEnvFiles: LoadedEnvFiles = [];
let rootDir: string | undefined;

// @next/env exports this info and currently it is only used to display
// a list of filenames loaded, for example: `Environments: .env, .env.development`
function getVarlockSourcesAsLoadedEnvFiles(): LoadedEnvFiles {
  const envFilesLabels = varlockLoadedEnv.sources
    .filter((s) => s.enabled && s.type !== 'container' && s.type !== 'import-alias')
    .map((s) => s.label);
  if (envFilesLabels.length) {
    // this adds an additional line, below the list of files
    envFilesLabels.push('\n                   ✨ loaded by varlock ✨');
  }
  // files can be imported multiple times, so we deduplicate the labels here
  const uniqueLabels = [...new Set(envFilesLabels)];
  // Next.js expects an array of objects, even though it is not used for anything
  return uniqueLabels.map((label) => ({
    path: label,
    contents: '',
    env: {},
  }));
}

const IS_WORKER = !!process.env.NEXT_PRIVATE_WORKER;
function debug(...args: Array<any>) {
  if (!process.env.DEBUG_VARLOCK_NEXT_INTEGRATION) return;
  // eslint-disable-next-line no-console
  console.log(
    IS_WORKER ? 'worker -- ' : 'server -- ',
    ...args,
  );
}
debug('✨ LOADED @next/env module!');

let lastUserLogSignature: string | undefined;
let lastUserLogAt = 0;
const USER_LOG_DEDUPE_MS = 1500;

function logUserInfo(message: string) {
  const now = Date.now();
  const signature = `info:${message}`;
  if (lastUserLogSignature === signature && (now - lastUserLogAt) < USER_LOG_DEDUPE_MS) return;
  lastUserLogSignature = signature;
  lastUserLogAt = now;
  // eslint-disable-next-line no-console
  console.log(message);
}

function logUserError(message: string) {
  const now = Date.now();
  const signature = `error:${message}`;
  if (lastUserLogSignature === signature && (now - lastUserLogAt) < USER_LOG_DEDUPE_MS) return;
  lastUserLogSignature = signature;
  lastUserLogAt = now;
  // eslint-disable-next-line no-console
  console.error(message);
}

function debugHash(hash: string | undefined) {
  if (hash === undefined) return '(missing)';
  return hash.slice(0, 10);
}

// Env sources may not be regular files — e.g. 1Password Environments serves
// `.env` as a FIFO (named pipe) that `op` re-serves on every read. Reading such
// a file from our reload machinery makes the serving process write to the pipe
// again, which fires a new fs event, which triggers another reload check...
// an endless loop of reloads/logs. So these files must never be read, watched,
// or written to outside of the actual `varlock load` call.
function isExistingNonRegularFile(filePath: string): boolean {
  try {
    return !fs.statSync(filePath).isFile();
  } catch {
    return false; // missing files are handled as "missing" by callers
  }
}

// deduped via env var because Next.js loads duplicate copies of this module
// (and spawns worker processes that would each log the same notice)
const WARNED_NON_REGULAR_ENV_KEY = '__VARLOCK_NEXT_WARNED_NON_REGULAR_FILES';
function warnNonRegularSourceOnce(filePath: string) {
  const warnedList = (process.env[WARNED_NON_REGULAR_ENV_KEY] || '').split(',');
  if (warnedList.includes(filePath)) return;
  process.env[WARNED_NON_REGULAR_ENV_KEY] = [...warnedList.filter(Boolean), filePath].join(',');
  const displayPath = rootDir ? (path.relative(rootDir, filePath) || filePath) : filePath;
  logUserInfo(`ℹ️ [varlock] ${displayPath} is not a regular file (FIFO/pipe), live reload is disabled for it`);
}

function readFileHash(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    if (isExistingNonRegularFile(filePath)) {
      // treat as opaque + constant — content is generated on read, so hashing it
      // is meaningless and the read itself would re-trigger fs events
      warnNonRegularSourceOnce(filePath);
      return '(non-regular-file)';
    }
    const contents = fs.readFileSync(filePath, 'utf-8');
    const hash = createHash('sha256');
    hash.update(contents, 'utf8');
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

function getTrackedSourcePaths(sources: SerializedEnvGraph['sources'], basePath?: string): Array<string> {
  if (!rootDir) return [];
  const tracked = new Set<string>();
  for (const source of sources) {
    if (!source.enabled || !source.path) continue;
    const absPath = basePath ? path.resolve(basePath, source.path) : path.resolve(rootDir, source.path);
    tracked.add(absPath);
  }
  tracked.add(path.join(rootDir, '.env.schema'));
  return [...tracked].sort();
}

function computeSourceStateHash(sources: SerializedEnvGraph['sources'], basePath?: string): string | undefined {
  const trackedPaths = getTrackedSourcePaths(sources, basePath);
  if (!trackedPaths.length) return undefined;
  const hash = createHash('sha256');
  for (const filePath of trackedPaths) {
    const fileHash = readFileHash(filePath) || '(missing)';
    hash.update(`${filePath}:${fileHash}\n`);
  }
  return hash.digest('hex');
}


/**
 * Comparison key for "did this reload actually change the env".
 *
 * Only the resolved items and settings count. The rest of the serialized graph moves
 * without the env changing: `sources[].contentHash` fingerprints raw file bytes, and the
 * source list itself churns in dev because `enableExtraFileWatchers` creates and deletes a
 * Next-watched `.env` file to trigger reloads, so a load can catch it mid-flight.
 *
 * This also normalizes formatting, since the CLI pretty-prints `json-full` unless
 * `--compact` is passed while the copy in `process.env.__VARLOCK_ENV` is a compact
 * re-stringify.
 *
 * Returns undefined when there is nothing parseable to compare.
 */
export function envComparisonKey(serializedEnv: string | undefined): string | undefined {
  if (!serializedEnv) return undefined;
  try {
    const graph = JSON.parse(serializedEnv);
    return JSON.stringify({ config: graph?.config ?? {}, settings: graph?.settings ?? {} });
  } catch {
    return undefined;
  }
}


// Next.js only watches a fixed set of .env files for changes. Varlock may load
// additional files (e.g. .env.schema, .env.staging, custom sources). We watch
// those extra files and trigger a reload by touching one of Next's watched files.
const NEXT_WATCHED_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];
const watchedExtraFiles = new Set<string>();
const pendingReloadFiles = new Set<string>();

// Next's own env watcher fires on FIFO mtime churn (every read/serve of the
// pipe updates it), so "change detected" events for those files carry no signal
function nextWatchedEnvFilesIncludeNonRegular(): boolean {
  if (!rootDir) return false;
  return NEXT_WATCHED_ENV_FILES.some((f) => isExistingNonRegularFile(path.join(rootDir!, f)));
}

// Exactly one process should own the extra-file watchers. Which process calls
// loadEnvConfig varies by Next version: on next <= 15 the router server loads
// env itself (before spawning render workers), but on next 16 ONLY the render
// worker ever calls loadEnvConfig. The first process to install watchers claims
// ownership via this env var — child processes inherit it at spawn and skip,
// so we don't end up with multiple processes touching the trigger file.
const WATCHER_OWNER_ENV_KEY = '__VARLOCK_NEXT_ENV_WATCHER_PID';
function claimExtraFileWatcherOwnership(): boolean {
  const ownerPid = process.env[WATCHER_OWNER_ENV_KEY];
  if (ownerPid && ownerPid !== String(process.pid)) return false;
  process.env[WATCHER_OWNER_ENV_KEY] = String(process.pid);
  return true;
}

function formatChangedFilesSummary(paths: Array<string>): string {
  if (!paths.length) return 'no files';
  const displayPaths = paths.map((filePath) => {
    if (!rootDir) return filePath;
    const rel = path.relative(rootDir, filePath);
    return rel || filePath;
  });

  if (displayPaths.length === 1) return displayPaths[0];
  if (displayPaths.length <= 3) return displayPaths.join(', ');
  return `${displayPaths.slice(0, 3).join(', ')} +${displayPaths.length - 3} more`;
}

function consumePendingReloadSummary() {
  const files = [...pendingReloadFiles];
  pendingReloadFiles.clear();
  if (!files.length) return undefined;
  return formatChangedFilesSummary(files);
}

function getEnvFromNextCommand(dev: boolean): string {
  if (process.env.NODE_ENV === 'test') return 'test';
  return dev ? 'development' : 'production';
}

const NEXT_BIN_RE = /(^|[\\/])next([\\/]dist[\\/]bin[\\/]next)?(\.js)?$/;

/** whether this process is `next build` */
function isNextBuildCommand(): boolean {
  const [, bin, command] = process.argv;
  return command === 'build' && !!bin && NEXT_BIN_RE.test(bin);
}

/**
 * Whether this process is a production server booting a finished build: the standalone server
 * (which passes its config in `__NEXT_PRIVATE_STANDALONE_CONFIG`), `next start`, or a custom
 * server (`NODE_ENV=production node server.js` calling `next()`). A build and its workers, any
 * other `next` subcommand (lint, ...), and anything outside production (dev, `NODE_ENV=test`
 * under next/jest) are not, so they never boot from a build's output. The config plugin double-checks the boot against
 * the real build directory once Next's config is known (see checkFrozenBootSource).
 */
function isNextServerBoot(): boolean {
  // a build's own worker processes (compiler, page data, prerendering) inherit NODE_ENV and run
  // under a worker bootstrap argv - they carry the build's resolution and must never read the
  // output of a previous build
  if (
    process.env.__VARLOCK_NEXT_BUILD
    || process.env.NEXT_PRIVATE_BUILD_WORKER
    || process.env.NEXT_PHASE === 'phase-production-build'
  ) return false;
  if (process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) return true;
  const [, bin, command] = process.argv;
  if (bin && NEXT_BIN_RE.test(bin)) return command === 'start';
  return process.env.NODE_ENV === 'production';
}

function enableExtraFileWatchers(sources: SerializedEnvGraph['sources'], basePath?: string) {
  if (!rootDir) return;
  if (!claimExtraFileWatcherOwnership()) return;

  // Collect absolute paths of source files that Next.js does NOT already watch
  const nextWatchedAbsolute = new Set(NEXT_WATCHED_ENV_FILES.map((f) => path.join(rootDir!, f)));
  const extraFilePaths: Array<string> = [];
  for (const source of sources) {
    if (!source.enabled || !source.path) continue;
    const absPath = basePath ? path.resolve(basePath, source.path) : path.resolve(rootDir!, source.path);
    if (nextWatchedAbsolute.has(absPath) || watchedExtraFiles.has(absPath)) continue;
    if (isExistingNonRegularFile(absPath)) {
      // watching a FIFO/pipe is meaningless (stat churns on every read/serve)
      warnNonRegularSourceOnce(absPath);
      continue;
    }
    extraFilePaths.push(absPath);
  }
  // Also always watch .env.schema even if it wasn't in sources (it may not exist yet)
  const envSchemaPath = path.join(rootDir!, '.env.schema');
  if (!nextWatchedAbsolute.has(envSchemaPath) && !watchedExtraFiles.has(envSchemaPath)) {
    extraFilePaths.push(envSchemaPath);
  }

  if (!extraFilePaths.length) return;

  // Find a Next-watched file to touch as the reload trigger.
  // Prefer an existing regular file (cheaper) — a FIFO/pipe must never be
  // written to (it would block and interfere with whatever serves it).
  // Otherwise we'll create+destroy the first watched name that doesn't exist.
  let triggerFilePath: string | null = null;
  let mustDestroyTriggerFile = false;
  for (const envFileName of NEXT_WATCHED_ENV_FILES) {
    const filePath = path.join(rootDir!, envFileName);
    if (fs.existsSync(filePath) && !isExistingNonRegularFile(filePath)) {
      triggerFilePath = filePath;
      break;
    }
  }
  if (!triggerFilePath) {
    for (const envFileName of NEXT_WATCHED_ENV_FILES) {
      const filePath = path.join(rootDir!, envFileName);
      if (!fs.existsSync(filePath)) {
        triggerFilePath = filePath;
        mustDestroyTriggerFile = true;
        break;
      }
    }
  }
  if (!triggerFilePath) {
    // all Next-watched env files exist but none are regular files — nothing we
    // can safely touch to trigger a reload, so skip installing watchers
    debug('no usable reload trigger file, skipping extra file watchers');
    return;
  }

  const pendingWatchChanges = new Set<string>();
  const watchedFileHashes = new Map<string, string | undefined>();
  const watchStabilityRetries = new Map<string, number>();
  let debounceTimeout: ReturnType<typeof setTimeout> | undefined;
  const DEBOUNCE_MS = 300;
  const MAX_STABILITY_RETRIES = 5;

  function processPendingWatchChanges() {
    const changedPaths = [...pendingWatchChanges];
    pendingWatchChanges.clear();
    if (!changedPaths.length) return;
    debug('processing watch changes', changedPaths);

    const changedByContent: Array<string> = [];
    const unstablePaths: Array<string> = [];
    for (const filePath of changedPaths) {
      const prev = watchedFileHashes.get(filePath);
      const next = readFileHash(filePath);
      debug(
        'watch hash compare',
        filePath,
        `prev=${debugHash(prev)}`,
        `next=${debugHash(next)}`,
      );

      // During editor saves the target file may briefly disappear/be unreadable.
      // Defer evaluation until file state stabilizes to avoid false-positive reloads.
      if (next === undefined && prev !== undefined) {
        const retryCount = (watchStabilityRetries.get(filePath) || 0) + 1;
        if (retryCount <= MAX_STABILITY_RETRIES) {
          watchStabilityRetries.set(filePath, retryCount);
          unstablePaths.push(filePath);
          debug('watch state unstable, retrying', filePath, `(attempt ${retryCount}/${MAX_STABILITY_RETRIES})`);
          continue;
        }
      }

      watchStabilityRetries.delete(filePath);
      watchedFileHashes.set(filePath, next);
      if (next !== prev) changedByContent.push(filePath);
    }

    if (unstablePaths.length) {
      for (const filePath of unstablePaths) pendingWatchChanges.add(filePath);
      if (debounceTimeout) clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(processPendingWatchChanges, DEBOUNCE_MS);
    }

    if (!changedByContent.length) {
      // If all paths are still stabilizing, wait for the next pass before logging.
      if (unstablePaths.length === changedPaths.length) return;
      const summary = formatChangedFilesSummary(changedPaths);
      logUserInfo(`ℹ️ [varlock] change detected in ${summary}; file contents unchanged, skipping next reload.`);
      return;
    }

    for (const changed of changedByContent) pendingReloadFiles.add(changed);
    debug('extra file changed, triggering reload:', changedByContent);
    if (mustDestroyTriggerFile) {
      fs.writeFileSync(triggerFilePath!, [
        '# This file was created by @varlock/nextjs-integration',
        '# It is used to trigger Next.js to reload when non-standard .env files change',
        '# You can safely ignore and delete it',
        '# @disable',
        '# ---',
      ].join('\n'), 'utf-8');
      setTimeout(() => {
        // eslint-disable-next-line
        try { fs.unlinkSync(triggerFilePath!); } catch { /* may already be gone */ }
      }, 1000);
    } else {
      const currentContents = fs.readFileSync(triggerFilePath!, 'utf-8');
      fs.writeFileSync(triggerFilePath!, currentContents, 'utf-8');
    }
  }

  function triggerNextReload(changedPath: string) {
    debug('watch event', changedPath);
    pendingWatchChanges.add(changedPath);
    if (debounceTimeout) clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(processPendingWatchChanges, DEBOUNCE_MS);
  }

  debug('setting up extra file watchers for:', extraFilePaths);
  for (const filePath of extraFilePaths) {
    watchedExtraFiles.add(filePath);
    watchedFileHashes.set(filePath, readFileHash(filePath));
    fs.watchFile(filePath, { interval: 500 }, () => {
      triggerNextReload(filePath);
    });
  }
}

// - these methods are the same as the original module -----------------

export function updateInitialEnv(newEnv: Env) {
  if (!Object.keys(newEnv).length) return;
  debug('updateInitialEnv', newEnv);
  // Only merge keys that were already in initialEnv or are Next.js internal vars.
  // Varlock-managed keys injected into process.env by initVarlockEnv should NOT
  // pollute initialEnv — otherwise they get treated as process.env overrides on reload.
  for (const [key, value] of Object.entries(newEnv)) {
    if (key in (initialEnv || {}) || key.startsWith('__NEXT')) {
      (initialEnv || {})[key] = value;
    }
  }
}

type Log = {
  info: (...args: Array<any>) => void
  error: (...args: Array<any>) => void
};

function replaceProcessEnv(sourceEnv: Env) {
  Object.keys(process.env).forEach((key) => {
    // Allow mutating internal Next.js env variables after the server has initiated.
    // This is necessary for dynamic things like the IPC server port.
    // Also preserve varlock's own control flags (watcher ownership, dedupe markers)
    // which are set after the initialEnv snapshot was taken.
    if (!key.startsWith('__NEXT_PRIVATE') && !key.startsWith('__VARLOCK_NEXT_')) {
      if (sourceEnv[key] === undefined || sourceEnv[key] === '') {
        delete process.env[key];
      }
    }
  });

  Object.entries(sourceEnv).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

// in original module, but does not appear to be used
export function processEnv(
  _loadedEnvFiles: LoadedEnvFiles,
  _dir?: string,
  _log: Log = console,
  _forceReload = false,
  _onReload?: (envFilePath: string) => void,
) {
  return [process.env];
}

export function resetEnv() {
  if (initialEnv) {
    replaceProcessEnv(initialEnv);
  }
}

type LoadedEnvConfig = {
  combinedEnv: Env
  parsedEnv: Env | undefined
  loadedEnvFiles: LoadedEnvFiles
};

/**
 * The frozen env of the build this server is booting, if it froze its env into the bundle (see
 * freeze-into-bundle), read from the next config recorded in the build output: the standalone
 * server passes it in `__NEXT_PRIVATE_STANDALONE_CONFIG`, `next start` reads
 * `.next/required-server-files.json` (a custom distDir is caught later by the config plugin).
 * `null` when the build did not freeze, `undefined` when the build output cannot be read.
 */
function readFrozenBuildEnv(dir: string): string | null | undefined {
  try {
    let config: { env?: Record<string, string> } | undefined;
    let source: string;
    if (process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
      config = JSON.parse(process.env.__NEXT_PRIVATE_STANDALONE_CONFIG);
      source = STANDALONE_CONFIG_SOURCE;
    } else {
      source = path.resolve(dir, '.next', 'required-server-files.json');
      if (!fs.existsSync(source)) return undefined;
      config = JSON.parse(fs.readFileSync(source, 'utf8')).config;
    }
    if (!config) return undefined;
    const frozenEnv = config.env?.[FROZEN_BUILD_ENV_KEY] ?? null;
    // lets the config plugin check this was the build actually being served
    if (frozenEnv) process.env[FROZEN_BOOT_SOURCE_ENV_KEY] = source;
    return frozenEnv;
  } catch {
    return undefined;
  }
}

let frozenBootResult: LoadedEnvConfig | undefined;
/**
 * Boot a server from the env its build froze into the bundle: it is the only source, so
 * nothing is resolved, and any `__VARLOCK_ENV` from the environment is ignored. Booting here
 * (rather than leaving it to the server runtime, which boots from the same frozen env) makes
 * it available to everything in the server process, `next.config` included.
 */
function bootFromFrozenBuildEnv(frozenEnv: string): LoadedEnvConfig {
  if (frozenBootResult) return frozenBootResult;
  debug('booting from the env frozen into the build');

  let frozenJson = frozenEnv;
  if (isEncryptedBlob(frozenEnv)) {
    const key = process.env._VARLOCK_ENV_KEY;
    if (!key) {
      // eslint-disable-next-line no-console
      console.error([
        '',
        '🚨 [varlock] this build\'s env is frozen and encrypted, but _VARLOCK_ENV_KEY is not set 🚨',
        'Set _VARLOCK_ENV_KEY at runtime to the key that was set when building.',
        '',
      ].join('\n'));
      process.exit(1);
    }
    frozenJson = decryptEnvBlobSync(frozenEnv, key);
  }
  varlockLoadedEnv = JSON.parse(frozenJson);

  // a child process of this server inherits this same frozen env, already decrypted
  const ambientEnv = initialEnv?.__VARLOCK_ENV;
  const { freezeId } = varlockLoadedEnv as { freezeId?: string };
  if (ambientEnv && !(freezeId && ambientEnv.includes(`"freezeId":"${freezeId}"`))) {
    // eslint-disable-next-line no-console
    console.warn('[varlock] ⚠️ this build has its env frozen into the bundle, so the __VARLOCK_ENV set in the environment is ignored.');
  }

  // applies boot-time values for `@dynamic=boot` items during init. If a serverless file trace
  // left it out, the server runtime applies them instead: its prelude carries the same bundle.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('varlock/frozen-env-boot');
  } catch (err) {
    debug('varlock/frozen-env-boot unavailable - boot values are applied by the server runtime', err);
  }
  process.env.__VARLOCK_ENV = frozenJson;
  initVarlockEnv();
  varlockPatchConsole.patchGlobalConsole();
  varlockPatchConsole.patchProcessStreams?.();

  parsedEnv = {};
  for (const itemKey of Object.keys(varlockLoadedEnv.config)) parsedEnv[itemKey] = process.env[itemKey];
  frozenBootResult = { combinedEnv: { ...process.env }, parsedEnv, loadedEnvFiles: [] };
  // nothing is ever reloaded here, so the frozen env is the state to restore to
  initialEnv = { ...process.env };
  return frozenBootResult;
}

let loadCount = 0;
let suppressSkipLogUntil = 0;

export function loadEnvConfig(
  dir: string,
  dev?: boolean,
  _log: Log = console,
  forceReload = false,
  _onReload?: (envFilePath: string) => void,
): LoadedEnvConfig {
  // store actual process.env so we can restore it later
  initialEnv ||= { ...process.env };

  // A server booting a build that froze its env into the bundle does not resolve: the frozen
  // env is the only source (see freeze-into-bundle)
  const isBuild = !dev && isNextBuildCommand();
  if (isBuild) process.env.__VARLOCK_NEXT_BUILD = '1';
  // where Next resolves the build directory from (see checkFrozenBootSource)
  if (!dev) process.env.__VARLOCK_NEXT_PROJECT_DIR = dir;
  const frozenBuildEnv = !dev && isNextServerBoot() ? readFrozenBuildEnv(dir) : undefined;
  if (frozenBuildEnv) return bootFromFrozenBuildEnv(frozenBuildEnv);

  loadCount++;
  debug('loadEnvConfig!', { forceReload, loadCount, dev });
  const reloadSummary = forceReload ? consumePendingReloadSummary() : undefined;
  const effectiveReloadSummary = forceReload ? (reloadSummary || 'an env source file') : undefined;

  // onReload is used to show a log of which .env file changed
  // TODO: add similar log to show which env file changed

  rootDir ||= dir;
  if (rootDir !== dir) throw new Error('root directory changed');

  // Always watch .env.schema early — even before the first successful load —
  // so that if the load fails (e.g. validation error), the user can fix the
  // schema and have the dev server automatically retry without a restart.
  if (dev) enableExtraFileWatchers([], undefined);

  // Hydrate cached env metadata as early as possible so forceReload decisions
  // can use source-state hashing even in fresh worker processes.
  if (!varlockLoadedEnv && process.env.__VARLOCK_ENV) {
    try {
      varlockLoadedEnv = JSON.parse(process.env.__VARLOCK_ENV);
    } catch {
      // ignore parse failure; fallback path will perform a full reload
    }
  }
  if (!lastLoadedSourceStateHash && varlockLoadedEnv) {
    lastLoadedSourceStateHash = computeSourceStateHash(varlockLoadedEnv.sources, varlockLoadedEnv.basePath);
  }

  let useCachedEnv = !!process.env.__VARLOCK_ENV;
  if (forceReload) {
    // Throttle reloads to at most once per second to avoid spinning during
    // rapid file-change bursts (Next.js may fire multiple events per edit)
    if (!lastReloadAt || lastReloadAt.getTime() < Date.now() - 1000) {
      lastReloadAt = new Date();
      useCachedEnv = false;
    } else {
      debug('forceReload requested but throttled (within 1s window)');
    }
  }

  if (forceReload && varlockLoadedEnv && lastLoadedSourceStateHash) {
    const currentSourceStateHash = computeSourceStateHash(varlockLoadedEnv.sources, varlockLoadedEnv.basePath);
    debug(
      'source state hash compare',
      `prev=${debugHash(lastLoadedSourceStateHash)}`,
      `next=${debugHash(currentSourceStateHash)}`,
    );
    if (currentSourceStateHash && currentSourceStateHash === lastLoadedSourceStateHash) {
      useCachedEnv = true;
      if (loadCount >= 2 && effectiveReloadSummary) {
        if (!reloadSummary && nextWatchedEnvFilesIncludeNonRegular()) {
          // event came from Next's own watcher (not one of our tracked files) and
          // a natively-watched env file is a FIFO — it's just churn from the pipe
          // being read, not a user edit
          debug('suppressing skip log for non-regular file watch churn');
        } else if (Date.now() >= suppressSkipLogUntil) {
          logUserInfo(`ℹ️ [varlock] change detected in ${effectiveReloadSummary}; file contents unchanged, skipping reload.`);
        } else {
          debug('suppressing immediate follow-up skip log');
        }
      }
    }
  }

  if (useCachedEnv) {
    if (!varlockLoadedEnv) {
      varlockLoadedEnv = JSON.parse(process.env.__VARLOCK_ENV || '{}');
      parsedEnv = Object.fromEntries(
        Object.entries(varlockLoadedEnv.config).map(([key, value]) => [key, value.value]),
      );

      resetRedactionMap(varlockLoadedEnv);
      debug('patching console with varlock redactor');
      varlockPatchConsole.patchGlobalConsole();
      varlockPatchConsole.patchProcessStreams?.();
      lastLoadedSourceStateHash = computeSourceStateHash(varlockLoadedEnv.sources, varlockLoadedEnv.basePath);
    }

    combinedEnv = { ...initialEnv, ...parsedEnv };

    if (dev) enableExtraFileWatchers(varlockLoadedEnv.sources, varlockLoadedEnv.basePath);

    debug('>> USING CACHED ENV');

    return { combinedEnv, parsedEnv, loadedEnvFiles };
  }

  lastReloadAt = new Date();
  const previousEnvKey = envComparisonKey(process.env.__VARLOCK_ENV);

  debug('>> RELOADING ENV');
  replaceProcessEnv(initialEnv);

  // we must match @next/env default behaviour for which .env.XXX files to load
  // which is based on the current command (`next dev` vs `next build`) and `NODE_ENV=test`
  // however we will pass it through and let the user ignore it by setting their own `@currentEnv`
  const envFromNextCommand = getEnvFromNextCommand(!!dev);
  debug('Inferred env mode (to match @next/env):', envFromNextCommand);

  try {
    // strip DEBUG_VARLOCK from env to prevent debug output from contaminating JSON stdout
    const cleanEnv = { ...initialEnv };
    delete cleanEnv.DEBUG_VARLOCK;
    // a build may freeze its output, so it resolves the way `varlock freeze` does: a required
    // `@dynamic=boot` item may be unset, since its value arrives at boot
    const buildFlags = isBuild ? ' --defer-boot-required' : '';
    const { stdout } = execSyncVarlock(`load --format json-full --env ${envFromNextCommand}${buildFlags}`, {
      fullResult: true,
      env: cleanEnv as any,
      cwd: rootDir || dir,
      integrationTelemetry: {
        name: __VARLOCK_INTEGRATION_NAME__,
        version: __VARLOCK_INTEGRATION_VERSION__,
      },
    });
    // The load itself reads every source file — for FIFO-backed sources (e.g.
    // 1Password Environments) that read makes the pipe get re-served, firing
    // new fs events. Suppress the "unchanged, skipping" log those immediate
    // follow-up events would produce.
    suppressSkipLogUntil = Date.now() + 1200;
    if (loadCount >= 2 && forceReload) {
      const freshEnvKey = envComparisonKey(stdout);
      // an unparseable key on either side means we can't tell, so report a change
      const envChanged = !freshEnvKey || !previousEnvKey || freshEnvKey !== previousEnvKey;
      if (effectiveReloadSummary) {
        if (envChanged) {
          logUserInfo(`✅ [varlock] change detected in ${effectiveReloadSummary}; reloaded env, changes found.`);
        } else {
          logUserInfo(`✅ [varlock] change detected in ${effectiveReloadSummary}; reloaded env, no changes found.`);
        }
      }
    } else if (loadCount >= 2) {
      debug('reload occurred without forceReload (likely Next-triggered reload path)');
      debug('emitting success banner', {
        pid: process.pid,
        loadCount,
        forceReload,
        isWorker: IS_WORKER,
      });
      logUserInfo('✅ [varlock] env reloaded and validated');
    }
    varlockLoadedEnv = JSON.parse(stdout);
  } catch (err) {
    if ((err as any).message.includes('Unable to find varlock executable')) {
      // A server booting a build whose env was not frozen has nothing to boot from: fail
      // before the server listens, with the fixes. When the build output cannot tell us (e.g.
      // a custom distDir), defer to the runtime, which fails on the first request instead if
      // nothing supplies the env.
      if (!dev && !isBuild) {
        if (frozenBuildEnv === null) {
          // eslint-disable-next-line no-console
          console.error(NOT_FROZEN_BOOT_HINT);
          process.exit(1);
        }
        debug('varlock binary not found - deferring to init bundle');
        return { combinedEnv: { ...initialEnv }, parsedEnv: {}, loadedEnvFiles: [] };
      }
      // eslint-disable-next-line no-console
      console.error([
        '',
        '❌ ERROR: varlock not found',
        'varlock is a required peer dependency of @varlock/nextjs-integration',
        '',
        'Please add varlock as a dependency to your project (e.g., `npm install varlock`)',
      ].join('\n'));
      process.exit(1);
    }

    // The CLI writes pretty-formatted errors to stderr and JSON to stdout (even on failure).
    // Pipe stderr through so the user sees the nice error output, and parse stdout
    // for structured data (sources for file watching, etc.)
    if (err instanceof VarlockExecError) {
      if (err.stderr) process.stderr.write(err.stderr);
      // A crashed CLI (native abort, signal) may leave stderr empty, so also print the
      // diagnostic message carrying the command and original exit status.
      if (err.crashed || !err.stderr) process.stderr.write(`\n${err.message}\n`);

      if (err.stdout) {
        try {
          varlockLoadedEnv = JSON.parse(err.stdout);
        } catch { /* stdout not parseable — hard failure */ }
      }
    }

    if (forceReload) {
      const summary = effectiveReloadSummary || 'an env source file';
      logUserError(`\n[varlock] change detected in ${summary}; reload failed.`);
    }
    logUserError('\n[varlock] ⚠️ fix the error(s) above and save to reload\n');

    // In a build, we want to fail hard so broken env doesn't get deployed
    if (!dev) {
      // never forward a native crash status (e.g. 0xC0000409) as the build's exit code
      process.exit(err instanceof VarlockExecError && err.crashed ? 1 : (err as any).exitCode ?? 1);
    }

    // Reset process.env to initial state so stale values from a previous
    // successful load don't persist (Next.js reads process.env directly for SSR)
    replaceProcessEnv(initialEnv);

    // Set __VARLOCK_ENV with error details so the ENV proxy knows config is
    // invalid (throws a clear error) and file watchers can be set up.
    process.env.__VARLOCK_ENV = JSON.stringify(varlockLoadedEnv || {
      sources: [],
      config: {},
      settings: {},
      errors: { root: ['failed to load env'] },
    });

    if (dev && varlockLoadedEnv) {
      enableExtraFileWatchers(varlockLoadedEnv.sources, varlockLoadedEnv.basePath);
    }

    return { combinedEnv: { ...initialEnv }, parsedEnv: {}, loadedEnvFiles: [] };
  }

  parsedEnv = {};
  for (const [itemKey, itemInfo] of Object.entries(varlockLoadedEnv.config)) {
    parsedEnv[itemKey] = itemInfo.value;
  }
  debug('LOADED ENV:', parsedEnv);
  process.env.__VARLOCK_ENV = JSON.stringify(varlockLoadedEnv);
  initVarlockEnv(); // calling this will set process.env vars

  resetRedactionMap(varlockLoadedEnv);
  debug('patching console with varlock redactor');
  varlockPatchConsole.patchGlobalConsole();
  varlockPatchConsole.patchProcessStreams?.();

  combinedEnv = { ...initialEnv, ...parsedEnv };
  loadedEnvFiles = getVarlockSourcesAsLoadedEnvFiles();
  lastLoadedSourceStateHash = computeSourceStateHash(varlockLoadedEnv.sources, varlockLoadedEnv.basePath);

  // Set up watchers for source files that Next.js doesn't natively watch.
  // Called after every reload so newly-added sources get watched too.
  if (dev) enableExtraFileWatchers(varlockLoadedEnv.sources, varlockLoadedEnv.basePath);

  return { combinedEnv, parsedEnv, loadedEnvFiles };
}
