import fs from 'node:fs';
import path from 'node:path';
import { loadEnvGraph } from '../env-graph';
import { CliExitError } from '../cli/helpers/exit-error';
import { runWithWorkspaceInfo } from './workspace-utils';
import { readVarlockPackageJsonConfig } from './package-json-config';
import { createDebug } from './debug';

const debug = createDebug('varlock:load');

export function loadVarlockEnvGraph(opts?: {
  currentEnvFallback?: string,
  /** Explicit entry file path - overrides package.json config */
  entryFilePath?: string,
}) {
  const pkgLoadPath = readVarlockPackageJsonConfig()?.loadPath;

  // If --path flag is provided, it takes precedence over package.json config
  if (opts?.entryFilePath) {
    debug('using path from --path flag: %s', path.resolve(opts.entryFilePath));

    const resolvedPath = path.resolve(opts.entryFilePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new CliExitError(`The --path value does not exist: ${resolvedPath}`, {
        suggestion: 'Use `--path` to specify a valid file or directory.',
      });
    }

    return runWithWorkspaceInfo(() => loadEnvGraph({
      ...opts,
      entryFilePath: opts.entryFilePath,
      afterInit: async (_g) => {
        // TODO: register varlock resolver
      },
    }));
  }

  // Normalize package.json loadPath to an array (or undefined)
  let pkgLoadPaths: Array<string> | undefined;
  if (pkgLoadPath) {
    pkgLoadPaths = Array.isArray(pkgLoadPath) ? pkgLoadPath : [pkgLoadPath];
  }

  if (pkgLoadPaths) {
    if (pkgLoadPaths.length === 1) {
      debug('using path from package.json varlock.loadPath: %s', path.resolve(pkgLoadPaths[0]));
    } else {
      debug(
        'using %d paths from package.json varlock.loadPath: %s',
        pkgLoadPaths.length,
        pkgLoadPaths.map((p) => path.resolve(p)).join(', '),
      );
    }

    // Validate that all paths exist
    for (const p of pkgLoadPaths) {
      const resolvedPath = path.resolve(p);
      if (!fs.existsSync(resolvedPath)) {
        throw new CliExitError(
          `A path in \`varlock.loadPath\` configured in package.json does not exist: ${resolvedPath}`,
          { suggestion: 'Update `varlock.loadPath` in your package.json to point to valid files or directories.' },
        );
      }
    }

    return runWithWorkspaceInfo(() => loadEnvGraph({
      ...opts,
      // For a single path, use the existing entryFilePath option for backward compatibility
      entryFilePath: pkgLoadPaths.length === 1 ? pkgLoadPaths[0] : undefined,
      // For multiple paths, use entryFilePaths to trigger the multi-path container
      entryFilePaths: pkgLoadPaths.length > 1 ? pkgLoadPaths : undefined,
      afterInit: async (_g) => {
        // TODO: register varlock resolver
      },
    }));
  }

  debug('no path configured, using cwd: %s', process.cwd());

  return runWithWorkspaceInfo(() => loadEnvGraph({
    ...opts,
    afterInit: async (_g) => {
      // TODO: register varlock resolver
    },
  }));
}
