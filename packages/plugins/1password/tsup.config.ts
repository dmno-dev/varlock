import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [ // Entry point(s)
    'src/plugin.ts',
  ],

  dts: true,

  // minify: true, // Minify output
  sourcemap: true, // Generate sourcemaps
  treeshake: true, // Remove unused code

  clean: false, // Clean output directory before building
  outDir: 'dist', // Output directory

  format: ['cjs'], // Output format(s)
  splitting: false,

  target: 'esnext',
  external: ['varlock'],
});
