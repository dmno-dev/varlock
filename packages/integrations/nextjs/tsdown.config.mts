import { defineConfig } from 'tsdown';
import pkg from './package.json' with { type: 'json' };

// package name + version baked in as static defines so we don't import package.json into the bundle
const integrationIdentity = {
  __VARLOCK_INTEGRATION_NAME__: JSON.stringify(pkg.name),
  __VARLOCK_INTEGRATION_VERSION__: JSON.stringify(pkg.version),
};

export default defineConfig([
  // next-env-compat is the @next/env replacement and runs at both build time AND runtime.
  // On Vercel, the bundled server inlines @next/env so its dependencies (varlock) are not
  // traced into the serverless function. Bundle varlock modules directly to avoid runtime
  // "Cannot find module 'varlock'" errors.
  // See: https://github.com/dmno-dev/varlock/issues/584
  {
    entry: ['src/next-env-compat.ts'],

    noExternal: [/^varlock/],

    dts: true,
    sourcemap: true,
    treeshake: true,

    clean: true,
    outDir: 'dist',
    attw: { level: 'error', profile: 'node16' },
    publint: true,

    // ! we are exporting cjs to match @next/env
    format: ['cjs'],
    platform: 'node',

    define: integrationIdentity,
  },
  // Other entry points only run at build time where varlock is always available.
  // These require() varlock's runtime entry points, which is why varlock ships real CJS
  // builds of them (`require` condition): require() of an .mjs file breaks Node <22.12
  // (no require(esm)) and breaks Next's next.config.ts loader, whose require hook
  // re-transpiles required .mjs files to CJS but Node still evaluates them as ESM
  // ("exports is not defined in ES module scope").
  {
    entry: [
      'src/plugin.ts',
      'src/loader.ts',
      'src/dynamic-access.ts',
    ],

    dts: true,
    sourcemap: true,
    treeshake: true,

    clean: false, // don't clean - first config already cleaned
    outDir: 'dist',

    format: ['cjs'],
    platform: 'node',
  },
]);
