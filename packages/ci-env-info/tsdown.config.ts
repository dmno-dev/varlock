import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: true,
  outDir: 'dist',
  attw: { level: 'error', profile: 'esm-only' },
  publint: true,
  format: ['esm'],
  platform: 'node',
  target: 'esnext',
});
