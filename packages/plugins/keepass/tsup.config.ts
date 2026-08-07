import path from 'node:path';
import { defineConfig } from 'tsup';

const XMLDOM_SHIM = path.resolve(import.meta.dirname, 'src/xmldom-compat.ts');

export default defineConfig({
  entry: ['src/plugin.ts'],
  dts: false,
  sourcemap: true,
  treeshake: true,
  clean: false,
  outDir: 'dist',
  format: ['cjs'],
  splitting: false,
  target: 'esnext',
  external: ['varlock'],
  // point kdbxweb's xmldom import at our compat wrapper (see src/xmldom-compat.ts).
  // esbuild's `alias` option can't do this: it prefix-matches subpaths, so the shim's
  // own import would resolve back into the shim.
  esbuildPlugins: [
    {
      name: 'xmldom-compat',
      setup(build) {
        build.onResolve({ filter: /^@xmldom\/xmldom$/ }, (args) => {
          // let the shim itself reach the real package
          if (args.importer === XMLDOM_SHIM) return undefined;
          return { path: XMLDOM_SHIM };
        });
      },
    },
  ],
});
