import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [ // Entry point(s)
    'src/index.ts',
  ],

  dts: true,

  // minify: true, // Minify output
  sourcemap: true, // Generate sourcemaps
  treeshake: true, // Remove unused code

  clean: true, // Clean output directory before building
  outDir: 'dist', // Output directory

  format: ['esm'], // Output format(s)
  splitting: false,
});
