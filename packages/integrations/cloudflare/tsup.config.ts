import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/varlock-wrangler.ts',
  ],

  dts: true,

  sourcemap: true,
  treeshake: true,

  clean: true,
  outDir: 'dist',

  format: ['esm'],
  splitting: false,
});
