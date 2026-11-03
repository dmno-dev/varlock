import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { varlockVitePlugin } from '@varlock/vite-integration';
import { defineConfig } from 'vite';

// SvelteKit 3 dropped svelte.config.js: the adapter is configured inline
export default defineConfig({
  plugins: [
    varlockVitePlugin(),
    sveltekit({ adapter: adapter() }),
  ],
});
