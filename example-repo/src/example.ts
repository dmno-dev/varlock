import 'varlock/auto-load';
import { ENV } from 'varlock';

ENV.SENSITIVE_ITEM;

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
