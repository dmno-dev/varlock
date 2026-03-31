import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/plugin.ts'],
  dts: false,
  sourcemap: true,
  treeshake: true,
  clean: false,
  outDir: 'dist',
  format: ['cjs'],
  splitting: false,
  target: 'esnext',
  external: ['varlock'],
});
