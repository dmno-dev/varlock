import { defineConfig } from 'tsdown';

/**
 * Test-only build config — identical to production except `@infisical/sdk`
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
  external: ['varlock', '@infisical/sdk'],
});
