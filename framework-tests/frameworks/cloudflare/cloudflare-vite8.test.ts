import { defineCloudflareTests } from './cloudflare-shared';

defineCloudflareTests('vite8', import.meta.dirname, {
  viteVersion: '^8',
  basePort: 15193,
});
