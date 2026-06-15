import { ENV, getPublicDynamicEnv } from 'varlock/env';

export const GET = async () => {
  const keys = ['PUBLIC_DYNAMIC_VAR'];
  const payload = getPublicDynamicEnv(keys) as Record<string, unknown>;
  for (const key of keys) {
    if (payload[key] !== undefined) continue;
    if (process.env[key] !== undefined) {
      payload[key] = process.env[key];
      continue;
    }
    const envVal = (ENV as any)[key];
    if (envVal !== undefined) payload[key] = envVal;
  }
  return new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};
