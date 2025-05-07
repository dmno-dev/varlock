import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/simple-resolver.ts'],
  dts: true,
  // minify: true, // Minify output
  sourcemap: true, // Generate sourcemaps
  treeshake: true, // Remove unused code
  clean: true, // Clean output directory before building
  outDir: 'dist', // Output directory
  format: ['esm', 'cjs'], // Output format(s)
  splitting: true,
  keepNames: true, // stops build from prefixing our class names with `_` in some cases
});
