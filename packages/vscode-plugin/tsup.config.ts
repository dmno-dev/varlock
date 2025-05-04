import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/extension.ts'],
  clean: true, // Clean output directory before building
  outDir: 'dist', // Output directory
  format: ['cjs'], // Output format(s)
  splitting: false, // split output into chunks - MUST BE ON! or we get issues with multiple copies of classes and instanceof
  keepNames: true, // stops build from prefixing our class names with `_` in some cases
  external: ['vscode'],
  platform: 'node',
});
