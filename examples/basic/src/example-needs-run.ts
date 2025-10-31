// THIS EXAMPLE EXPECTS TO BE RUN VIA `varlock run`

import { logEnv } from './log-env.ts';

if (!process.env.SENSITIVE_ITEM) {
  throw new Error('missing injected env! try running via `varlock run`');
}

logEnv();

process.exit(0);
