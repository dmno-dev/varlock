/* eslint-disable no-console */

import { execSyncVarlock } from 'varlock/exec-sync-varlock';
import { initVarlockEnv } from 'varlock/env';
import { patchGlobalConsole } from 'varlock/patch-console';
import type { SerializedEnvGraph } from 'varlock';

/**
 * Wraps the Metro config to initialize varlock in the main Metro process.
 *
 * The babel plugin runs in Metro's forked worker processes, so it cannot set
 * `process.env.__VARLOCK_ENV` for the main process where server routes (+api
 * files) are evaluated. This wrapper ensures the ENV proxy is initialized in
 * the correct process.
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
