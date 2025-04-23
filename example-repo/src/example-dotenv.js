import 'dotenv/config'; // will be replaced with varlock!

import { logEnv } from './log-env.js';

if (!process.env.SENSITIVE_ITEM) {
  throw new Error('no env vars have been loaded :( auto-load is not working');
}

logEnv();

process.exit(0);
