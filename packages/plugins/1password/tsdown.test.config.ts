import { defineConfig } from 'tsdown';

/**
 * Test-only build config — identical to production except `@1password/sdk`
 * is external so tests can mock it via `require.cache`.
 */
export default defineConfig({
  entry: ['src/plugin.ts'],
  dts: false,
  sourcemap: true,
  treeshake: true,
  clean: false,
  outDir: 'dist-test',
  format: ['cjs'],
  platform: 'node',
  target: 'esnext',
  external: ['varlock', '@1password/sdk'],
  // plugins must build to a single file: varlock executes plugin.cjs itself (not via
  // require), so a split chunk that requires ./plugin.cjs would re-run the entry
  // outside of the plugin context. see #1113
  outputOptions: { codeSplitting: false },
});
