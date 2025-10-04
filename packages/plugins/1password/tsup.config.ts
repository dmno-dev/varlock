import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [ // Entry point(s)
    'src/plugin.ts',
    // 'src/cli.ts',
  ],

  dts: true,

  // minify: true, // Minify output
  sourcemap: true, // Generate sourcemaps
  treeshake: true, // Remove unused code

  clean: false, // Clean output directory before building
  outDir: 'dist', // Output directory

  format: ['esm'], // Output format(s)
  splitting: false,

  target: 'esnext',
  external: ['varlock'],
  // noExternal: [/.*/],
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
