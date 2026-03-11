import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/babel-plugin.ts'],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: true,
  outDir: 'dist',
  // Output both CJS (for older Babel/Metro setups) and ESM
  format: ['esm', 'cjs'],
  splitting: false,
});
