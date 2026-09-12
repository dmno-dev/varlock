/*
Shared Cloudflare Workers test definitions, parameterized by Vite version.
Covers basic worker dev, leak detection, build + preview, auxiliary (multi-)workers,
and large env chunking.
*/
import { randomBytes } from 'node:crypto';
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
      packageManager: 'pnpm',
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
              // top-level ENV access (module evaluation time, not per-request)
              'toplevel_api_url::https://api.example.com',
              'toplevel_has_secret::yes',
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
          shouldContain: [
            'secret-log-test::',
            // error object logged directly - redacted, not passed through raw
            'error-log-test::',
            // error nested in a plain object - message survives (not hollowed to `{}`)
            'wrapped-error-test::',
            // circular object - printed and redacted rather than bypassing redaction
            'circular-log-test::',
          ],
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
      command: `vite build && pnpm exec vite preview --port ${basePort + 3}`,
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
              'toplevel_api_url::https://api.example.com',
              'toplevel_has_secret::yes',
            ],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
    });

    cfEnv.describeDevScenario('encrypted env blob with _VARLOCK_ENV_KEY', {
      command: `vite dev --port ${basePort + 5}`,
      readyPattern: /Local:.*http/,
      readyTimeout: 30_000,
      env: { _VARLOCK_ENV_KEY: randomBytes(32).toString('hex') },
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

    // `@encryptInjectedEnv` with no key on a Cloudflare dev target: workerd
    // cannot read host env vars, so the dev blob falls back to plaintext instead
    // of shipping an encrypted blob the worker could never decrypt. Dev must
    // keep working and never surface a key or decrypt error.
    cfEnv.describeDevScenario('@encryptInjectedEnv with no key still serves in dev', {
      command: `vite dev --port ${basePort + 6}`,
      readyPattern: /Local:.*http/,
      readyTimeout: 30_000,
      templateFiles: {
        'src/index.ts': 'workers/basic-worker.ts',
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'wrangler.jsonc': '_base-wrangler/wrangler.jsonc',
        'tsconfig.json': '_base-wrangler/tsconfig.json',
        '.env.schema': {
          path: 'schemas/.env.schema',
          prepend: '# @encryptInjectedEnv\n',
        },
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
      outputAssertions: [
        {
          description: 'no key or decrypt errors on the workerd side',
          shouldNotContain: ['_VARLOCK_ENV_KEY is not set', 'unable to authenticate data'],
        },
      ],
    });

    cfEnv.describeDevScenario('auxiliary workers', {
      command: `vite dev --port ${basePort + 7}`,
      readyPattern: /Local:.*http/,
      readyTimeout: 30_000,
      templateFiles: {
        'src/index.ts': 'workers/service-binding-worker.ts',
        'src/aux.ts': 'workers/aux-worker.ts',
        'vite.config.ts': 'vite-configs/vite.config.auxiliary.ts',
        'wrangler.jsonc': '_base-wrangler/wrangler.service-binding.jsonc',
        'wrangler.aux.jsonc': '_aux-wrangler/wrangler.aux.jsonc',
        'tsconfig.json': '_base-wrangler/tsconfig.json',
      },
      requests: [
        {
          path: '/',
          bodyAssertions: {
            shouldContain: [
              'entry_public_var::public-test-value',
              'entry_has_sensitive::yes',
              // the auxiliary worker gets its own __VARLOCK_ENV binding + vars
              'aux_public_var::public-test-value',
              'aux_api_url::https://api.example.com',
              'aux_has_sensitive::yes',
              'aux_native_public_var::public-test-value',
              'aux_native_has_secret::yes',
            ],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
    });

    cfEnv.describeDevScenario('auxiliary workers (build + preview)', {
      command: `vite build && pnpm exec vite preview --port ${basePort + 8}`,
      readyPattern: /Local:.*http/,
      readyTimeout: 60_000,
      timeout: 120_000,
      templateFiles: {
        'src/index.ts': 'workers/service-binding-worker.ts',
        'src/aux.ts': 'workers/aux-worker.ts',
        'vite.config.ts': 'vite-configs/vite.config.auxiliary.ts',
        'wrangler.jsonc': '_base-wrangler/wrangler.service-binding.jsonc',
        'wrangler.aux.jsonc': '_aux-wrangler/wrangler.aux.jsonc',
        'tsconfig.json': '_base-wrangler/tsconfig.json',
      },
      requests: [
        {
          path: '/',
          bodyAssertions: {
            shouldContain: [
              'entry_public_var::public-test-value',
              'entry_has_sensitive::yes',
              // each worker's build output gets its own .dev.vars injection
              'aux_public_var::public-test-value',
              'aux_api_url::https://api.example.com',
              'aux_has_sensitive::yes',
              'aux_native_public_var::public-test-value',
              'aux_native_has_secret::yes',
            ],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
    });

    // Wrangler reads `.dev.vars` from each worker's config directory, and those
    // values become `secret_text` bindings that overwrite varlock's injected
    // vars — leaving the native `env` object disagreeing with varlock's `ENV`.
    // The guard has to cover auxiliary worker directories, not just the root.
    cfEnv.describeScenario('.dev.vars beside an auxiliary worker config is rejected', {
      command: 'vite build',
      expectSuccess: false,
      templateFiles: {
        'src/index.ts': 'workers/service-binding-worker.ts',
        'workers/aux/src/index.ts': 'workers/aux-worker.ts',
        'vite.config.ts': 'vite-configs/vite.config.auxiliary.nested.ts',
        'wrangler.jsonc': '_base-wrangler/wrangler.service-binding.jsonc',
        'workers/aux/wrangler.jsonc': '_aux-wrangler/wrangler.aux.nested.jsonc',
        'tsconfig.json': '_base-wrangler/tsconfig.json',
      },
      files: [{ path: 'workers/aux/.dev.vars', content: 'PUBLIC_VAR=shadowed-by-dev-vars\n' }],
      outputAssertions: [
        {
          description: 'error names the auxiliary worker .dev.vars path',
          shouldContain: ['workers/aux/.dev.vars', 'conflicts with varlock'],
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
