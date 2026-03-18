import path from 'node:path';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathExistsSync } from '@env-spec/utils/fs-utils';
import { createDebug } from './debug';

const debug = createDebug('varlock:workspace-utils');

export type JsPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno';

export type JsPackageManagerMeta = {
  name: JsPackageManager;
  lockfiles: Array<string>;
  add: string;
  exec: string;
  dlx: string;
};

export const JS_PACKAGE_MANAGERS: Record<JsPackageManager, JsPackageManagerMeta> = Object.freeze({
  npm: {
    name: 'npm',
    lockfiles: ['package-lock.json'],
    add: 'npm install', // add also works
    exec: 'npm exec --',
    dlx: 'npx',
  },
  pnpm: {
    name: 'pnpm',
    lockfiles: ['pnpm-lock.yaml'],
    add: 'pnpm add',
    exec: 'pnpm exec',
    dlx: 'pnpm dlx',
  },
  yarn: {
    name: 'yarn',
    lockfiles: ['yarn.lock'],
    add: 'yarn add',
    exec: 'yarn exec --',
    dlx: 'yarn dlx',
  },
  bun: {
    name: 'bun',
    lockfiles: ['bun.lock', 'bun.lockb'],
    add: 'bun add',
    exec: 'bun run',
    dlx: 'bunx',
  },
  deno: { //! deno not fully supported yet
    name: 'deno',
    lockfiles: ['deno.lock'],
    add: 'deno add',
    // TODO: don't think these are quite right...
    exec: 'deno run',
    dlx: 'deno run',
  },
});

export type MonorepoTool = 'turborepo' | 'nx' | 'lerna';

export type WorkspaceInfo = {
  /** detected JS package manager */
  packageManager: JsPackageManagerMeta;
  /** path to the workspace/monorepo root (where lockfile was found) */
  rootPath: string;
  /** whether this appears to be a monorepo workspace */
  isMonorepo: boolean;
  /** monorepo orchestration tool, if detected */
  monorepoTool?: MonorepoTool;
};

/**
 * Detects workspace info by walking up the directory tree looking for lockfiles.
 * Returns package manager, root path, and monorepo details.
 */
export function detectWorkspaceInfo(opts?: {
  cwd?: string,
}): WorkspaceInfo | undefined {
  debug('Detecting workspace info');
  let cwd = opts?.cwd || process.cwd();
  let multipleLockfilesDetected: Array<JsPackageManager> | undefined;
  let foundRootPath: string | undefined;
  let foundPm: JsPackageManager | undefined;

  do {
    debug(`> scanning ${cwd}`);
    const scanDir = cwd;
    let detectedPm: JsPackageManager | undefined;
    let pm: JsPackageManager;

    for (pm in JS_PACKAGE_MANAGERS) {
      const foundLockfile = JS_PACKAGE_MANAGERS[pm].lockfiles.find(
        (lockfile) => pathExistsSync(path.join(scanDir, lockfile)),
      );

      if (foundLockfile) {
        // if we find 2 lockfiles at the same level, store them and continue
        // this can happen in monorepos or when switching package managers
        if (detectedPm) {
          debug(`> found multiple lockfiles: ${foundLockfile} and ${JS_PACKAGE_MANAGERS[detectedPm].lockfiles[0]}`);
          multipleLockfilesDetected = [detectedPm, pm];
          break;
        }
        debug(`> found ${foundLockfile}`);
        detectedPm = pm;
      }
    }

    if (detectedPm && !multipleLockfilesDetected) {
      foundRootPath = scanDir;
      foundPm = detectedPm;
      break;
    }
    if (multipleLockfilesDetected) break;

    // will break when we reach the filesystem root
    const parentDir = path.dirname(cwd);
    if (parentDir === cwd) break;
    cwd = parentDir;
  } while (cwd);

  // if we did not find a lockfile, check env vars for hints (rootPath will be cwd in this case)
  if (!foundPm) {
    if (process.env.npm_config_user_agent) {
      const pmFromAgent = process.env.npm_config_user_agent.split('/')[0];
      if (Object.keys(JS_PACKAGE_MANAGERS).includes(pmFromAgent)) {
        debug(`> found ${pmFromAgent} using npm_config_user_agent`);
        foundPm = pmFromAgent as JsPackageManager;
        foundRootPath = opts?.cwd || process.cwd();
      }
    }

    // if we found multiple lockfiles and env var detection failed, use the first detected one
    // we choose the first one because the order is deterministic (based on the order in JS_PACKAGE_MANAGERS)
    // and this provides a reasonable fallback when we can't determine the active package manager
    if (!foundPm && multipleLockfilesDetected) {
      debug(`> using ${multipleLockfilesDetected[0]} from multiple detected lockfiles`);
      foundPm = multipleLockfilesDetected[0];
      foundRootPath = cwd;
    }
  }

  if (!foundPm || !foundRootPath) {
    return undefined;
  }

  const packageManager = JS_PACKAGE_MANAGERS[foundPm];

  // detect monorepo indicators at the root path
  let isMonorepo = false;
  let monorepoTool: MonorepoTool | undefined;

  // check for workspaces field in package.json (npm/yarn/bun workspaces)
  const rootPackageJsonPath = path.join(foundRootPath, 'package.json');
  if (pathExistsSync(rootPackageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf-8'));
      if (packageJson.workspaces) isMonorepo = true;
    } catch { /* ignore parse errors */ }
  }

  // pnpm workspaces use a separate config file
  if (!isMonorepo && pathExistsSync(path.join(foundRootPath, 'pnpm-workspace.yaml'))) {
    isMonorepo = true;
  }

  // detect monorepo orchestration tools
  if (pathExistsSync(path.join(foundRootPath, 'turbo.json'))) {
    monorepoTool = 'turborepo';
  } else if (pathExistsSync(path.join(foundRootPath, 'nx.json'))) {
    monorepoTool = 'nx';
  } else if (pathExistsSync(path.join(foundRootPath, 'lerna.json'))) {
    monorepoTool = 'lerna';
  }

  // a monorepo tool strongly implies this is a monorepo
  if (monorepoTool) isMonorepo = true;

  return {
    packageManager,
    rootPath: foundRootPath,
    isMonorepo,
    monorepoTool,
  };
}

/**
 * AsyncLocalStorage holding a memoized getter for WorkspaceInfo.
 * The getter is registered eagerly but detection only runs on first access.
 */
const workspaceInfoStorage = new AsyncLocalStorage<() => WorkspaceInfo | undefined>();

/**
 * Run a function with workspace detection available via getWorkspaceInfo().
 * Detection is deferred until the first call to getWorkspaceInfo().
 * Accepts an explicit WorkspaceInfo to use instead of auto-detecting.
 */
export function runWithWorkspaceInfo<T>(fn: () => T, explicitInfo?: WorkspaceInfo): T {
  let cached: WorkspaceInfo | undefined;
  let detected = false;
  const getter = () => {
    if (!detected) {
      cached = explicitInfo ?? detectWorkspaceInfo();
      detected = true;
    }
    return cached;
  };
  return workspaceInfoStorage.run(getter, fn);
}

/**
 * Get the WorkspaceInfo for the current async context.
 * Falls back to detecting from process.cwd() if called outside runWithWorkspaceInfo.
 */
export function getWorkspaceInfo(): WorkspaceInfo | undefined {
  return workspaceInfoStorage.getStore()?.() ?? detectWorkspaceInfo();
}
