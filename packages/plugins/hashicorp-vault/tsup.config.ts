import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/plugin.ts'],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: false,
  outDir: 'dist',
  format: ['esm'],
  splitting: false,
  target: 'esnext',
  external: ['varlock'],
});
