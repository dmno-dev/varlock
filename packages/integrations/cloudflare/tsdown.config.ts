import { defineConfig } from 'tsdown';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/sveltekit.ts',
    'src/init.ts',
    'src/varlock-wrangler.ts',
    'src/shared-ssr-entry-code.ts',
  ],

  // package name + version baked in as static defines so we don't import package.json into the bundle
  define: {
    __VARLOCK_INTEGRATION_NAME__: JSON.stringify(pkg.name),
    __VARLOCK_INTEGRATION_VERSION__: JSON.stringify(pkg.version),
  },

  // cloudflare:workers is a runtime-only module (workerd/miniflare)
  // @cloudflare/vite-plugin is a peer dep, don't bundle it
  external: ['cloudflare:workers', '@cloudflare/vite-plugin', 'vite'],
  // bundle the vite integration so consumers don't need it as a separate dep
  noExternal: ['@varlock/vite-integration'],

  dts: true,

  sourcemap: true,
  treeshake: true,

  clean: true,
  outDir: 'dist',
  attw: { level: 'error', profile: 'esm-only' },
  publint: true,

  format: ['esm'],
  platform: 'node',
});
