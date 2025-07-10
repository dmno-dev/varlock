import { initVarlockEnv } from 'varlock/env';
import { patchGlobalConsole } from 'varlock/patch-console';
import { patchGlobalServerResponse } from 'varlock/patch-server-response';
import { patchGlobalResponse } from 'varlock/patch-response';

// process.env.__VARLOCK_ENV is already set by either our next-env-compat
// or by the platform, because we generated a temp .env file which included it
initVarlockEnv();
patchGlobalConsole();
patchGlobalServerResponse();
patchGlobalResponse();
