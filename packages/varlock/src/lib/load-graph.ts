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
  /** Clear cache and re-resolve all values */
  clearCache?: boolean,
  /** Skip cache entirely for this invocation */
  skipCache?: boolean,
}) {
  const pkgLoadPath = readVarlockPackageJsonConfig()?.loadPath;
  const resolvedEntryFilePath = opts?.entryFilePath ?? pkgLoadPath;

  if (opts?.entryFilePath) {
    debug('using path from --path flag: %s', path.resolve(opts.entryFilePath));
  } else if (pkgLoadPath) {
    debug('using path from package.json varlock.loadPath: %s', path.resolve(pkgLoadPath));
  } else {
    debug('no path configured, using cwd: %s', process.cwd());
  }

  // Validate the path early so we can give a targeted error about where it came from
  if (resolvedEntryFilePath) {
    const resolvedPath = path.resolve(resolvedEntryFilePath);
    if (!fs.existsSync(resolvedPath)) {
      if (opts?.entryFilePath) {
        throw new CliExitError(`The --path value does not exist: ${resolvedPath}`, {
          suggestion: 'Use `--path` to specify a valid file or directory.',
        });
      } else {
        throw new CliExitError(`The \`varlock.loadPath\` configured in package.json does not exist: ${resolvedPath}`, {
          suggestion: 'Update `varlock.loadPath` in your package.json to point to a valid file or directory.',
        });
      }
    }
  }

  return runWithWorkspaceInfo(() => loadEnvGraph({
    ...opts,
    entryFilePath: resolvedEntryFilePath,
    clearCache: opts?.clearCache,
    skipCache: opts?.skipCache,
    afterInit: async (_g) => {
      // TODO: register varlock resolver
    },
  }));
}
