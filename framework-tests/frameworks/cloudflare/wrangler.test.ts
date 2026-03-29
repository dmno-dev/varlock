/*
Tests varlock + cloudflare integration using only `varlock-wrangler`
*/
import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

describe('Cloudflare Workers varlock-wrangler only', () => {
  const wranglerEnv = new FrameworkTestEnv({
    testDir: import.meta.dirname,
    framework: 'cloudflare-wrangler',
    packageManager: 'bun',
    dependencies: {
      varlock: 'will-be-replaced',
      '@varlock/cloudflare-integration': 'will-be-replaced',
      wrangler: '^4',
    },
    templateFiles: {
      '.env.schema': 'schemas/.env.schema',
      '.env.dev': 'schemas/.env.dev',
    },
    packageJsonMerge: {
      scripts: {
        dev: 'varlock-wrangler dev',
      },
    },
  });
  beforeAll(() => wranglerEnv.setup(), 180_000);
  afterAll(() => wranglerEnv.teardown());

  wranglerEnv.describeDevScenario('basic worker', {
    command: 'varlock-wrangler dev --port 18787',
    readyPattern: /Ready on/,
    readyTimeout: 30_000,
    templateFiles: {
      'src/index.ts': 'workers/basic-worker.ts',
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
            // cloudflare native env access (injected via --env-file)
            'native_public_var::public-test-value',
            'native_has_secret::yes',
          ],
          shouldNotContain: ['super-secret-value'],
        },
      },
    ],
    outputAssertions: [
      {
        description: 'varlock notice appears in dev output',
        shouldContain: ['varlock'],
      },
      {
        description: 'sensitive value is redacted in console output',
        shouldContain: ['secret-log-test::'],
        shouldNotContain: ['super-secret-value'],
      },
    ],
  });

  wranglerEnv.describeDevScenario('leaky worker', {
    command: 'varlock-wrangler dev --port 18788',
    readyPattern: /Ready on/,
    readyTimeout: 30_000,
    templateFiles: {
      'src/index.ts': 'workers/leaky-worker.ts',
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

  wranglerEnv.describeDevScenario('large env (chunking)', {
    command: 'varlock-wrangler dev --port 18789',
    readyPattern: /Ready on/,
    readyTimeout: 30_000,
    templateFiles: {
      'src/index.ts': 'workers/large-env-worker.ts',
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

  wranglerEnv.describeScenario('types generation', {
    command: 'varlock-wrangler types',
    templateFiles: {
      'src/index.ts': 'workers/basic-worker.ts',
      'wrangler.jsonc': '_base-wrangler/wrangler.jsonc',
      'tsconfig.json': '_base-wrangler/tsconfig.json',
    },
    fileAssertions: [
      {
        description: 'generated types include varlock env vars',
        filePath: 'worker-configuration.d.ts',
        shouldContain: [
          'PUBLIC_VAR',
          'API_URL',
          'SECRET_KEY',
        ],
        shouldNotContain: ['__VARLOCK_ENV'],
      },
    ],
  });
});
