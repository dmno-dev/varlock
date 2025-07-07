import 'varlock/auto-load';

import { logEnv } from './log-env.ts';

if (!process.env.SENSITIVE_ITEM) {
  throw new Error('no env vars have been loaded :( auto-load is not working');
}

logEnv();

process.exit(0);
