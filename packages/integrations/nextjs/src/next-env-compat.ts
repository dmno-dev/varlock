/**
 * Drop-in replacement for @next/env that uses varlock instead of dotenv
 *
 * This must be the default export of the module, and it must stay compatible with @next/env
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, type spawnSync } from 'child_process';
import { VarlockRedactor, resetRedactionMap, type SerializedEnvGraph } from 'varlock';

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

// @next/env exports this info and currently it is only used to display
// a list of filenames loaded, for example: `Environments: .env, .env.development`
function getVarlockSourcesAsLoadedEnvFiles(): LoadedEnvFiles {
  const envFiles = varlockLoadedEnv.sources
    .filter((s) => s.enabled && s.label !== 'process.env')
    .map((s) => ({
      path: s.label,
      contents: '',
      env: {},
    }));
  if (envFiles.length) {
    // this adds an additional line, below the list of files
    envFiles.push({ path: '\n                   ✨ loaded by varlock ✨', contents: '', env: {} });
  }
  return envFiles;
}

const IS_WORKER = !!process.env.NEXT_PRIVATE_WORKER;
function debug(...args: Array<any>) {
  if (!process.env.DEBUG_VARLOCK_NEXT_INTEGRATION) return;
  console.log(
    IS_WORKER ? 'worker -- ' : 'server -- ',
    ...args,
  );
}
debug('✨ LOADED @next/env module!');


// Next.js only watches .env, .env.local, .env.development, .env.development.local
// but we want to trigger reloads when .env.schema changes
// so we set up an extra watcher, and trigger no-op changes to one of those files
let extraWatcherEnabled = false;
const NEXT_WATCHED_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];
function enableExtraFileWatchers(dir: string) {
  if (extraWatcherEnabled || IS_WORKER) return;
  extraWatcherEnabled = true;

  const envSchemaPath = path.join(dir, '.env.schema');
  // its faster to update an existing file, so we check if the user has any
  // otherwise we can create and destroy
  let envFilePathToUpdate: string | null = null;
  for (const envFileName of NEXT_WATCHED_ENV_FILES) {
    const filePath = path.join(dir, envFileName);
    if (fs.existsSync(filePath)) {
      envFilePathToUpdate = filePath;
      break;
    }
  }
  let destroyFile = false;
  if (!envFilePathToUpdate) {
    envFilePathToUpdate ||= path.join(dir, '.env');
    destroyFile = true;
  }

  debug('set up extra file watchers', envFilePathToUpdate, destroyFile);

  fs.watchFile(envSchemaPath, { interval: 500 }, (curr, prev) => {
    if (destroyFile) {
      fs.writeFileSync(envFilePathToUpdate, '# trigger reload', 'utf-8');
      setTimeout(() => {
        fs.unlinkSync(envFilePathToUpdate);
      }, 500);
    } else {
      const currentContents = fs.readFileSync(envFilePathToUpdate, 'utf-8');
      fs.writeFileSync(envFilePathToUpdate, currentContents, 'utf-8');
    }
  });
}




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

export function loadEnvConfig(
  dir: string,
  dev?: boolean,
  log: Log = console,
  forceReload = false,
  onReload?: (envFilePath: string) => void,
): {
    combinedEnv: Env
    parsedEnv: Env | undefined
    loadedEnvFiles: LoadedEnvFiles
  } {
  if (!initialEnv) {
    initialEnv ||= { ...process.env };
  }
  debug('loadEnvConfig!', 'forceReload = ', forceReload);
  // Reload, 'dir = ', dir, 'dev = ', dev, 'onReload = ', onReload);

  if (dev) enableExtraFileWatchers(dir);

  let useCachedEnv = !!process.env.__VARLOCK_ENV;
  if (forceReload) {
    if (!lastReloadAt) {
      lastReloadAt = new Date();
    } else if (lastReloadAt.getTime() < Date.now() - 1000) {
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
      VarlockRedactor.patchConsole();
    }

    combinedEnv = { ...initialEnv, ...parsedEnv };

    debug('>> USING CACHED ENV');

    return { combinedEnv, parsedEnv, loadedEnvFiles };
  }

  lastReloadAt = new Date();

  debug('>> RELOADING ENV');

  // // // only reload env when forceReload is specified
  // if (combinedEnv && !forceReload) {
  //   return { combinedEnv, parsedEnv, loadedEnvFiles: cachedLoadedEnvFiles };
  // }

  // track that we've already loaded the env
  process.env.__VARLOCK_ENV_LOADED = '1';

  replaceProcessEnv(initialEnv);
  // previousLoadedEnvFiles = cachedLoadedEnvFiles;
  // cachedLoadedEnvFiles = [];

  const isTest = process.env.NODE_ENV === 'test';
  let mode = dev ? 'development' : 'production';
  if (isTest) mode = 'test';

  // hack to automatically set our env flag the same way next is doing
  initialEnv._NEXT_ENV_MODE = mode;
  const envFlagFromMode = mode;
  // TODO: pass through envFlagFromMode as cli flag to varlock?

  try {
    const varlockLoadedEnvBuf = execSync('varlock load --format json-full', {
      env: initialEnv as any,
    });
    varlockLoadedEnv = JSON.parse(varlockLoadedEnvBuf.toString());
  } catch (err) {
    const { status, stdout, stderr } = err as ReturnType<typeof spawnSync>;
    console.error(stdout.toString());
    console.error(stderr.toString());

    if (!dev) {
      process.exit(1);
    }

    return { combinedEnv: {}, parsedEnv: {}, loadedEnvFiles: [] };
  }

  resetRedactionMap(varlockLoadedEnv);
  debug('patching console with varlock redactor');
  VarlockRedactor.patchConsole();


  parsedEnv = {};
  const sensitiveValues = [];
  const sensitiveKeys = [];
  for (const [itemKey, itemInfo] of Object.entries(varlockLoadedEnv.config)) {
    parsedEnv[itemKey] = itemInfo.value;
    if (itemInfo.isSensitive) {
      sensitiveValues.push(itemInfo.value);
      sensitiveKeys.push(itemKey);
    }
  }

  combinedEnv = { ...initialEnv, ...parsedEnv };
  loadedEnvFiles = getVarlockSourcesAsLoadedEnvFiles();

  debug('LOADED ENV:', parsedEnv);

  for (const [key, value] of Object.entries(combinedEnv)) {
    if (value !== undefined) process.env[key] = String(value);
  }
  process.env.__VARLOCK_ENV = JSON.stringify(varlockLoadedEnv);
  process.env.__VARLOCK_SENSITIVE_VALS = JSON.stringify(sensitiveValues);
  process.env.__VARLOCK_SENSITIVE_KEYS = JSON.stringify(sensitiveKeys);

  return { combinedEnv, parsedEnv, loadedEnvFiles };
}
