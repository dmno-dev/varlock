import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { varlockVitePlugin } from '@varlock/vite-integration';
import viteReact from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    varlockVitePlugin(),
    tanstackStart(),
    viteReact(),
  ],
});
