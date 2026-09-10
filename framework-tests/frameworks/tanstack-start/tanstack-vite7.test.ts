import { defineTanstackTests } from './tanstack-shared';

defineTanstackTests('vite7', import.meta.dirname, {
  viteVersion: '^7',
  portBase: 15300,
  nitroVersion: '3.0.260903-beta',
});
