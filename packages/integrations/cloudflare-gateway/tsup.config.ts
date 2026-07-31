import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],

  // `varlock/proxy-core` stays an import (varlock is a peer dep, and its subpath
  // ships working types) - the consumer's wrangler build bundles it into the
  // worker. platform 'neutral' keeps node builtins out of this package too.
  external: ['varlock/proxy-core'],

  dts: true,

  sourcemap: true,
  treeshake: true,

  clean: true,
  outDir: 'dist',

  format: ['esm'],
  splitting: false,
  platform: 'neutral',
});
