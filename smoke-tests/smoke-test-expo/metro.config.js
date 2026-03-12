const { getDefaultConfig } = require('expo/metro-config');
const { withVarlockMetroConfig } = require('@varlock/expo-integration/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// ---------------------------------------------------------------------------
// SMOKE TEST ONLY — not needed in a real project.
//
// This monorepo uses pnpm workspace symlinks (link:../../packages/...) which
// Metro can't follow by default. A real project that installs varlock from
// npm won't need any of this.
// ---------------------------------------------------------------------------
const monorepoRoot = path.resolve(__dirname, '../..');
config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(monorepoRoot, 'smoke-tests', 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];
config.resolver.unstable_enableSymlinks = true;
config.resolver.unstable_enablePackageExports = true;

// This is where the magic happens - it initializes varlock in the Metro process

module.exports = withVarlockMetroConfig(config);
