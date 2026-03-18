// Self-contained server runtime init bundle.
// Initializes varlock env and applies all patches (console, server-response, response).
// Built with noExternal so it can be injected as raw JS or imported from any location.

import { initVarlockEnv } from '../runtime/env';
import { patchGlobalConsole } from '../runtime/patch-console';
import { patchGlobalServerResponse } from '../runtime/patch-server-response';
import { patchGlobalResponse } from '../runtime/patch-response';

initVarlockEnv();
patchGlobalConsole();
patchGlobalServerResponse();
patchGlobalResponse();

// Expose on globalThis so downstream code (e.g. webpack loaders) can re-invoke
// without require() — needed in edge sandboxes that can't resolve bare requires.
(globalThis as any).__varlockPatchConsole = patchGlobalConsole;

// Re-export env utilities so consumers can `import { ENV } from 'varlock/init-server'`
// without a separate import that would create a second uninitialized module instance.
export {
  ENV, redactSensitiveConfig, revealSensitiveConfig, scanForLeaks,
} from '../runtime/env';
