import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { varlockSvelteKitCloudflarePlugin } from '@varlock/cloudflare-integration/sveltekit';
import { defineConfig } from 'vite';

// the deprecated Cloudflare-specific wrapper, kept working for back-compat
export default defineConfig({
  plugins: [
    varlockSvelteKitCloudflarePlugin(),
    sveltekit({ adapter: adapter() }),
  ],
});
