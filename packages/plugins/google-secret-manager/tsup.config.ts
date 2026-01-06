import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/plugin.ts'],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: false,
  outDir: 'dist',
  format: ['esm'],
  splitting: false,
  target: 'esnext',
  external: ['varlock'],
  banner: ({ format }) => {
    if (format === 'esm') {
      return ({
        js: [
          'import { createRequire } from \'module\';',
          'const require = createRequire(import.meta.url);',
          'const __dirname = new URL(\'.\', import.meta.url).pathname;',
          'const __filename = new URL(\'./plugin.cjs\', import.meta.url).pathname;',
        ].join('\n'),
      });
    }
    return {};
  },
});
