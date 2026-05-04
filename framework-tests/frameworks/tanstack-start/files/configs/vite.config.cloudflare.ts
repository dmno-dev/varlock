import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { varlockCloudflareVitePlugin } from '@varlock/cloudflare-integration';
import viteReact from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    varlockCloudflareVitePlugin({
      inspectorPort: false,
      viteEnvironment: { name: 'ssr' },
    }),
    tanstackStart(),
    viteReact(),
  ],
});
