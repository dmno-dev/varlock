import { defineConfig } from 'tsdown';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  entry: ['src/index.ts'],

  // package name + version baked in as static defines so we don't import package.json into the bundle
  define: {
    __VARLOCK_INTEGRATION_NAME__: JSON.stringify(pkg.name),
    __VARLOCK_INTEGRATION_VERSION__: JSON.stringify(pkg.version),
  },

  // type-only import, and consumers get it from their own nuxt install. Bundling it
  // drags in the whole nuxt type graph (h3, postcss, autoprefixer...), much of which is
  // CommonJS d.ts that rolldown-plugin-dts cannot inline.
  external: ['@nuxt/schema'],

  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: true,
  outDir: 'dist',
  attw: { level: 'error', profile: 'esm-only' },
  publint: true,
  format: ['esm'],
  platform: 'node',
});
