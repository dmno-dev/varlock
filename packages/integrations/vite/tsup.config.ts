import { defineConfig } from 'tsup';
import pkg from './package.json';

export default defineConfig({
  entry: [ // Entry point(s)
    'src/index.ts',
  ],

  // package name + version baked in as static defines so we don't import package.json into the bundle
  esbuildOptions(options) {
    options.define ||= {};
    options.define.__VARLOCK_INTEGRATION_NAME__ = JSON.stringify(pkg.name);
    options.define.__VARLOCK_INTEGRATION_VERSION__ = JSON.stringify(pkg.version);
  },

  dts: true,

  // minify: true, // Minify output
  sourcemap: true, // Generate sourcemaps
  treeshake: true, // Remove unused code

  clean: true, // Clean output directory before building
  outDir: 'dist', // Output directory

  format: ['esm'], // Output format(s)
  splitting: false,
});
