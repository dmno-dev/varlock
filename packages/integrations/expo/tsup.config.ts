import { defineConfig } from 'tsup';
import pkg from './package.json';

export default defineConfig({
  entry: ['src/babel-plugin.ts', 'src/metro-config.ts'],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: true,
  outDir: 'dist',
  // Output both CJS (for older Babel/Metro setups) and ESM
  format: ['esm', 'cjs'],
  splitting: false,

  // package name + version baked in as static defines so we don't import package.json into the bundle
  esbuildOptions(options) {
    options.define ||= {};
    options.define.__VARLOCK_INTEGRATION_NAME__ = JSON.stringify(pkg.name);
    options.define.__VARLOCK_INTEGRATION_VERSION__ = JSON.stringify(pkg.version);
  },
});
