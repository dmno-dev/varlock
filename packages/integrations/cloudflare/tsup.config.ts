import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/init.ts',
    'src/varlock-wrangler.ts',
  ],

  // cloudflare:workers is a runtime-only module (workerd/miniflare)
  // @cloudflare/vite-plugin is a peer dep, don't bundle it
  external: ['cloudflare:workers', '@cloudflare/vite-plugin'],

  dts: true,

  sourcemap: true,
  treeshake: true,

  clean: true,
  outDir: 'dist',

  format: ['esm'],
  splitting: false,
});
