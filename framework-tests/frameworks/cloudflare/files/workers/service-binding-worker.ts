import { ENV } from 'varlock/env';

export default {
  async fetch(_request: Request, env: Record<string, any>): Promise<Response> {
    // call through the service binding so the auxiliary worker actually boots
    const auxResponse = await env.AUX.fetch(new Request('https://aux.example.com/'));
    const auxBody = await auxResponse.text();

    return new Response([
      `entry_public_var::${ENV.PUBLIC_VAR}`,
      `entry_has_sensitive::${ENV.SECRET_KEY ? 'yes' : 'no'}`,
      auxBody,
    ].join('\n'));
  },
};
