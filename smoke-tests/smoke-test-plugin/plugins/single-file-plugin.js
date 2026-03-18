/// <reference path="../../../packages/varlock/src/plugin-lib.ts" />
// Single-file plugin (no package.json) — tests the .js file plugin path
const path = require('path');

plugin.registerResolverFunction({
  name: 'singleFileTest',
  argsSchema: {
    type: 'array',
    arrayExactLength: 1,
  },
  process() {
    return this.arrArgs[0].staticValue;
  },
  async resolve(val) {
    const sep = path.sep;
    return `${val}:sep=${sep}`;
  },
});
