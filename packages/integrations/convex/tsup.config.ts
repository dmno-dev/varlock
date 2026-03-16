import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/plugin.ts',
    'src/cli.ts',
  ],

  dts: true,

  sourcemap: true,
  treeshake: true,

  clean: true,
  outDir: 'dist',

  format: ['esm'],
  splitting: false,
  target: 'esnext',
  external: ['varlock'],
});
