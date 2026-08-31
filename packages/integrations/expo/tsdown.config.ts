import { defineConfig } from 'tsdown';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  entry: ['src/babel-plugin.ts', 'src/metro-config.ts'],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: true,
  outDir: 'dist',
  attw: { level: 'error', profile: 'node16' },
  publint: true,
  // Output both CJS (for older Babel/Metro setups) and ESM
  format: ['esm', 'cjs'],
  platform: 'node',

  // package name + version baked in as static defines so we don't import package.json into the bundle
  define: {
    __VARLOCK_INTEGRATION_NAME__: JSON.stringify(pkg.name),
    __VARLOCK_INTEGRATION_VERSION__: JSON.stringify(pkg.version),
  },
});
