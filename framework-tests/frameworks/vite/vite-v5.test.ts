import { defineViteTests } from './vite-shared';

defineViteTests('vite5', import.meta.dirname, {
  viteVersion: '^5',
  basePort: 15200,
});
