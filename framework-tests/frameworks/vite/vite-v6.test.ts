import { defineViteTests } from './vite-shared';

defineViteTests('vite6', import.meta.dirname, {
  viteVersion: '^6',
  basePort: 15210,
});
