import { defineTanstackTests } from './tanstack-shared';

defineTanstackTests('vite7', import.meta.dirname, {
  viteVersion: '^7',
  // @tanstack/react-start 1.169+ requires vite >= 8 (its plugin only sets
  // rolldownOptions, so vite 7 builds fail with `Could not resolve entry module "index.html"`).
  // Keep covering the last line that supports vite 7.
  tanstackStartVersion: '~1.168.13',
  portBase: 15300,
});
