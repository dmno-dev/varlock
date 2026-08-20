import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/extension.ts'],
  clean: true, // Clean output directory before building
  outDir: 'dist', // Output directory
  format: ['cjs'], // Output format(s)
  // VSCode loads the extension entry by the `main` field; keep the .js name it expects
  outExtensions: () => ({ js: '.js' }),
  sourcemap: true, // Keep TS breakpoints mapped cleanly in the extension host
  external: ['vscode'],
  platform: 'node',
});
