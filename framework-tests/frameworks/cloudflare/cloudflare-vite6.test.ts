import { defineCloudflareTests } from './cloudflare-shared';

defineCloudflareTests('vite6', import.meta.dirname, {
  viteVersion: '^6',
  basePort: 15173,
});
