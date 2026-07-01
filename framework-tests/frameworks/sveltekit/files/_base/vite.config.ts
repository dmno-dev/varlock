import { sveltekit } from '@sveltejs/kit/vite';
import { varlockVitePlugin } from '@varlock/vite-integration';
import { defineConfig } from 'vite';

// Note: the SAME plugin works for every deploy target. With the Cloudflare
// adapter configured in svelte.config.js, varlockVitePlugin() auto-detects it
// and injects the Workers runtime env-loader — no separate import needed.
export default defineConfig({
  plugins: [
    varlockVitePlugin(),
    sveltekit(),
  ],
});
