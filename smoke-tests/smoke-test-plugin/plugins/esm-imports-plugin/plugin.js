/// <reference path="../../../../packages/varlock/src/plugin-lib.ts" />
// Plugin with CJS requires of Node builtins — mimics the pattern used by
// real plugins like @varlock/pass-plugin and @varlock/bitwarden-plugin
/* eslint-disable @typescript-eslint/no-unused-vars */
const { execSync, spawn } = require('child_process');
const { readFileSync, existsSync } = require('fs');
const path = require('path');
const { Buffer } = require('buffer');
const { promisify } = require('util');
const crypto = require('crypto');

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
    const joined = path.join('/tmp', 'test');
    const b64 = Buffer.from('hello').toString('base64');
    const hash = crypto.createHash('sha256').update('test').digest('hex').slice(0, 8);
    return `${val}:path=${joined}:b64=${b64}:hash=${hash}`;
  },
});
