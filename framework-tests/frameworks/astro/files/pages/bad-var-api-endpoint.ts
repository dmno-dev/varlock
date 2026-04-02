import type { APIRoute } from 'astro';
import { ENV } from 'varlock/env';

export const GET: APIRoute = () => {
  // Accessing a var that does not exist in the schema - should cause an error
  const badVar = (ENV as any).THIS_VAR_DOES_NOT_EXIST;
  return new Response(`bad-var:${badVar}`);
};
