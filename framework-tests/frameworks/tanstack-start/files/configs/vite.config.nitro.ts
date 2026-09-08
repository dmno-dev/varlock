import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { varlockVitePlugin } from '@varlock/vite-integration';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';

export default defineConfig({
  plugins: [
    varlockVitePlugin({ ssrInjectMode: 'resolved-env' }),
    tanstackStart(),
    nitro(),
    viteReact(),
  ],
});
