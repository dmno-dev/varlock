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
          'import { fileURLToPath } from \'url\';',
          'const require = createRequire(import.meta.url);',
          'const __dirname = fileURLToPath(new URL(\'.\', import.meta.url));',
          'const __filename = fileURLToPath(new URL(\'./plugin.cjs\', import.meta.url));',
        ].join('\n'),
      });
    }
    return {};
  },
});
