import { defineConfig } from 'tsdown';

// Suppress DEP0169 url.parse() deprecation warning emitted by transitive deps
// (e.g. @smithy/credential-provider-imds bundled via @infisical/sdk).
// We temporarily mute DeprecationWarning emissions while the bundle loads.
const SUPPRESS_DEPRECATION_SHIM = [
  '// -- suppress DEP0169 url.parse() warning from transitive deps --',
  'var __origEmitWarning = process.emitWarning;',
  'process.emitWarning = function(msg) {',
  '  if (typeof msg === "string" && msg.includes("url.parse()")) return;',
  '  return __origEmitWarning.apply(process, arguments);',
  '};',
  '// -- end suppress --',
].join('\n');

export default defineConfig({
  entry: ['src/plugin.ts'],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: false,
  outDir: 'dist',
  attw: { level: 'error', profile: 'node16' },
  publint: true,
  format: ['cjs'],
  platform: 'node',
  target: 'esnext',
  external: ['varlock'],
  banner: SUPPRESS_DEPRECATION_SHIM,
});
