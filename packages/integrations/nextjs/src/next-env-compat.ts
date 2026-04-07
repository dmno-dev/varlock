/**
 * Drop-in replacement for @next/env that uses varlock instead of dotenv
 *
 * This must be the default export of the module, and it must stay compatible with @next/env
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { type SerializedEnvGraph } from 'varlock';
import { initVarlockEnv, resetRedactionMap } from 'varlock/env';
import { patchGlobalConsole } from 'varlock/patch-console';
import { execSyncVarlock } from 'varlock/exec-sync-varlock';

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


// Next.js only watches a fixed set of .env files for changes. Varlock may load
// additional files (e.g. .env.schema, .env.staging, custom sources). We watch
// those extra files and trigger a reload by touching one of Next's watched files.
const NEXT_WATCHED_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];
const watchedExtraFiles = new Set<string>();

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

  function triggerNextReload(changedPath: string) {
    debug('extra file changed, triggering reload:', changedPath);
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

  debug('setting up extra file watchers for:', extraFilePaths);
  for (const filePath of extraFilePaths) {
    watchedExtraFiles.add(filePath);
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
  if (Object.keys(newEnv).length) {
    debug('updateInitialEnv', newEnv);
    Object.assign(initialEnv || {}, newEnv);
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
  debug('loadEnvConfig!', 'forceReload = ', forceReload);

  // onReload is used to show a log of which .env file changed
  // TODO: add similar log to show which env file changed

  rootDir ||= dir;
  if (rootDir !== dir) throw new Error('root directory changed');

  // Always watch .env.schema early — even before the first successful load —
  // so that if the load fails (e.g. validation error), the user can fix the
  // schema and have the dev server automatically retry without a restart.
  if (dev) enableExtraFileWatchers([], undefined);

  let useCachedEnv = !!process.env.__VARLOCK_ENV;
  if (forceReload) {
    // Throttle reloads to at most once per second to avoid spinning during
    // rapid file-change bursts (Next.js may fire multiple events per edit)
    if (!lastReloadAt || lastReloadAt.getTime() < Date.now() - 1000) {
      lastReloadAt = new Date();
      useCachedEnv = false;
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
    }

    combinedEnv = { ...initialEnv, ...parsedEnv };

    if (dev) enableExtraFileWatchers(varlockLoadedEnv.sources, varlockLoadedEnv.basePath);

    debug('>> USING CACHED ENV');

    return { combinedEnv, parsedEnv, loadedEnvFiles };
  }

  lastReloadAt = new Date();

  debug('>> RELOADING ENV');
  replaceProcessEnv(initialEnv);

  // we must match @next/env default behaviour for which .env.XXX files to load
  // which is based on the current command (`next dev` vs `next build`) and `NODE_ENV=test`
  // however we will pass it through and let the user ignore it by setting their own `@currentEnv`
  let envFromNextCommand = dev ? 'development' : 'production';
  if (process.env.NODE_ENV === 'test') envFromNextCommand = 'test';
  debug('Inferred env mode (to match @next/env):', envFromNextCommand);

  try {
    // strip DEBUG_VARLOCK from env to prevent debug output from contaminating JSON stdout
    const cleanEnv = { ...initialEnv };
    delete cleanEnv.DEBUG_VARLOCK;
    const varlockLoadedEnvStr = execSyncVarlock(`load --format json-full --env ${envFromNextCommand}`, {
      showLogsOnError: true,
      // in a build, we want to fail and exit, while in dev we can keep retrying when changes are detected
      exitOnError: !dev,
      env: cleanEnv as any,
    });
    if (loadCount >= 2) {
      // eslint-disable-next-line no-console
      console.log('✅ env reloaded and validated');
    }
    varlockLoadedEnv = JSON.parse(varlockLoadedEnvStr);
  } catch (err) {
    // this error message comes from execSyncVarlock when it cannot find varlock
    if ((err as any).message.includes('Unable to find varlock executable')) {
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

    // showLogsOnError already printed the formatted CLI output above,
    // so we only add a short note here (err.message duplicates stderr)
    // eslint-disable-next-line no-console
    console.error('[varlock] ⚠️ failed to load env — see error above');

    // if we dont do this, we'll see an error that looks like `process.env.__VARLOCK_ENV is not set` which is misleading.
    // Ideally we would pass through an error of some kind and trigger the webpack runtime error popup
    process.env.__VARLOCK_ENV = JSON.stringify({
      sources: [],
      config: {},
      settings: {},
    });

    return { combinedEnv: {}, parsedEnv: {}, loadedEnvFiles: [] };
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

  // Set up watchers for source files that Next.js doesn't natively watch.
  // Called after every reload so newly-added sources get watched too.
  if (dev) enableExtraFileWatchers(varlockLoadedEnv.sources, varlockLoadedEnv.basePath);

  // write a resolved .env file for platforms like Vercel/Cloudflare that need
  // pre-resolved env values at runtime (they don't re-run @next/env on boot)
  // TODO: re-enable once we verify instrumentation approach works for prod
  // if (!dev) writeResolvedEnvFile();

  return { combinedEnv, parsedEnv, loadedEnvFiles };
}
