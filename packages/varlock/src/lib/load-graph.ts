import fs from 'node:fs';
import path from 'node:path';
import { loadEnvGraph } from '../env-graph';
import { VarlockResolver } from './local-encrypt/builtin-resolver';
import { KeychainResolver } from './local-encrypt/keychain-resolver';
import { CliExitError } from '../cli/helpers/exit-error';
import { runWithWorkspaceInfo } from './workspace-utils';
import { readVarlockPackageJsonConfig } from './package-json-config';
import { createDebug } from './debug';

const debug = createDebug('varlock:load');

function normalizePkgLoadPath(pkgLoadPath: string | Array<string>): Array<string> {
  if (Array.isArray(pkgLoadPath)) return pkgLoadPath;
  return [pkgLoadPath];
}

function loadFromPaths(
  rawPaths: Array<string>,
  config: {
    source: string,
    errorPrefix: string,
    errorSuggestion: string,
    currentEnvFallback?: string,
  },
) {
  const resolvedPaths = rawPaths.map((p) => path.resolve(p));

  if (resolvedPaths.length === 1) {
    debug('using path from %s: %s', config.source, resolvedPaths[0]);
  } else {
    debug('using %d paths from %s: %s', resolvedPaths.length, config.source, resolvedPaths.join(', '));
  }

  for (const resolvedPath of resolvedPaths) {
    if (!fs.existsSync(resolvedPath)) {
      throw new CliExitError(`${config.errorPrefix}: ${resolvedPath}`, {
        suggestion: config.errorSuggestion,
      });
    }
  }

  return runWithWorkspaceInfo(() => loadEnvGraph({
    currentEnvFallback: config.currentEnvFallback,
    entryFilePaths: resolvedPaths,
    afterInit: async (g) => {
      g.registerResolver(VarlockResolver);
      g.registerResolver(KeychainResolver);
    },
  }));
}

export function loadVarlockEnvGraph(opts?: {
  currentEnvFallback?: string,
  /** Explicit entry file paths from --path flag(s) - overrides package.json config */
  entryFilePaths?: Array<string>,
}) {
  const cliPaths = opts?.entryFilePaths?.filter(Boolean);

  // If --path flag(s) provided, they take precedence over package.json config
  if (cliPaths && cliPaths.length > 0) {
    // Return early and ignore pkgLoadPaths
    return loadFromPaths(cliPaths, {
      source: '--path flag',
      errorPrefix: 'The --path value does not exist',
      errorSuggestion: 'Use `--path` to specify a valid file or directory.',
      currentEnvFallback: opts?.currentEnvFallback,
    });
  }

  // Fall back to package.json varlock.loadPath
  const pkgLoadPath = readVarlockPackageJsonConfig()?.loadPath;
  const pkgLoadPaths = pkgLoadPath ? normalizePkgLoadPath(pkgLoadPath) : undefined;

  if (pkgLoadPaths) {
    return loadFromPaths(pkgLoadPaths, {
      source: 'package.json varlock.loadPath',
      errorPrefix: 'A path in `varlock.loadPath` configured in package.json does not exist',
      errorSuggestion: 'Update `varlock.loadPath` in your package.json to point to valid files or directories.',
      currentEnvFallback: opts?.currentEnvFallback,
    });
  }

  debug('no path configured, using cwd: %s', process.cwd());

  return runWithWorkspaceInfo(() => loadEnvGraph({
    currentEnvFallback: opts?.currentEnvFallback,
    afterInit: async (g) => {
      g.registerResolver(VarlockResolver);
      g.registerResolver(KeychainResolver);
    },
  }));
}
