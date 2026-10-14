import { defineConfig } from 'tsdown';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  entry: ['src/index.ts'],

  // package name + version baked in as static defines so we don't import package.json into the bundle
  define: {
    __VARLOCK_INTEGRATION_NAME__: JSON.stringify(pkg.name),
    __VARLOCK_INTEGRATION_VERSION__: JSON.stringify(pkg.version),
  },

  // peers and workspace deps are never bundled
  external: [/^alchemy(\/|$)/, /^effect(\/|$)/, /^varlock(\/|$)/],

  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: true,
  outDir: 'dist',
  attw: { level: 'error', profile: 'esm-only' },
  publint: true,
  format: ['esm'],
  platform: 'node',
});
