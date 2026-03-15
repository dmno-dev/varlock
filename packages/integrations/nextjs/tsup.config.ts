import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: [ // Entry point(s)
      'src/next-env-compat.ts',
      'src/plugin.ts',

      'src/edge-env.ts',
      'src/turbopack-loader.ts',
    ],

    dts: true,

    // minify: true, // Minify output
    sourcemap: true, // Generate sourcemaps
    treeshake: true, // Remove unused code

    clean: false, // handled by build script to avoid race with second config
    outDir: 'dist', // Output directory

    // ! we are exporting cjs to match @next/env
    format: ['cjs'], // Output format(s)
    splitting: false,
  },
  // Self-contained bundles that get injected as raw JS (not processed by webpack/turbopack).
  // All dependencies must be bundled inline (noExternal) since these files are read
  // and prepended to runtime files at build time.
  {
    entry: {
      'varlock-env-inline': 'src/varlock-env-inline.ts',
      'patch-next-runtime': 'src/patch-next-runtime.ts',
    },
    noExternal: [/.*/],
    clean: false,
    sourcemap: false,
    treeshake: true,
    outDir: 'dist',
    format: ['cjs'],
    splitting: false,
    dts: false,
  },
]);
