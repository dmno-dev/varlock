import { ENV } from 'varlock/env';

// Nitro server route. These are built by nitro's own rollup pass and are never
// part of vite's SSR module graph, so ENV here is only available if the module
// injected varlock init into the nitro bundle.
export default defineEventHandler(() => ({
  PUBLIC_VAR: ENV.PUBLIC_VAR,
  ENV_SPECIFIC_VAR: ENV.ENV_SPECIFIC_VAR,
  HAS_SECRET: ENV.SENSITIVE_VAR ? 'yes' : 'no',
}));
