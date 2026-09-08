/*
Shared TanStack Start test definitions, parameterized by Vite version.
*/
import { randomBytes } from 'node:crypto';
import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

const TANSTACK_DEPS = {
  '@tanstack/react-router': '^1.170.8',
  '@tanstack/react-start': '^1.168.13',
  '@tanstack/router-plugin': '^1.168.11',
  react: '19.2.4',
  'react-dom': '19.2.4',
};

export function defineTanstackTests(
  label: string,
  testDir: string,
  opts: {
    viteVersion: string;
    reactPluginVersion?: string;
    portBase: number;
    /** When set, also runs a TanStack Start + Nitro target describe block, pinned to this nitro version */
    nitroVersion?: string;
  },
) {
  const {
    viteVersion, reactPluginVersion = '^5', portBase, nitroVersion,
  } = opts;
  let nextPort = portBase;
  const port = () => nextPort++;

  // ---- Node target (plain vite plugin) ------------------------------------
  describe(`TanStack Start (${label}) — node target`, () => {
    const nodeEnv = new FrameworkTestEnv({
      testDir,
      framework: `tanstack-start-node-${label}`,
      packageManager: 'pnpm',
      dependencies: {
        varlock: 'will-be-replaced',
        '@varlock/vite-integration': 'will-be-replaced',
        vite: viteVersion,
        '@vitejs/plugin-react': reactPluginVersion,
        ...TANSTACK_DEPS,
      },
      templateFiles: {
        '.env.schema': 'schemas/.env.schema',
        '.env.dev': 'schemas/.env.dev',
        'tsconfig.json': '_base/tsconfig.json',
        'src/routes/__root.tsx': 'routes/__root.tsx',
        'src/routes/index.tsx': 'routes/index.tsx',
        'src/router.tsx': 'routes/router.tsx',
      },
    });
    beforeAll(() => nodeEnv.setup(), 180_000);
    afterAll(() => nodeEnv.teardown());

    nodeEnv.describeDevScenario('dev server', {
      command: `vite dev --port ${port()}`,
      readyPattern: /Local:.*http/,
      readyTimeout: 45_000,
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.node.ts',
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
          description: 'sensitive value is redacted in console output',
          shouldContain: ['secret-log-test::'],
          shouldNotContain: ['super-secret-value'],
        },
      ],
    });

    nodeEnv.describeScenario('static build', {
      command: 'vite build',
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.node.ts',
      },
      fileAssertions: [
        {
          description: 'server bundle does not contain sensitive values',
          fileGlob: 'dist/server/**/*.js',
          shouldNotContain: ['super-secret-value'],
        },
      ],
    });

    nodeEnv.describeDevScenario('build + preview', {
      command: `vite build && vite preview --port ${port()}`,
      readyPattern: /Local:.*http/,
      readyTimeout: 60_000,
      timeout: 120_000,
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.node.ts',
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

    // Top-level ENV access — verifies initVarlockEnv runs before
    // application modules so ENV.x works outside handlers/async fns.
    nodeEnv.describeDevScenario('top-level ENV access (build + preview)', {
      command: `vite build && vite preview --port ${port()}`,
      readyPattern: /Local:.*http/,
      readyTimeout: 60_000,
      timeout: 120_000,
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.node.ts',
        'src/routes/index.tsx': 'routes/index-toplevel.tsx',
        'src/router.tsx': 'routes/router-toplevel.tsx',
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
  });

  // ---- Cloudflare target --------------------------------------------------
  describe(`TanStack Start (${label}) — cloudflare target`, () => {
    const cfEnv = new FrameworkTestEnv({
      testDir,
      framework: `tanstack-start-cf-${label}`,
      packageManager: 'pnpm',
      dependencies: {
        varlock: 'will-be-replaced',
        '@varlock/cloudflare-integration': 'will-be-replaced',
        vite: viteVersion,
        '@vitejs/plugin-react': reactPluginVersion,
        wrangler: '^4',
        '@cloudflare/vite-plugin': '^1.30.0',
        ...TANSTACK_DEPS,
      },
      overrides: {
        punycode: 'npm:punycode@^2.3.1',
      },
      templateFiles: {
        '.env.schema': 'schemas/.env.schema',
        '.env.dev': 'schemas/.env.dev',
        'tsconfig.json': '_base/tsconfig.json',
        'src/routes/__root.tsx': 'routes/__root.tsx',
        'src/routes/index.tsx': 'routes/index.tsx',
        'src/router.tsx': 'routes/router.tsx',
      },
    });
    beforeAll(() => cfEnv.setup(), 180_000);
    afterAll(() => cfEnv.teardown());

    cfEnv.describeDevScenario('dev server', {
      command: `vite dev --port ${port()}`,
      readyPattern: /Local:.*http/,
      readyTimeout: 45_000,
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.cloudflare.ts',
        'wrangler.jsonc': 'configs/wrangler.jsonc',
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
          description: 'sensitive value is redacted in console output',
          shouldContain: ['secret-log-test::'],
          shouldNotContain: ['super-secret-value'],
        },
      ],
    });

    cfEnv.describeScenario('cloudflare build', {
      command: 'vite build',
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.cloudflare.ts',
        'wrangler.jsonc': 'configs/wrangler.jsonc',
      },
      fileAssertions: [
        {
          description: 'server bundle does not contain sensitive values',
          fileGlob: 'dist/server/**/*.js',
          shouldNotContain: ['super-secret-value'],
        },
        {
          description: 'init code is injected only once',
          fileGlob: 'dist/server/**/*.js',
          shouldMatch: [
            // only one initVarlockEnv() call across all server JS files
            /^(?![\s\S]*initVarlockEnv\(\)[\s\S]*initVarlockEnv\(\))[\s\S]*initVarlockEnv\(\)/,
          ],
        },
      ],
    });

    cfEnv.describeDevScenario('build + preview', {
      command: `vite build && vite preview --port ${port()}`,
      readyPattern: /Local:.*http/,
      readyTimeout: 60_000,
      timeout: 120_000,
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.cloudflare.ts',
        'wrangler.jsonc': 'configs/wrangler.jsonc',
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

    // Top-level ENV access — verifies initVarlockEnv runs before
    // application modules so ENV.x works outside handlers/async fns.
    cfEnv.describeDevScenario('top-level ENV access (build + preview)', {
      command: `vite build && vite preview --port ${port()}`,
      readyPattern: /Local:.*http/,
      readyTimeout: 60_000,
      timeout: 120_000,
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.cloudflare.ts',
        'wrangler.jsonc': 'configs/wrangler.jsonc',
        'src/routes/index.tsx': 'routes/index-toplevel.tsx',
        'src/router.tsx': 'routes/router-toplevel.tsx',
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
  });

  // ---- Nitro target (regression coverage for the SSR worker-thread env-key bug) ----
  if (nitroVersion) {
    describe(`TanStack Start (${label}) - nitro target`, () => {
      // Each dev-server scenario below gets its own fixture (its own `pnpm install`)
      // instead of sharing one across the describe block. Nitro v3 beta's dev worker
      // sets up the SSR module-runner over an IPC transport that only initializes
      // cleanly for the FIRST `vite dev` process started against a given install: a
      // second `vite dev` run in the same installed project (even a fresh child
      // process, even with `.nitro`/`.output`/`node_modules/.vite` wiped first)
      // reliably hangs with "Vite environment \"ssr\" is unavailable" (HTTP 500) and
      // never recovers. This reproduces with plain `vite dev` too, independent of
      // `@encryptInjectedEnv` or `_VARLOCK_ENV_KEY`, so it's a Nitro beta issue, not a
      // varlock one. The workaround is to make every dev scenario a "first" run.
      const makeNitroEnv = (suffix: string) => new FrameworkTestEnv({
        testDir,
        framework: `tanstack-start-nitro-${label}-${suffix}`,
        packageManager: 'pnpm',
        dependencies: {
          varlock: 'will-be-replaced',
          '@varlock/vite-integration': 'will-be-replaced',
          vite: viteVersion,
          '@vitejs/plugin-react': reactPluginVersion,
          nitro: nitroVersion,
          ...TANSTACK_DEPS,
        },
        templateFiles: {
          '.env.schema': 'schemas/.env.schema',
          '.env.dev': 'schemas/.env.dev',
          'tsconfig.json': '_base/tsconfig.json',
          'src/routes/__root.tsx': 'routes/__root.tsx',
          'src/routes/index.tsx': 'routes/index.tsx',
          'src/router.tsx': 'routes/router.tsx',
        },
      });

      const nitroDevEnvNoKey = makeNitroEnv('dev-no-key');
      beforeAll(() => nitroDevEnvNoKey.setup(), 180_000);
      afterAll(() => nitroDevEnvNoKey.teardown());

      nitroDevEnvNoKey.describeDevScenario('dev server with @encryptInjectedEnv', {
        command: `vite dev --port ${port()}`,
        readyPattern: /Local:.*http/,
        readyTimeout: 60_000,
        templateFiles: {
          'vite.config.ts': 'configs/vite.config.nitro.ts',
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
            description: 'no _VARLOCK_ENV_KEY error on the SSR worker thread',
            shouldNotContain: ['_VARLOCK_ENV_KEY is not set'],
          },
        ],
      });

      const nitroDevEnvWithKey = makeNitroEnv('dev-with-key');
      beforeAll(() => nitroDevEnvWithKey.setup(), 180_000);
      afterAll(() => nitroDevEnvWithKey.teardown());

      nitroDevEnvWithKey.describeDevScenario('dev server with @encryptInjectedEnv and explicit key', {
        command: `vite dev --port ${port()}`,
        readyPattern: /Local:.*http/,
        readyTimeout: 60_000,
        env: { _VARLOCK_ENV_KEY: randomBytes(32).toString('hex') },
        templateFiles: {
          'vite.config.ts': 'configs/vite.config.nitro.ts',
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
            description: 'no _VARLOCK_ENV_KEY error on the SSR worker thread',
            shouldNotContain: ['_VARLOCK_ENV_KEY is not set'],
          },
        ],
      });

      // Build scenarios don't start the long-lived dev worker, so they don't hit the
      // IPC issue above and can safely share one fixture (and one `pnpm install`).
      const nitroBuildEnv = makeNitroEnv('build');
      beforeAll(() => nitroBuildEnv.setup(), 180_000);
      afterAll(() => nitroBuildEnv.teardown());

      nitroBuildEnv.describeScenario('build with @encryptInjectedEnv and no key fails', {
        command: 'vite build',
        expectSuccess: false,
        templateFiles: {
          'vite.config.ts': 'configs/vite.config.nitro.ts',
          '.env.schema': {
            path: 'schemas/.env.schema',
            prepend: '# @encryptInjectedEnv\n',
          },
        },
        outputAssertions: [
          {
            description: 'build fails with a clear missing-key error',
            shouldContain: ['_VARLOCK_ENV_KEY is not set'],
          },
        ],
      });

      nitroBuildEnv.describeScenario('build with key encrypts the blob', {
        command: 'vite build',
        env: { _VARLOCK_ENV_KEY: randomBytes(32).toString('hex') },
        templateFiles: {
          'vite.config.ts': 'configs/vite.config.nitro.ts',
          '.env.schema': {
            path: 'schemas/.env.schema',
            prepend: '# @encryptInjectedEnv\n',
          },
        },
        fileAssertions: [
          {
            description: 'server output contains encrypted blob (varlock:v1: prefix), not plaintext',
            fileGlob: '.output/server/**/*.mjs',
            shouldContain: ['varlock:v1:'],
            shouldNotContain: ['super-secret-value'],
          },
        ],
      });
    });
  }
}
