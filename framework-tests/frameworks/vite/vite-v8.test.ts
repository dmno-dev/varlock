import { defineViteTests } from './vite-shared';

defineViteTests('vite8', import.meta.dirname, {
  viteVersion: '^8',
  basePort: 15220,
});
