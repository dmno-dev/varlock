import { defineTanstackTests } from './tanstack-shared';

defineTanstackTests('vite8', import.meta.dirname, {
  viteVersion: '^8',
  reactPluginVersion: '^6',
});
