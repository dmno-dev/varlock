import { defineConfig } from 'vite';
import { varlockCloudflareVitePlugin } from '@varlock/cloudflare-integration';

export default defineConfig({
  plugins: [
    varlockCloudflareVitePlugin({
      inspectorPort: false,
    }),
  ],
});
