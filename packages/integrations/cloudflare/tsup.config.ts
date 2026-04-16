import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/init.ts',
    'src/sveltekit.ts',
    'src/varlock-wrangler.ts',
  ],

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

  format: ['esm'],
  splitting: false,
});
