import { defineCloudflareTests } from './cloudflare-shared';

defineCloudflareTests('vite7', import.meta.dirname, {
  viteVersion: '^7',
  basePort: 15183,
});
