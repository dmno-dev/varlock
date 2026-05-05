import type { APIRoute } from 'astro';
import { ENV } from 'varlock/env';

// Top-level ENV access — runs at module evaluation time.
// Verifies initVarlockEnv runs before user modules.
const TOP_LEVEL_HAS_SECRET = ENV.SENSITIVE_VAR ? 'yes' : 'no';

export const GET: APIRoute = () => {
  const lines = [
    `public_var::${ENV.PUBLIC_VAR}`,
    `env_specific::${ENV.ENV_SPECIFIC_VAR}`,
    `has_secret::${ENV.SENSITIVE_VAR ? 'yes' : 'no'}`,
    `toplevel_has_secret::${TOP_LEVEL_HAS_SECRET}`,
  ];
  return new Response(lines.join('\n'));
};
