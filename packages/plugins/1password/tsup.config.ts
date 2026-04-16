import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/plugin.ts'],
    dts: true,
    sourcemap: true,
    treeshake: true,
    clean: false,
    outDir: 'dist',
    format: ['cjs'],
    splitting: false,
    target: 'esnext',
    external: ['varlock'],
  },
  {
    entry: { 'bridge-cli': 'src/bridge/cli.ts' },
    sourcemap: true,
    treeshake: true,
    clean: false,
    outDir: 'dist',
    format: ['cjs'],
    splitting: false,
    target: 'esnext',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
