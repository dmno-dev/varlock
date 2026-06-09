import { defineConfig } from 'vite';
import { varlockVitePlugin } from '@varlock/vite-integration';

export default defineConfig({
  plugins: [varlockVitePlugin({ ssrInjectMode: 'resolved-env' })],
});
