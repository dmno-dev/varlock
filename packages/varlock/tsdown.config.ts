import { defineConfig, type UserConfig } from 'tsdown';

// Self-contained init bundles for framework integrations.
// These are injected as raw JS (webpack) or imported from a copied location (turbopack).
// Each gets its own build so rolldown has nothing to hoist into a shared chunk: a
// `require('./chunk-xyz.cjs')` inside these would not resolve where they get injected.
function initBundle(name: string): UserConfig {
  return {
    entry: { [`runtime/${name}`]: `src/runtime/${name}.ts` },
    noExternal: [/.*/],
    clean: false,
    sourcemap: false,
    treeshake: true,
    outDir: 'dist',
    format: ['cjs'],
    dts: true,
    platform: 'node',
    target: 'node22',
  };
}

export default defineConfig([
  {
    entry: [ // Entry point(s)
      'src/index.ts',

      'src/runtime/env.ts',
      'src/runtime/patch-server-response.ts',
      'src/runtime/patch-console.ts',
      'src/runtime/patch-response.ts',

      'src/runtime/crypto.ts',
      'src/auto-load.ts',
      'src/dotenv-compat.ts', // exposed under `/config` to match dotenv

      'src/cli/cli-executable.ts', // cli that gets run via `dmno` command
      'src/lib/exec-sync-varlock.ts', // helper to call varlock cli from code

      'src/plugin-lib.ts',
    ],

    noExternal: ['@env-spec/utils'],

    // types from `noExternal` deps get inlined into the emitted d.mts
    dts: true,

    sourcemap: true, // Generate sourcemaps
    treeshake: true, // Remove unused code

    clean: true, // Clean output directory before building
    outDir: 'dist', // Output directory

    publint: true, // validate the published package shape
    attw: {
      level: 'error',
      // varlock is esm-only: the node10 algorithm and `require()` from a cjs consumer
      // are both out of scope (engines.node is >=22.3, and require(esm) covers the rest)
      profile: 'esm-only',
      // internal test harness, deliberately only reachable via the `ts-src` condition
      excludeEntrypoints: ['./test-helpers'],
    },

    format: ['esm'], // Output format(s)

    // code splitting is always on in tsdown, which is what we want here: it stops us
    // getting multiple copies of classes and breaking instanceof

    platform: 'node',
    target: 'node22',

    outputOptions: {
      // rolldown otherwise rewrites bare `require` into a shim that calls
      // createRequire(import.meta.url) at module scope. import.meta.url is undefined in
      // workerd, so that crashes on load, and it also defeats the `typeof require ===
      // 'function'` guards that keep these modules evaluable in edge runtimes.
      polyfillRequire: false,
    },

    define: {
      __VARLOCK_SEA_BUILD__: 'false',
      __VARLOCK_BUILD_TYPE__: JSON.stringify(process.env.BUILD_TYPE || 'dev'),
    },

    // checking if the current command is `dev` and adjusting the watch paths accordingly
    watch: process.env.npm_lifecycle_event === 'dev' ? [
      'src',
      'env-graph',
      // internal libraries that we are bundling into this one rather than publishing
      '../utils/src',
    ] : false,

    // On release builds, drop embedded third-party source from the sourcemaps
    // shipped in the npm tarball. Mappings stay intact (frames still resolve),
    // and our own source stays embedded. Dev/local builds keep full maps.
    onSuccess: process.env.BUILD_TYPE === 'release'
      ? 'bun run scripts/strip-vendor-sourcemap-content.ts'
      : undefined,
  },
  initBundle('init-server'),
  initBundle('init-edge'),
]);
