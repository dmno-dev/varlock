import { defineConfig } from 'tsdown';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  entry: [ // Entry point(s)
    'src/index.ts',
  ],

  // package name + version baked in as static defines so we don't import package.json into the bundle
  define: {
    __VARLOCK_INTEGRATION_NAME__: JSON.stringify(pkg.name),
    __VARLOCK_INTEGRATION_VERSION__: JSON.stringify(pkg.version),
  },

  dts: true,

  sourcemap: true, // Generate sourcemaps
  treeshake: true, // Remove unused code

  clean: true, // Clean output directory before building
  outDir: 'dist', // Output directory
  attw: { level: 'error', profile: 'esm-only' },
  publint: true,

  format: ['esm'], // Output format(s)
  platform: 'node',
});
