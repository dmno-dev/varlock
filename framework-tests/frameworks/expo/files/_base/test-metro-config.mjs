/**
 * Tests the metro config wrapper with real varlock loading (no Metro needed).
 * Verifies: config loading, custom resolver, ENV proxy initialization.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withVarlockMetroConfig } = require('@varlock/expo-integration/metro-config');

const config = { resolver: {} };

// This calls real varlock load, initializes ENV, patches console
withVarlockMetroConfig(config);

// Verify resolver was installed
if (typeof config.resolver.resolveRequest !== 'function') {
  console.error('FAIL: resolveRequest not installed');
  process.exit(1);
}

// Test resolver resolves varlock subpaths to real files
const SUBPATHS = ['varlock/env', 'varlock/patch-console'];
const fakeContext = {
  resolveRequest: () => {
    throw new Error('should not be called');
  },
};

for (const subpath of SUBPATHS) {
  const result = config.resolver.resolveRequest(fakeContext, subpath, null);
  if (!result || result.type !== 'sourceFile' || !result.filePath) {
    console.error(`FAIL: resolver did not resolve ${subpath}`);
    process.exit(1);
  }
  console.log(`resolver: ${subpath} → ${result.filePath}`);
}

// Test resolver falls through for non-varlock modules
const fallbackResult = { type: 'sourceFile', filePath: '/tmp/react.js' };
const fallbackContext = { resolveRequest: () => fallbackResult };
const nonVarlockResult = config.resolver.resolveRequest(fallbackContext, 'react', null);
if (nonVarlockResult !== fallbackResult) {
  console.error('FAIL: resolver did not fall through for non-varlock module');
  process.exit(1);
}
console.log('resolver: non-varlock fallthrough OK');

// Test watchFolders was set
if (!config.watchFolders || config.watchFolders.length === 0) {
  console.error('FAIL: watchFolders not set');
  process.exit(1);
}
console.log(`watchFolders: ${config.watchFolders.join(', ')}`);

// Test ENV proxy is accessible
const { ENV } = require('varlock/env');
if (typeof ENV !== 'object') {
  console.error('FAIL: ENV proxy not initialized');
  process.exit(1);
}
console.log(`ENV.APP_NAME = ${ENV.APP_NAME}`);
console.log(`ENV.API_URL = ${ENV.API_URL}`);

console.log('\nAll metro-config checks passed');
