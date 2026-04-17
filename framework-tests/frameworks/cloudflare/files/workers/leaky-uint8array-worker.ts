import { ENV } from 'varlock/env';

export default {
  async fetch(): Promise<Response> {
    // Deliberately leak the sensitive value via a Uint8Array body
    // Cloudflare Workers commonly return ArrayBuffer/Uint8Array bodies,
    // and scanForLeaks must detect secrets in these as well
    const encoder = new TextEncoder();
    return new Response(encoder.encode(`SECRET_KEY=${ENV.SECRET_KEY}`));
  },
};
