import { defineConfig } from 'vitest/config';

export default defineConfig({
  // resolve `varlock/proxy-core` to monorepo source (same condition tsconfig uses)
  // so tests don't require varlock's dist to be built first
  resolve: {
    conditions: ['ts-src'],
  },
  test: {
    name: '@varlock/cloudflare-gateway',
  },
});
