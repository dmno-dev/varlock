import { defineTanstackTests } from './tanstack-shared';

defineTanstackTests('vite8', import.meta.dirname, {
  viteVersion: '^8',
  reactPluginVersion: '^6',
  portBase: 15400,
  nitroVersion: '3.0.260903-beta',
});
