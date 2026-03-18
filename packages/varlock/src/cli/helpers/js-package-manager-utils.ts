// Re-exports for backward compatibility - prefer importing from lib/workspace-utils directly
export {
  JS_PACKAGE_MANAGERS,
  detectWorkspaceInfo,
  getWorkspaceInfo,
  runWithWorkspaceInfo,
  type JsPackageManager,
  type JsPackageManagerMeta,
  type WorkspaceInfo,
  type MonorepoTool,
} from '../../lib/workspace-utils';

import path from 'node:path';
import fs, { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { CliExitError } from './exit-error';
import { detectWorkspaceInfo, type JsPackageManager } from '../../lib/workspace-utils';

export function detectJsPackageManager(opts?: {
  cwd?: string,
  exitIfNotFound?: boolean,
}) {
  const info = detectWorkspaceInfo({ cwd: opts?.cwd });
  if (!info) {
    if (opts?.exitIfNotFound) {
      throw new CliExitError('Unable to detect your JavaScript package manager!', {
        suggestion: 'We look for lock files (ex: package-lock.json) so you may just need to run a dependency install (ie `npm install`)',
        forceExit: true,
      });
    }
    return undefined;
  }
  return info.packageManager;
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
    // move to the correct directory if needed
    opts.packagePath && `cd ${opts.packagePath} &&`,
    // `add` works in all of them
    `${opts.packageManager} add ${opts.packageName}`,
    // tells pnpm to either install in the workspace root explicitly
    // or to not check if we are the in the root
    opts.packageManager === 'pnpm' && (opts.isMonoRepoRoot ? '-w' : '--ignore-workspace-root-check'),
  ].filter(Boolean).join(' '));

  return true;
}
