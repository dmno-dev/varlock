import '@varlock/cloudflare-integration/init';
import { ENV } from 'varlock/env';

export default {
  async fetch(): Promise<Response> {
    return new Response([
      `public_var::${ENV.PUBLIC_VAR}`,
      `large_var_a_length::${ENV.LARGE_VAR_A?.length ?? 0}`,
      `large_var_b_length::${ENV.LARGE_VAR_B?.length ?? 0}`,
      `has_secret::${ENV.SECRET_KEY ? 'yes' : 'no'}`,
    ].join('\n'));
  },
};
