import path from 'node:path';
import fs, { existsSync } from 'node:fs';
import { pathExistsSync } from '@env-spec/utils/fs-utils';

import { CliExitError } from './exit-error';
import { execSync } from 'node:child_process';

export type JsPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno';

export type JsPackageManagerMeta = {
  name: JsPackageManager;
  lockfile: string;
  add: string;
  exec: string;
  dlx: string;
};

export const JS_PACKAGE_MANAGERS: Record<JsPackageManager, JsPackageManagerMeta> = Object.freeze({
  npm: {
    name: 'npm',
    lockfile: 'package-lock.json',
    add: 'npm install', // add also works
    exec: 'npm exec --',
    dlx: 'npx',
  },
  pnpm: {
    name: 'pnpm',
    lockfile: 'pnpm-lock.yaml',
    add: 'pnpm add',
    exec: 'pnpm exec',
    dlx: 'pnpm dlx',
  },
  yarn: {
    name: 'yarn',
    lockfile: 'yarn.lock',
    add: 'yarn add',
    exec: 'yarn exec --',
    dlx: 'yarn dlx',
  },
  bun: {
    name: 'bun',
    lockfile: 'bun.lockb',
    add: 'bun add',
    exec: 'bun run',
    dlx: 'bunx',
  },
  deno: { //! deno not fully supported yet
    name: 'deno',
    lockfile: 'deno.lock',
    add: 'deno add',
    // TODO: don't think these are quite right...
    exec: 'deno run',
    dlx: 'deno run',
  },
});

/**
 * detect js package manager
 *
 * currently go up the folder tree looking for lockfiles (ex: package-lock.json, pnpm-lock.yaml)
 * if nothing found, we'll look at process.env.npm_config_user_agent
 * */
export function detectJsPackageManager(opts?: {
  cwd?: string,
  workspaceRootPath?: string,
  exitIfNotFound?: boolean,
}) {
  let cwd = opts?.cwd || process.cwd();
  const cwdParts = cwd.split(path.sep);
  do {
    let pm: JsPackageManager;
    let detectedPm: JsPackageManager | undefined;
    for (pm in JS_PACKAGE_MANAGERS) {
      const lockFilePath = path.join(
        cwd,
        JS_PACKAGE_MANAGERS[pm].lockfile,
      );

      if (pathExistsSync(lockFilePath)) {
        // if we find 2 lockfiles at the same level, we throw an error
        if (detectedPm) {
          throw new CliExitError('Found multiple js package manager lockfiles', {
            details: `${JS_PACKAGE_MANAGERS[pm].lockfile} and ${JS_PACKAGE_MANAGERS[detectedPm].lockfile}`,
            forceExit: true,
          });
        }
        detectedPm = pm;
      }
    }
    if (detectedPm) return JS_PACKAGE_MANAGERS[detectedPm];

    cwdParts.pop();
    cwd = path.join(...cwdParts);
    if (opts?.workspaceRootPath) {
      if (opts.workspaceRootPath === cwd) break;
    } else {
      // if we don't have a workspace root path, we'll break if we hit the git repo root
      if (pathExistsSync(path.join(cwd, '.git'))) break;
    }
  } while (cwd);

  // if we did not find a lockfile, we'll look at env vars for other hints
  if (process.env.npm_config_user_agent) {
    const pmFromAgent = process.env.npm_config_user_agent.split('/')[0];
    if (Object.keys(JS_PACKAGE_MANAGERS).includes(pmFromAgent)) {
      return JS_PACKAGE_MANAGERS[pmFromAgent as JsPackageManager];
    }
  }

  if (opts?.exitIfNotFound) {
    // show some hopefully useful error messaging if we hit the root folder without finding anything
    throw new CliExitError('Unable to find detect your JavaScript package manager!', {
      suggestion: 'We look for lock files (ex: package-lock.json) so you may just need to run a dependency install (ie `npm install`)',
      forceExit: true,
    });
  }
}




export function installJsDependency(opts: {
  packageName: string,
  packageManager: JsPackageManager,
  packagePath?: string,
  isMonoRepoRoot?: boolean,
}) {
  const packageJsonPath = path.join(opts.packagePath || process.cwd(), 'package.json');

  // for now, we'll just bail if we dont see a package.json
  if (!existsSync(packageJsonPath)) return false;

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  // bail if already installed
  if (packageJson.dependencies?.varlock) return false;

  // TODO: might want to check first if it's already installed?
  execSync([
    opts.packagePath ? `cd ${opts.packagePath} &&` : '',
    // `add` works in all of them
    `${opts.packageManager} add ${opts.packageName}`,
    (opts.isMonoRepoRoot && opts.packageManager === 'pnpm') ? '-w' : '',
  ].join(' '));

  return true;
}

