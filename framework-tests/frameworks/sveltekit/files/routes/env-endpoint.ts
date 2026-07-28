import { ENV } from 'varlock/env';

// Server endpoint that reads env at request time. In the built Cloudflare
// worker, ENV is hydrated by the injected runtime loader from the
// `__VARLOCK_ENV` binding.
export const GET = async () => {
  return new Response(
    JSON.stringify({
      PUBLIC_VAR: ENV.PUBLIC_VAR,
      API_URL: ENV.API_URL,
      HAS_SECRET: ENV.SECRET_KEY ? 'yes' : 'no',
    }),
    { headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
};
