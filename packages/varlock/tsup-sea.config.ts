/*
  tsup config used to build a single-executable build of varlock
  this will be processed by pkg to create a binary that is bundled with nodejs
*/

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli/cli-executable.ts'],
  // this forces all deps to be bundled in
  // (pkg has lots of issues unless we do this)
  noExternal: [/(.*)/],
  sourcemap: true, // Generate sourcemaps
  treeshake: true, // Remove unused code
  clean: true, // Clean output directory before building
  outDir: 'dist-sea', // Output directory
  format: ['cjs'], // pkg likes cjs
  splitting: false,
  keepNames: true,
  esbuildOptions(options) {
    options.define ||= {};
    options.define.__VARLOCK_SEA_BUILD__ = 'true';
    options.define.__VARLOCK_BUILD_TYPE__ = JSON.stringify(process.env.BUILD_TYPE || 'dev');
  },
});
