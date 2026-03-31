// Single-file ESM plugin — tests that .mjs files load via import() in all environments
import { plugin } from 'varlock/plugin-lib';
import path from 'node:path';

plugin.name = 'esm-mjs-test';

plugin.registerResolverFunction({
  name: 'esmMjsTest',
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
