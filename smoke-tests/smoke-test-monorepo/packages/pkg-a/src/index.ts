import { ENV } from 'varlock/env';

// Use pkg-a's env vars
export function getPort(): number {
  return ENV.PORT;
}

export function getRedisUrl(): string {
  return ENV.REDIS_URL;
}

export type SharedConfig = { port: number; redisUrl: string };
