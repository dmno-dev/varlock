import { defineConfig } from 'vite';
import { varlockVitePlugin } from '@varlock/vite-integration';
import { ENV } from 'varlock/env';

export default defineConfig({
  plugins: [
    varlockVitePlugin(),
    {
      name: 'test-leaky-middleware',
      configureServer(server) {
        server.middlewares.use('/api/leak', (_req, res) => {
          res.setHeader('content-type', 'text/plain');
          res.end(`secret: ${ENV.SECRET_KEY}`);
        });
        server.middlewares.use('/api/safe', (_req, res) => {
          res.setHeader('content-type', 'text/plain');
          res.end(`public: ${ENV.PUBLIC_VAR}`);
        });
      },
    },
  ],
});
