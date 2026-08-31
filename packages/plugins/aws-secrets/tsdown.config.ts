import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/plugin.ts'],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: false,
  outDir: 'dist',
  attw: { level: 'error', profile: 'node16' },
  publint: true,
  format: ['cjs'],
  platform: 'node',
  target: 'esnext',
  external: ['varlock'],
});
