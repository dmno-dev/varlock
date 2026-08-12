import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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

/** language/toolchain a workspace root marker belongs to */
export type WorkspaceEcosystem = 'js' | 'python' | 'rust' | 'go' | 'php' | 'ruby' | 'elixir' | 'jvm' | 'dotnet' | 'polyglot' | 'vcs';

/**
 * Files that mark the root of a multi-package workspace, across every ecosystem varlock
 * supports (see `@generate*Env` decorators + `varlock run`).
 *
 * Only markers that live at the *root* of a workspace belong here - per-package manifests
 * (package.json, pyproject.toml, Cargo.toml, go.mod, ...) are deliberately excluded since
 * every member has one. Markers that some tools also write per-package (Gemfile.lock,
 * composer.lock, pom.xml) are fine because detection takes the outermost match.
 */
export const WORKSPACE_ROOT_MARKERS: Array<{ file: string, ecosystem: WorkspaceEcosystem }> = [
  // JS - lockfiles come from JS_PACKAGE_MANAGERS so the two lists cannot drift
  ...Object.values(JS_PACKAGE_MANAGERS).flatMap(
    (pm) => pm.lockfiles.map((file) => ({ file, ecosystem: 'js' as const })),
  ),
  { file: 'npm-shrinkwrap.json', ecosystem: 'js' },
  { file: 'pnpm-workspace.yaml', ecosystem: 'js' },
  { file: 'turbo.json', ecosystem: 'js' },
  { file: 'nx.json', ecosystem: 'js' },
  { file: 'lerna.json', ecosystem: 'js' },
  { file: 'rush.json', ecosystem: 'js' },

  // python - uv/poetry/pdm/pixi/rye/pipenv all lock at the workspace root only
  { file: 'uv.lock', ecosystem: 'python' },
  { file: 'poetry.lock', ecosystem: 'python' },
  { file: 'pdm.lock', ecosystem: 'python' },
  { file: 'pixi.lock', ecosystem: 'python' },
  { file: 'Pipfile.lock', ecosystem: 'python' },
  { file: 'requirements.lock', ecosystem: 'python' }, // rye

  // rust - workspace members share the root Cargo.lock
  { file: 'Cargo.lock', ecosystem: 'rust' },

  // go - go.sum/go.mod are per-module, only go.work marks a multi-module workspace
  { file: 'go.work', ecosystem: 'go' },

  { file: 'composer.lock', ecosystem: 'php' },
  { file: 'Gemfile.lock', ecosystem: 'ruby' },
  { file: 'mix.lock', ecosystem: 'elixir' },

  // jvm - gradle settings files list the included builds, maven uses an aggregator pom
  { file: 'settings.gradle', ecosystem: 'jvm' },
  { file: 'settings.gradle.kts', ecosystem: 'jvm' },
  { file: 'pom.xml', ecosystem: 'jvm' },

  // dotnet - `.sln`/`.slnx` files are matched separately (they are named after the solution)
  { file: 'global.json', ecosystem: 'dotnet' },
  { file: 'Directory.Build.props', ecosystem: 'dotnet' },
  { file: 'Directory.Packages.props', ecosystem: 'dotnet' },

  // polyglot monorepo build systems
  { file: 'MODULE.bazel', ecosystem: 'polyglot' },
  { file: 'WORKSPACE.bazel', ecosystem: 'polyglot' },
  { file: 'WORKSPACE', ecosystem: 'polyglot' },
  { file: 'pants.toml', ecosystem: 'polyglot' },
  { file: '.buckconfig', ecosystem: 'polyglot' },
];

/** version control roots - used as the outer boundary, and as a fallback root */
const VCS_MARKERS = ['.git', '.hg', '.svn'];

/** single readdir per directory - cheaper than stat-ing every marker, and finds `.sln` files */
function findRootMarkerInDir(dir: string) {
  let entryNames: Array<string>;
  try {
    entryNames = fs.readdirSync(dir);
  } catch {
    return undefined; // unreadable dir - treat as no marker
  }
  const entries = new Set(entryNames);
  const marker = WORKSPACE_ROOT_MARKERS.find((m) => entries.has(m.file));
  if (marker) return marker;
  // .NET solution files are named after the solution, so they can't be a fixed marker
  const solutionFile = entryNames.find((f) => f.endsWith('.sln') || f.endsWith('.slnx'));
  if (solutionFile) return { file: solutionFile, ecosystem: 'dotnet' as const };
}

export type WorkspaceRootInfo = {
  /** path to the workspace/monorepo root */
  rootPath: string;
  /** the file that identified the root (e.g. `uv.lock`, or `.git` when falling back to the VCS root) */
  marker: string;
  ecosystem: WorkspaceEcosystem;
};

/**
 * Detects the root of the surrounding workspace/monorepo, in any language.
 *
 * Unlike `detectWorkspaceInfo` (which answers "which JS package manager runs here?" and so
 * wants the *nearest* lockfile), this answers "how far out does this repo extend?" and takes
 * the **outermost** marker found, bounded by the VCS root. That matters for monorepos whose
 * members carry their own lockfile (Gemfile.lock, composer.lock, a nested package-lock.json),
 * where the nearest match would be the package itself rather than the repo root.
 *
 * Falls back to the VCS root when no ecosystem marker is found, and returns undefined when
 * there is nothing to go on (e.g. a build context with neither a lockfile nor `.git`).
 */
export function detectWorkspaceRoot(opts?: {
  cwd?: string,
}): WorkspaceRootInfo | undefined {
  debug('Detecting workspace root');
  let currentDir = path.resolve(opts?.cwd || process.cwd());
  const homeDir = os.homedir();
  let outermostMarker: WorkspaceRootInfo | undefined;
  let vcsRoot: WorkspaceRootInfo | undefined;

  while (currentDir) {
    debug(`> scanning ${currentDir}`);
    const scanDir = currentDir;
    const marker = findRootMarkerInDir(scanDir);
    if (marker) {
      debug(`> found ${marker.file}`);
      outermostMarker = { rootPath: scanDir, marker: marker.file, ecosystem: marker.ecosystem };
    }

    // the VCS root is the outer boundary - nothing above it is part of this repo
    const vcsMarker = VCS_MARKERS.find((m) => pathExistsSync(path.join(scanDir, m)));
    if (vcsMarker) {
      debug(`> found VCS root ${vcsMarker}`);
      vcsRoot = { rootPath: scanDir, marker: vcsMarker, ecosystem: 'vcs' };
      break;
    }

    // don't walk above the user's home dir, or past the filesystem root
    if (currentDir === homeDir) break;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  if (vcsRoot && outermostMarker?.rootPath !== vcsRoot.rootPath) return vcsRoot;
  return outermostMarker ?? vcsRoot;
}

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

    // stop at git root as a fallback boundary after scanning the current directory
    // NOTE: check before moving to parent so the directory containing .git is always scanned
    // (the standard monorepo layout has .git and the lockfile in the same root directory)
    if (pathExistsSync(path.join(cwd, '.git'))) break;

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
