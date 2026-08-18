import { defineConfig } from 'tsup';

// Transport-agnostic proxy core, exposed as the `varlock/proxy-core` subpath
// for gateway adapters (e.g. a Cloudflare Worker) that can't use node builtins.
// Built as its own self-contained bundle with `platform: 'neutral'`, so the
// build FAILS if a node-only import ever sneaks into src/proxy/core.
//
// A separate config file (run after the main `tsup` in the build script) rather
// than another entry in tsup.config.ts's array: tsup builds array configs in
// parallel, and the main config's dts pass deletes this entry's d.ts output.
export default defineConfig({
  entry: { 'proxy-core': 'src/proxy/core/index.ts' },

  clean: false,
  sourcemap: true,
  treeshake: true,
  outDir: 'dist',
  format: ['esm'],
  splitting: false,
  dts: true,
  platform: 'neutral',
});
