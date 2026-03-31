import type { APIRoute } from 'astro';
import { ENV } from 'varlock/env';

export const GET: APIRoute = () => {
  // Deliberately leak the sensitive value in the response body
  return new Response(`SENSITIVE_VAR=${ENV.SENSITIVE_VAR}`);
};
