/*
Tests varlock + cloudflare integration using the cloudflare vite plugin (and our wrapper)
*/
import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

describe('Cloudflare Workers w/ vite plugin', () => {
  const cloudflareViteEnv = new FrameworkTestEnv({
    testDir: import.meta.dirname,
    framework: 'cloudflare-vite',
    packageManager: 'bun',
    dependencies: {
      varlock: 'will-be-replaced',
      '@varlock/cloudflare-integration': 'will-be-replaced',
      vite: '^6',
      wrangler: '^4',
      '@cloudflare/vite-plugin': '^1',
    },
    templateFiles: {
      '.env.schema': 'schemas/.env.schema',
      '.env.dev': 'schemas/.env.dev',
    },
  });
  beforeAll(() => cloudflareViteEnv.setup(), 180_000);
  afterAll(() => cloudflareViteEnv.teardown());

  cloudflareViteEnv.describeDevScenario('basic worker', {
    command: 'vite dev --port 15173',
    readyPattern: /Local:.*http/,
    readyTimeout: 30_000,
    templateFiles: {
      'src/index.ts': 'workers/basic-worker.ts',
      'vite.config.ts': 'vite-configs/vite.config.ts',
      'wrangler.jsonc': '_base-wrangler/wrangler.jsonc',
      'tsconfig.json': '_base-wrangler/tsconfig.json',
    },
    requests: [
      {
        path: '/',
        bodyAssertions: {
          shouldContain: [
            // varlock ENV proxy - non-sensitive
            'public_var::public-test-value',
            'api_url::https://api.example.com',
            // varlock ENV proxy - sensitive (accessible but value not leaked)
            'has_sensitive::yes',
            // cloudflare native env access
            'native_public_var::public-test-value',
            'native_has_secret::yes',
          ],
          shouldNotContain: ['super-secret-value'],
        },
      },
    ],
    outputAssertions: [
      {
        description: 'sensitive value is redacted in console output',
        shouldContain: ['secret-log-test::'],
        shouldNotContain: ['super-secret-value'],
      },
    ],
  });

  cloudflareViteEnv.describeDevScenario('leaky worker', {
    command: 'vite dev --port 15174',
    readyPattern: /Local:.*http/,
    readyTimeout: 30_000,
    templateFiles: {
      'src/index.ts': 'workers/leaky-worker.ts',
      'vite.config.ts': 'vite-configs/vite.config.ts',
      'wrangler.jsonc': '_base-wrangler/wrangler.jsonc',
      'tsconfig.json': '_base-wrangler/tsconfig.json',
    },
    requests: [
      {
        path: '/',
        expectedStatus: 500,
        bodyAssertions: {
          shouldNotContain: ['super-secret-value'],
        },
      },
    ],
    outputAssertions: [
      {
        description: 'leak detection message appears',
        shouldContain: ['DETECTED LEAKED SENSITIVE CONFIG'],
      },
    ],
  });

  cloudflareViteEnv.describeDevScenario('large env (chunking)', {
    command: 'vite dev --port 15175',
    readyPattern: /Local:.*http/,
    readyTimeout: 30_000,
    templateFiles: {
      'src/index.ts': 'workers/large-env-worker.ts',
      'vite.config.ts': 'vite-configs/vite.config.ts',
      'wrangler.jsonc': '_base-wrangler/wrangler.jsonc',
      'tsconfig.json': '_base-wrangler/tsconfig.json',
      '.env.schema': 'schemas/.env.schema.large',
    },
    requests: [
      {
        path: '/',
        bodyAssertions: {
          shouldContain: [
            'public_var::public-test-value',
            // two 3000-char vars — verify they survived __VARLOCK_ENV chunking
            'large_var_a_length::3000',
            'large_var_b_length::3000',
            'has_secret::yes',
          ],
        },
      },
    ],
  });
});
