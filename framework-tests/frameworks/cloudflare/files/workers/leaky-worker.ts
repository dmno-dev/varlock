import '@varlock/cloudflare-integration/init';
import { ENV } from 'varlock/env';

export default {
  async fetch(): Promise<Response> {
    // Deliberately leak the sensitive value in the response body
    return new Response(`SECRET_KEY=${ENV.SECRET_KEY}`);
  },
};
