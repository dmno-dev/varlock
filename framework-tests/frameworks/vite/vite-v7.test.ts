import { defineViteTests } from './vite-shared';

defineViteTests('vite7', import.meta.dirname, {
  viteVersion: '^7',
  basePort: 15230,
});
