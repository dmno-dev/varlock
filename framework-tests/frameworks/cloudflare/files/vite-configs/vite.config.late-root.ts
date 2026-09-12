import { defineConfig } from 'vite';
import { varlockCloudflareVitePlugin } from '@varlock/cloudflare-integration';

// A plugin ordered after varlock's that moves vite's `root` during `config`.
// The Cloudflare plugin resolves its worker configs from this final root, so
// the .dev.vars conflict check has to see it too.
const lateRootPlugin = {
  name: 'late-root',
  config() {
    return { root: 'app' };
  },
};

export default defineConfig({
  plugins: [
    varlockCloudflareVitePlugin({ inspectorPort: false }),
    lateRootPlugin,
  ],
});
