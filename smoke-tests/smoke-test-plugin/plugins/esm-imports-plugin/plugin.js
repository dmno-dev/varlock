/// <reference path="../../../../packages/varlock/src/plugin-lib.ts" />
// Plugin with ESM imports of Node builtins — mimics the pattern used by
// real plugins like @varlock/pass-plugin and @varlock/bitwarden-plugin
// Some imports are intentionally unused — they exist to test that the plugin
// loader correctly rewrites ESM imports when bundling for the SEA binary.
/* eslint-disable @typescript-eslint/no-unused-vars */
import { execSync, spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { Buffer } from 'buffer';
import { promisify } from 'util';
import * as crypto from 'crypto';

plugin.name = 'esm-imports-test';

plugin.registerResolverFunction({
  name: 'esmTest',
  argsSchema: {
    type: 'array',
    arrayExactLength: 1,
  },
  process() {
    return this.arrArgs[0].staticValue;
  },
  async resolve(val) {
    // Actually exercise the imported modules to prove they loaded correctly
    const joined = path.join('/tmp', 'test');
    const b64 = Buffer.from('hello').toString('base64');
    const hash = crypto.createHash('sha256').update('test').digest('hex').slice(0, 8);
    return `${val}:path=${joined}:b64=${b64}:hash=${hash}`;
  },
});
