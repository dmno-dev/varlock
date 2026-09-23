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
  // plugins must build to a single file: varlock executes plugin.cjs itself (not via
  // require), so a split chunk that requires ./plugin.cjs would re-run the entry
  // outside of the plugin context. see #1113
  outputOptions: { codeSplitting: false },
});
