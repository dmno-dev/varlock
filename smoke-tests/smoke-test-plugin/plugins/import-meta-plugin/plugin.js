/// <reference path="../../../../packages/varlock/src/plugin-lib.ts" />
// Plugin using __dirname — mimics the pattern used by @varlock/1password-plugin
// where plugins need to locate co-located .wasm and native addon files.
/* eslint-disable @typescript-eslint/no-unused-vars */
const { exec, spawn } = require('child_process');
const { promisify } = require('util');

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
    const dirOk = __dirname.includes('import-meta-plugin');
    return `${val}:dirname_ok=${dirOk}`;
  },
});
