import { defineConfig } from 'tsup';

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
