/**
 * Drop-in replacement for @next/env that uses varlock instead of dotenv
 *
 * This must be the default export of the module, and it must stay compatible with @next/env
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { type SerializedEnvGraph } from 'varlock';
import { initVarlockEnv, resetRedactionMap } from 'varlock/env';
import { patchGlobalConsole } from 'varlock/patch-console';
import { execSyncVarlock, VarlockExecError } from 'varlock/exec-sync-varlock';

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

function readFileHash(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
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


// Next.js only watches a fixed set of .env files for changes. Varlock may load
// additional files (e.g. .env.schema, .env.staging, custom sources). We watch
// those extra files and trigger a reload by touching one of Next's watched files.
const NEXT_WATCHED_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];
const watchedExtraFiles = new Set<string>();
const pendingReloadFiles = new Set<string>();

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

function enableExtraFileWatchers(sources: SerializedEnvGraph['sources'], basePath?: string) {
  if (IS_WORKER || !rootDir) return;

  // Collect absolute paths of source files that Next.js does NOT already watch
  const nextWatchedAbsolute = new Set(NEXT_WATCHED_ENV_FILES.map((f) => path.join(rootDir!, f)));
  const extraFilePaths: Array<string> = [];
  for (const source of sources) {
    if (!source.enabled || !source.path) continue;
    const absPath = basePath ? path.resolve(basePath, source.path) : path.resolve(rootDir!, source.path);
    if (!nextWatchedAbsolute.has(absPath) && !watchedExtraFiles.has(absPath)) {
      extraFilePaths.push(absPath);
    }
  }
  // Also always watch .env.schema even if it wasn't in sources (it may not exist yet)
  const envSchemaPath = path.join(rootDir!, '.env.schema');
  if (!nextWatchedAbsolute.has(envSchemaPath) && !watchedExtraFiles.has(envSchemaPath)) {
    extraFilePaths.push(envSchemaPath);
  }

  if (!extraFilePaths.length) return;

  // Find a Next-watched file to touch as the reload trigger.
  // Prefer an existing file (cheaper), otherwise we'll create+destroy .env
  let triggerFilePath: string | null = null;
  for (const envFileName of NEXT_WATCHED_ENV_FILES) {
    const filePath = path.join(rootDir!, envFileName);
    if (fs.existsSync(filePath)) {
      triggerFilePath = filePath;
      break;
    }
  }
  const mustDestroyTriggerFile = !triggerFilePath;
  triggerFilePath ||= path.join(rootDir!, '.env');

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

function detectOpenNextCloudflareBuild() {
  try {
    // the above works if the build is happening within CI, but we may need to do this for local builds or other CI platforms
    // so we can try to detect if we are within an open-next build by looking at the process info

    // we will look at the process tree to try to determine if we are in a opennext build
    // process tree looks like:
    // - opennext-cloudflare build > npm run build > next build

    // get grandparent process id
    const pppid = parseInt(execSync(`ps -o ppid= -p ${process.ppid}`).toString().trim());
    // const processInfo = execSync('ps -p '+grandparentPid+' -o command');
    // output looks like
    // ---
    // COMMAND
    // node /.../node_modules/.bin/opennextjs-cloudflare build
    //
    // ---
    const commandName = execSync(`ps -p ${pppid} -o command`).toString().split('\n')[1];
    if (commandName.endsWith('.bin/opennextjs-cloudflare build')) {
      return true;
    }
  } catch (err) {
    // do nothing
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function writeResolvedEnvFile() {
  // things get complicated on platforms like vercel/cloudflare, they do some of their own magic to load env vars
  // our loader (this file) will run during the _build_ process, but not when the platform is handling server rendered requests
  // also opennext is needed to run outside of vercel, so that adds other changes
  // so we export an additional .env file which the platform itself will automatically load

  const dotEnvStrLines = [];
  for (const [itemKey, itemInfo] of Object.entries(varlockLoadedEnv.config)) {
    if (itemInfo.value !== undefined) dotEnvStrLines.push(`${itemKey}=${JSON.stringify(itemInfo.value)}`);
  }

  if (
    detectOpenNextCloudflareBuild()
    || process.env.VERCEL || process.env.WORKERS_CI || process.env._VARLOCK_EXPORT_RESOLVED_ENV_FILE
  ) {
    dotEnvStrLines.unshift(`
# 🛑 DO NOT CHECK THIS FILE INTO VERSION CONTROL 🛑
# This file was automatically generated by @varlock/nextjs-integration
# It contains a _fully resolved env_ to pass to platforms (ex: vercel, cloudflare, etc)
# that are doing their own magic when booting up nextjs in certain scenarios
#
# It likely contains sensitive config data and should be deleted after use
#
# @disable # tells varlock to ignore this file
# ---
  `);
    // this is the fully resolved env, which includes additional metadata about each item
    // our runtime code uses this to provide coerced values, redact sensitive values, etc
    dotEnvStrLines.push(`__VARLOCK_ENV=${JSON.stringify(varlockLoadedEnv)}`);

    let resolvedEnvFileName = '.env.production.local';
    if (process.env._VARLOCK_EXPORT_RESOLVED_ENV_FILE && !(['true', '1'].includes(process.env._VARLOCK_EXPORT_RESOLVED_ENV_FILE))) {
      resolvedEnvFileName = process.env._VARLOCK_EXPORT_RESOLVED_ENV_FILE;
    }
    if (!rootDir) throw new Error('expected rootDir to be set');
    const resolvedEnvFilePath = path.resolve(rootDir, resolvedEnvFileName);
    fs.writeFileSync(resolvedEnvFilePath, dotEnvStrLines.join('\n'), 'utf-8');
    debug('wrote resolved env file:', resolvedEnvFilePath);
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
    if (!key.startsWith('__NEXT_PRIVATE')) {
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

let loadCount = 0;
let suppressSkipLogUntil = 0;
let hasLoadedEnvInThisProcess = false;

export function loadEnvConfig(
  dir: string,
  dev?: boolean,
  _log: Log = console,
  forceReload = false,
  _onReload?: (envFilePath: string) => void,
): LoadedEnvConfig {
  // store actual process.env so we can restore it later
  initialEnv ||= { ...process.env };

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

  let useCachedEnv = !!process.env.__VARLOCK_ENV && hasLoadedEnvInThisProcess;
  if (!useCachedEnv && process.env.__VARLOCK_ENV && !hasLoadedEnvInThisProcess) {
    debug('ignoring inherited __VARLOCK_ENV cache on first process load');
  }
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
        if (Date.now() >= suppressSkipLogUntil) {
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
      patchGlobalConsole();
      lastLoadedSourceStateHash = computeSourceStateHash(varlockLoadedEnv.sources, varlockLoadedEnv.basePath);
    }

    combinedEnv = { ...initialEnv, ...parsedEnv };

    if (dev) enableExtraFileWatchers(varlockLoadedEnv.sources, varlockLoadedEnv.basePath);

    debug('>> USING CACHED ENV');
    hasLoadedEnvInThisProcess = true;

    return { combinedEnv, parsedEnv, loadedEnvFiles };
  }

  lastReloadAt = new Date();
  const previousSerializedEnv = process.env.__VARLOCK_ENV;

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
    const { stdout } = execSyncVarlock(`load --format json-full --env ${envFromNextCommand}`, {
      fullResult: true,
      env: cleanEnv as any,
      cwd: rootDir || dir,
    });
    if (loadCount >= 2 && forceReload) {
      const envChanged = stdout !== previousSerializedEnv;
      if (effectiveReloadSummary) {
        if (envChanged) {
          suppressSkipLogUntil = Date.now() + 1200;
          logUserInfo(`✅ [varlock] change detected in ${effectiveReloadSummary}; reloaded env, changes found.`);
        } else {
          suppressSkipLogUntil = Date.now() + 1200;
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
      // In production the binary may not exist — e.g., on serverless platforms
      // where only traced files are included. The init bundle injected into the
      // webpack/turbopack runtime will set process.env.__VARLOCK_ENV with inlined
      // env data when the bundled server loads.
      // See: https://github.com/dmno-dev/varlock/issues/584
      if (!dev) {
        debug('varlock binary not found — deferring to init bundle');
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
      process.exit((err as any).exitCode ?? 1);
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

    hasLoadedEnvInThisProcess = true;

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
  patchGlobalConsole();

  combinedEnv = { ...initialEnv, ...parsedEnv };
  loadedEnvFiles = getVarlockSourcesAsLoadedEnvFiles();
  lastLoadedSourceStateHash = computeSourceStateHash(varlockLoadedEnv.sources, varlockLoadedEnv.basePath);

  // Set up watchers for source files that Next.js doesn't natively watch.
  // Called after every reload so newly-added sources get watched too.
  if (dev) enableExtraFileWatchers(varlockLoadedEnv.sources, varlockLoadedEnv.basePath);

  // write a resolved .env file for platforms like Vercel/Cloudflare that need
  // pre-resolved env values at runtime (they don't re-run @next/env on boot)
  // TODO: re-enable once we verify instrumentation approach works for prod
  // if (!dev) writeResolvedEnvFile();
  hasLoadedEnvInThisProcess = true;

  return { combinedEnv, parsedEnv, loadedEnvFiles };
}
