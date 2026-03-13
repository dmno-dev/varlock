// This file is bundled into a self-contained CJS module by tsup (with noExternal)
// and used as the resolveAlias target for 'varlock/env' in Turbopack.
// It includes the env runtime + all patches so that importing 'varlock/env'
// in a server-side file automatically sets up redaction and leak prevention.

// re-export ENV (the main thing consumers import)
export { ENV, initVarlockEnv } from 'varlock/env';

// import and call patches - these are idempotent so safe to call multiple times
import { patchGlobalConsole } from 'varlock/patch-console';
import { patchGlobalServerResponse } from 'varlock/patch-server-response';
import { patchGlobalResponse } from 'varlock/patch-response';

patchGlobalConsole();
patchGlobalServerResponse();
patchGlobalResponse();
