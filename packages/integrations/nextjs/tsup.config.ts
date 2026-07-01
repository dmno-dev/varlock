import { defineConfig } from 'tsup';
import pkg from './package.json';

// package name + version baked in as static defines so we don't import package.json into the bundle
function defineIntegrationIdentity(options: { define?: Record<string, string> }) {
  options.define ||= {};
  options.define.__VARLOCK_INTEGRATION_NAME__ = JSON.stringify(pkg.name);
  options.define.__VARLOCK_INTEGRATION_VERSION__ = JSON.stringify(pkg.version);
}

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

    // ! we are exporting cjs to match @next/env
    format: ['cjs'],
    splitting: false,

    esbuildOptions: defineIntegrationIdentity,
  },
  // Other entry points only run at build time where varlock is always available.
  {
    entry: [
      'src/plugin.ts',
      'src/loader.ts',
    ],

    dts: true,
    sourcemap: true,
    treeshake: true,

    clean: false, // don't clean - first config already cleaned
    outDir: 'dist',

    format: ['cjs'],
    splitting: false,
  },
]);
