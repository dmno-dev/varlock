import { getPublicDynamicEnv } from 'varlock/env';

export const GET = async () => new Response(JSON.stringify(getPublicDynamicEnv()), {
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
});
