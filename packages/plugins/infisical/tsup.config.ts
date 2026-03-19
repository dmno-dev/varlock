import { defineConfig } from 'tsup';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

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
  format: ['cjs'],
  splitting: false,
  target: 'esnext',
  external: ['varlock'],
  async onSuccess() {
    const cjsPath = join('dist', 'plugin.cjs');
    let code = readFileSync(cjsPath, 'utf-8');
    code = code.replace(
      "'use strict';",
      `'use strict';\n\n${SUPPRESS_DEPRECATION_SHIM}`,
    );
    writeFileSync(cjsPath, code);
  },
});
