import { load, patchGlobalConsole } from 'varlock';
import { ENV } from 'varlock/env';

await load();
patchGlobalConsole();

import { logEnv } from './log-env.ts';



if (!process.env.SENSITIVE_ITEM) {
  throw new Error('no env vars have been loaded :( auto-load is not working');
}
console.log('sensitive item = ', ENV.SENSITIVE_ITEM);

logEnv();

process.exit(0);
