/* eslint-disable no-console */

import { execSyncVarlock } from 'varlock/exec-sync-varlock';
import { initVarlockEnv } from 'varlock/env';
import { patchGlobalConsole } from 'varlock/patch-console';
import type { SerializedEnvGraph } from 'varlock';

const VARLOCK_SUBPATHS = [
  'varlock/env',
  'varlock/patch-console',
  'varlock/patch-response',
  'varlock/patch-server-response',
  'varlock/auto-load',
  'varlock/exec-sync-varlock',
];

// Pre-resolve subpaths using Node.js (which supports package.json "exports"),
// so we can hand absolute file paths to Metro's resolver (which does not).
const resolvedVarlockPaths: Record<string, string> = {};
for (const subpath of VARLOCK_SUBPATHS) {
  try {
    resolvedVarlockPaths[subpath] = require.resolve(subpath);
  } catch { /* varlock not installed — resolver will be a no-op */ }
}

/**
 * Wraps the Metro config to initialize varlock in the main Metro process.
 *
 * - Adds a custom resolver so Metro can resolve `varlock/env` and other
 *   subpath exports (Metro doesn't support package.json `"exports"` by default).
 * - Ensures the varlock package directory is in Metro's `watchFolders` so
 *   resolved files are accessible (needed when using linked/local deps).
 * - Initializes the ENV proxy in the main process so sensitive values are
 *   available at runtime in Expo Router server routes (`+api` files).
 *
 * @example
 * // metro.config.js
 * const { getDefaultConfig } = require('expo/metro-config');
 * const { withVarlockMetroConfig } = require('@varlock/expo-integration/metro-config');
 *
 * const config = getDefaultConfig(__dirname);
 * module.exports = withVarlockMetroConfig(config);
 */
export function withVarlockMetroConfig<T extends Record<string, any>>(config: T): T {
  const c = config as Record<string, any>;
  c.resolver ??= {};

  // Install custom resolver for varlock subpath exports
  const existingResolveRequest = c.resolver.resolveRequest;
  c.resolver.resolveRequest = (
    context: any,
    moduleName: string,
    platform: string | null,
  ) => {
    const absolutePath = resolvedVarlockPaths[moduleName];
    if (absolutePath) {
      return { type: 'sourceFile', filePath: absolutePath };
    }
    if (existingResolveRequest) {
      return existingResolveRequest(context, moduleName, platform);
    }
    return context.resolveRequest(context, moduleName, platform);
  };

  // Ensure the varlock package dir is in watchFolders so Metro can access
  // resolved files (required when varlock is linked via symlink/local deps).
  const envPath = resolvedVarlockPaths['varlock/env'];
  if (envPath) {
    const path = require('path');
    const varlockPkgDir = path.resolve(path.dirname(envPath), '..', '..');
    const watchFolders: string[] = c.watchFolders ?? [];
    if (!watchFolders.some((f: string) => varlockPkgDir.startsWith(f) || f.startsWith(varlockPkgDir))) {
      watchFolders.push(varlockPkgDir);
    }
    c.watchFolders = watchFolders;
  }

  if (process.env.__VARLOCK_ENV) return config;

  try {
    const execResult = execSyncVarlock('load --format json-full', {
      showLogsOnError: true,
    });
    process.env.__VARLOCK_ENV = execResult;

    const parsed = JSON.parse(execResult) as SerializedEnvGraph;
    (globalThis as any).__varlockLoadedEnv = parsed;

    initVarlockEnv();
    patchGlobalConsole();
  } catch (err) {
    console.error(
      '⚠️  @varlock/expo-integration: Failed to initialize varlock in Metro config.',
      (err as Error).message,
    );
  }

  return config;
}
