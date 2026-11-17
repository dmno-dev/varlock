import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@varlock/ts-content-mapper',
    // every test runs a real `tsc --runExternalCode`, which starts the mapper process
    testTimeout: 60_000,
  },
});
