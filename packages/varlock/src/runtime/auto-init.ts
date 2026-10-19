// Side-effect-on-import varlock runtime init (`import 'varlock/auto-init'`).
// Initializes the resolved env already present in this process (`__VARLOCK_ENV`, possibly
// encrypted, or `globalThis.__varlockLoadedEnv`) and applies all runtime patches. Edge-safe:
// nothing here touches node builtins at module scope. For the auto-resolving variant that
// runs the varlock CLI when no env is present, use `varlock/auto-load` instead.
//
// Import this FIRST in an entry file: ESM hoists static imports, so it is the only way to
// run init before sibling imports that read `ENV` at module scope (see ./init.ts).

import { initVarlockRuntime } from './init';

initVarlockRuntime();

// Re-export env utilities so consumers can `import { ENV } from 'varlock/auto-init'`
// without a separate import that would create a second uninitialized module instance.
export {
  ENV, redactSensitiveConfig, revealSensitiveConfig, scanForLeaks,
} from './env';
