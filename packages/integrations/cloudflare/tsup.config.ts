import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/init.ts',
    'src/varlock-wrangler.ts',
  ],

  // cloudflare:workers is a runtime-only module (workerd/miniflare)
  external: ['cloudflare:workers'],

  dts: true,

  sourcemap: true,
  treeshake: true,

  clean: true,
  outDir: 'dist',

  format: ['esm'],
  splitting: false,
});
