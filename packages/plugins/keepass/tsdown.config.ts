import path from 'node:path';
import { defineConfig } from 'tsdown';

const XMLDOM_SHIM = path.resolve(import.meta.dirname, 'src/xmldom-compat.ts');

export default defineConfig({
  entry: ['src/plugin.ts'],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: false,
  outDir: 'dist',
  attw: { level: 'error', profile: 'node16' },
  publint: true,
  format: ['cjs'],
  platform: 'node',
  target: 'esnext',
  external: ['varlock'],
  // plugins must build to a single file: varlock executes plugin.cjs itself (not via
  // require), so a split chunk that requires ./plugin.cjs would re-run the entry
  // outside of the plugin context. see #1113
  outputOptions: { codeSplitting: false },
  // point kdbxweb's xmldom import at our compat wrapper (see src/xmldom-compat.ts).
  // an `alias` can't do this: it prefix-matches subpaths, so the shim's own
  // import would resolve back into the shim.
  plugins: [
    {
      name: 'xmldom-compat',
      resolveId(source: string, importer: string | undefined) {
        if (source !== '@xmldom/xmldom') return null;
        // let the shim itself reach the real package
        if (importer === XMLDOM_SHIM) return null;
        return XMLDOM_SHIM;
      },
    },
  ],
});
