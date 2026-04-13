import { ENV } from 'varlock/env';
import type { SharedConfig } from '@smoke/pkg-a';

// Use pkg-b's env vars
export function getApiKey(): string {
  return ENV.API_KEY;
}

// Import a type from pkg-a to trigger tsc following into pkg-a's source
export function makeConfig(shared: SharedConfig): SharedConfig & { apiKey: string } {
  return { ...shared, apiKey: ENV.API_KEY };
}
