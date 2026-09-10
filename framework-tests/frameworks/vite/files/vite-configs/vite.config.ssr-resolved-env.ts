import { defineConfig } from 'vite';
import { varlockVitePlugin } from '@varlock/vite-integration';

// Renders the SSR entry through vite's in-process SSR module loader, so the
// injected varlock init module (and its encrypted blob) runs inside `vite dev`
export default defineConfig({
  plugins: [
    varlockVitePlugin({ ssrInjectMode: 'resolved-env' }),
    {
      name: 'test-ssr-render-middleware',
      configureServer(server) {
        server.middlewares.use('/ssr', async (_req, res) => {
          const mod = await server.ssrLoadModule('/src/ssr-entry.ts');
          res.setHeader('content-type', 'text/html');
          res.end(mod.render());
        });
      },
    },
  ],
});
