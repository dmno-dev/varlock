/// <reference types="./env.d.ts" />
import 'varlock/auto-load';
import { ENV, patchGlobalConsoleToRedactSensitiveLogs } from 'varlock';

patchGlobalConsoleToRedactSensitiveLogs();

ENV.SENSITIVE_ITEM = 'test';

import { logEnv } from './log-env.js';

// import { load } from 'varlock';

// await load({
//   global: MY_CONFIG,
// });

if (!process.env.SENSITIVE_ITEM) {
  throw new Error('no env vars have been loaded :( auto-load is not working');
}

logEnv();

process.exit(0);
