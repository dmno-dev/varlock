import { defineConfig } from 'tsup';
import pkg from './package.json';

export default defineConfig({
  entry: ['src/index.ts'],

  esbuildOptions(options) {
    options.define ||= {};
    options.define.__VARLOCK_INTEGRATION_NAME__ = JSON.stringify(pkg.name);
    options.define.__VARLOCK_INTEGRATION_VERSION__ = JSON.stringify(pkg.version);
  },

  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: true,
  outDir: 'dist',
  format: ['esm'],
  splitting: false,
});
