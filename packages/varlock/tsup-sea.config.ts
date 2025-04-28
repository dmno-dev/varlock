import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/cli/cli-executable.ts', // cli that gets run via `dmno` command
  ],

  dts: true,

  // minify: true, // Minify output
  sourcemap: true, // Generate sourcemaps
  treeshake: true, // Remove unused code

  clean: true, // Clean output directory before building
  outDir: 'dist-sea', // Output directory

  format: ['cjs', 'esm'], // Output format(s)

  noExternal: [/(.*)/],

  splitting: false,
  keepNames: true,
});
