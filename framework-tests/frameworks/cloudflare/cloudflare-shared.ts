/*
Shared Cloudflare Workers test definitions, parameterized by Vite version.
Covers basic worker dev, leak detection, build + preview, and large env chunking.
*/
import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

export function defineCloudflareTests(
  label: string,
  testDir: string,
  opts: {
    viteVersion: string;
    /** Base port — each dev scenario offsets from this */
    basePort: number;
  },
) {
  const { viteVersion, basePort } = opts;

  describe(`Cloudflare Workers (${label})`, () => {
    const cfEnv = new FrameworkTestEnv({
      testDir,
      framework: `cloudflare-vite-${label}`,
      packageManager: 'bun',
      dependencies: {
        varlock: 'will-be-replaced',
        '@varlock/cloudflare-integration': 'will-be-replaced',
        vite: viteVersion,
        wrangler: '^4',
        '@cloudflare/vite-plugin': '^1.30.0',
      },
      templateFiles: {
        '.env.schema': 'schemas/.env.schema',
        '.env.dev': 'schemas/.env.dev',
      },
      overrides: {
        punycode: 'npm:punycode@^2.3.1',
      },
    });
    beforeAll(() => cfEnv.setup(), 180_000);
    afterAll(() => cfEnv.teardown());

    cfEnv.describeDevScenario('basic worker', {
      command: `vite dev --port ${basePort}`,
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

    cfEnv.describeDevScenario('leaky worker', {
      command: `vite dev --port ${basePort + 1}`,
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

    cfEnv.describeDevScenario('leaky worker (Uint8Array body)', {
      command: `vite dev --port ${basePort + 2}`,
      readyPattern: /Local:.*http/,
      readyTimeout: 30_000,
      templateFiles: {
        'src/index.ts': 'workers/leaky-uint8array-worker.ts',
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
          description: 'leak detection message appears for Uint8Array body',
          shouldContain: ['DETECTED LEAKED SENSITIVE CONFIG'],
        },
      ],
    });

    cfEnv.describeDevScenario('build + preview', {
      command: `vite build && vite preview --port ${basePort + 3}`,
      readyPattern: /Local:.*http/,
      readyTimeout: 60_000,
      timeout: 120_000,
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
              'public_var::public-test-value',
              'api_url::https://api.example.com',
              'has_sensitive::yes',
            ],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
    });

    cfEnv.describeDevScenario('large env (chunking)', {
      command: `vite dev --port ${basePort + 4}`,
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
}
