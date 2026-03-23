import fs from 'node:fs';
import path from 'node:path';
import { gracefulExit } from 'exit-hook';
import { loadEnvGraph } from '../env-graph';
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
        console.error(`🚨 The --path value does not exist: ${resolvedPath}\n`);
        console.error('Use `--path` to specify a valid file or directory.');
      } else {
        console.error(`🚨 The \`varlock.loadPath\` configured in package.json does not exist: ${resolvedPath}\n`);
        console.error('Update `varlock.loadPath` in your package.json to point to a valid file or directory.');
      }
      gracefulExit(1);
      return new Promise(() => {}) as never;
    }
  }

  return runWithWorkspaceInfo(() => loadEnvGraph({
    ...opts,
    entryFilePath: resolvedEntryFilePath,
    afterInit: async (_g) => {
      // TODO: register varlock resolver
    },
  }));
}
