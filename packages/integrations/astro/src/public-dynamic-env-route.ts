import type { APIRoute } from 'astro';
import { getPublicDynamicEnv } from 'varlock/env';

export const prerender = false;

export const GET: APIRoute = () => new Response(
  JSON.stringify(getPublicDynamicEnv()),
  {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  },
);
