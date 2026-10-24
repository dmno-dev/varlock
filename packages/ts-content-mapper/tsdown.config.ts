import { defineConfig } from 'tsdown';

export default defineConfig({
  // server.ts is the content mapper process TypeScript starts (`typescript.contentMapper.exec` in package.json)
  entry: ['src/server.ts'],
  dts: false,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
});
