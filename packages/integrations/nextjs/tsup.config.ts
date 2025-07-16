import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [ // Entry point(s)
    'src/next-env-compat.ts',
    'src/plugin.ts',

    'src/patch-next-runtime.ts',
  ],

  dts: true,

  // minify: true, // Minify output
  sourcemap: true, // Generate sourcemaps
  treeshake: true, // Remove unused code

  clean: true, // Clean output directory before building
  outDir: 'dist', // Output directory

  // ! we are exporting cjs to match @next/env
  format: ['cjs'], // Output format(s)
  splitting: false,
});
