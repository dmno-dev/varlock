import { ENV } from 'varlock/env';

// Top-level ENV access — runs at module evaluation time, not per-request.
// Verifies initVarlockEnv runs before worker module body.
const TOP_LEVEL_API_URL = ENV.API_URL;
const TOP_LEVEL_HAS_SECRET = ENV.SECRET_KEY ? 'yes' : 'no';

export default {
  async fetch(_request: Request, env: Record<string, string>): Promise<Response> {
    // this should be redacted in varlock-wrangler output
    console.log('secret-log-test::', ENV.SECRET_KEY);

    return new Response([
      // varlock ENV proxy - non-sensitive vars
      `public_var::${ENV.PUBLIC_VAR}`,
      `api_url::${ENV.API_URL}`,
      // varlock ENV proxy - sensitive var (check accessible without leaking value)
      `has_sensitive::${ENV.SECRET_KEY ? 'yes' : 'no'}`,
      // top-level ENV access (evaluated at module load, not per-request)
      `toplevel_api_url::${TOP_LEVEL_API_URL}`,
      `toplevel_has_secret::${TOP_LEVEL_HAS_SECRET}`,
      // cloudflare native env access (injected by varlock-wrangler --env-file)
      `native_public_var::${env.PUBLIC_VAR}`,
      `native_has_secret::${env.SECRET_KEY ? 'yes' : 'no'}`,
    ].join('\n'));
  },
};
