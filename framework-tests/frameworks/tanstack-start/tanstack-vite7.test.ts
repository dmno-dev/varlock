import { defineTanstackTests } from './tanstack-shared';

defineTanstackTests('vite7', import.meta.dirname, {
  viteVersion: '^7',
  // @tanstack/react-start 1.169+ requires vite >= 8 (its plugin only sets
  // rolldownOptions, so vite 7 builds fail with `Could not resolve entry module "index.html"`)
  tanstackStartVersion: '~1.168.13',
  portBase: 15300,
  nitroVersion: '3.0.260903-beta',
});
