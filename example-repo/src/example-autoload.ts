import 'varlock/auto-load';
import { VarlockRedactor } from 'varlock';

// console.log('loading varlock env');
// await load();
VarlockRedactor.patchConsole();

import { logEnv } from './log-env.ts';

if (!process.env.SENSITIVE_ITEM) {
  throw new Error('no env vars have been loaded :( auto-load is not working');
}

logEnv();

process.exit(0);
