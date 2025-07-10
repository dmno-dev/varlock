import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [ // Entry point(s)
    'src/index.ts',

    'src/runtime/env.ts',
    'src/runtime/patch-server-response.ts',
    'src/runtime/patch-console.ts',
    'src/runtime/patch-response.ts',

    'src/env.ts',
    'src/auto-load.ts',
    'src/dotenv-compat.ts', // exposed under `/config` to match dotenv

    'src/cli/lib/init-process.ts', // not actually used, but this helps make esbuild hoist this import to the top when it is used
    'src/cli/cli-executable.ts', // cli that gets run via `dmno` command
  ],

  noExternal: ['@env-spec/env-graph', '@env-spec/utils'],

  dts: true,

  sourcemap: true, // Generate sourcemaps
  treeshake: true, // Remove unused code

  clean: true, // Clean output directory before building
  outDir: 'dist', // Output directory

  format: ['esm'], // Output format(s)

  splitting: true, // split output into chunks - MUST BE ON! or we get issues with multiple copies of classes and instanceof
  keepNames: true, // stops build from prefixing our class names with `_` in some cases

  platform: 'node',
  target: 'node22',

  // checking if the current command is `dev` and adjusting the watch paths accordingly
  watch: process.env.npm_lifecycle_event === 'dev' ? [
    'src',
    // internal libraries that we are bundling into this one rather than publishing
    '../env-graph/src',
    '../utils/src',
  ] : false,

  esbuildOptions(options) {
    options.define ||= {};
    options.define.__VARLOCK_SEA_BUILD__ = 'false';
  },
});
