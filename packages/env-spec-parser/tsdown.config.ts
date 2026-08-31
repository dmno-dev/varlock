import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/simple-resolver.ts'],
  dts: true,
  sourcemap: true, // Generate sourcemaps
  treeshake: true, // Remove unused code
  clean: true, // Clean output directory before building
  outDir: 'dist', // Output directory
  attw: { level: 'error', profile: 'node16' },
  publint: true,
  format: ['esm', 'cjs'], // Output format(s)
  platform: 'node',
});
