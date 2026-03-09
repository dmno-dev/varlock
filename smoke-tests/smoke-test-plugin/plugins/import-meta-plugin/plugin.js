/// <reference path="../../../../packages/varlock/src/plugin-lib.ts" />
// Plugin using import.meta.url and createRequire — mimics the pattern used by
// @varlock/1password-plugin where tsup injects a createRequire banner to load
// co-located .wasm and native addon files via __dirname.
// Some imports are intentionally unused — they exist to test that the plugin
// loader correctly rewrites ESM imports when bundling for the SEA binary.
/* eslint-disable @typescript-eslint/no-unused-vars */
import { createRequire } from 'module';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const require = createRequire(import.meta.url);
const __dirname = new URL('.', import.meta.url).pathname;

plugin.name = 'import-meta-test';

plugin.registerResolverFunction({
  name: 'metaTest',
  argsSchema: {
    type: 'array',
    arrayExactLength: 1,
  },
  process() {
    return this.arrArgs[0].staticValue;
  },
  async resolve(val) {
    // Verify that import.meta.url was rewritten correctly, __dirname
    // should point at this plugin's directory on disk
    const dirOk = __dirname.includes('import-meta-plugin');
    return `${val}:dirname_ok=${dirOk}`;
  },
});
