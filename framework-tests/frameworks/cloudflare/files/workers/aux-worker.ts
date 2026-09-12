import { ENV } from 'varlock/env';

// Top-level ENV access — throws if varlock's env never reached this worker.
const TOP_LEVEL_API_URL = ENV.API_URL;

export default {
  async fetch(_request: Request, env: Record<string, string>): Promise<Response> {
    return new Response([
      `aux_public_var::${ENV.PUBLIC_VAR}`,
      `aux_api_url::${TOP_LEVEL_API_URL}`,
      `aux_has_sensitive::${ENV.SECRET_KEY ? 'yes' : 'no'}`,
      // cloudflare native env access — vars injected into the auxiliary worker
      `aux_native_public_var::${env.PUBLIC_VAR}`,
      `aux_native_has_secret::${env.SECRET_KEY ? 'yes' : 'no'}`,
    ].join('\n'));
  },
};
