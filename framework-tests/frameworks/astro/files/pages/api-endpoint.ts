import type { APIRoute } from 'astro';
import { ENV } from 'varlock/env';

export const GET: APIRoute = () => {
  const lines = [
    `public_var::${ENV.PUBLIC_VAR}`,
    `env_specific::${ENV.ENV_SPECIFIC_VAR}`,
    `has_secret::${ENV.SENSITIVE_VAR ? 'yes' : 'no'}`,
  ];
  return new Response(lines.join('\n'));
};
