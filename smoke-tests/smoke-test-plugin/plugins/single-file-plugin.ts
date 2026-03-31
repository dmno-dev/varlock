// Single-file TypeScript plugin — tests that .ts files load via import() in all environments
import { plugin } from 'varlock/plugin-lib';
import path from 'node:path';

// intentional type annotation to verify TS syntax is accepted
const TYPED_MARKER: string = 'ts-ok';

plugin.name = 'ts-test';

plugin.registerResolverFunction({
  name: 'tsNativeTest',
  argsSchema: {
    type: 'array',
    arrayExactLength: 1,
  },
  process() {
    return this.arrArgs[0].staticValue;
  },
  async resolve(val: string): Promise<string> {
    const sep = path.sep;
    return `${val}:marker=${TYPED_MARKER}:sep=${sep}`;
  },
});
