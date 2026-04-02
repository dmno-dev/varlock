import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

describe('Astro Integration', () => {
  const astroEnv = new FrameworkTestEnv({
    testDir: import.meta.dirname,
    framework: 'astro',
    packageManager: 'pnpm',
    dependencies: {
      astro: '^5',
      varlock: 'will-be-replaced',
      '@varlock/astro-integration': 'will-be-replaced',
      '@astrojs/node': '^9',
    },
    templateFiles: {
      '.env.schema': 'schemas/.env.schema',
      '.env.dev': 'schemas/.env.dev',
      '.env.prod': 'schemas/.env.prod',
    },
  });

  beforeAll(() => astroEnv.setup(), 180_000);
  afterAll(() => astroEnv.teardown());

  // ---- Static output mode ----

  describe('static output', () => {
    astroEnv.describeScenario('basic page', {
      command: 'astro build',
      templateFiles: {
        'src/pages/index.astro': 'pages/basic-page.astro',
        'astro.config.mts': 'configs/astro.config.static.mts',
      },
      fileAssertions: [
        {
          description: 'env vars are injected into output',
          fileGlob: 'dist/**/*.html',
          shouldContain: [
            'public-var-value',
            'unprefixed-public-var',
            'env-specific-var--dev',
            'sensitive-var-available',
          ],
          shouldNotContain: ['super-secret-value'],
        },
      ],
      outputAssertions: [
        {
          description: 'secret is redacted from stdout',
          shouldContain: ['secret-log-test:'],
          shouldNotContain: ['super-secret-value'],
        },
      ],
    });

    astroEnv.describeScenario('env-specific vars use prod environment', {
      command: 'astro build',
      env: { APP_ENV: 'prod' },
      templateFiles: {
        'src/pages/index.astro': 'pages/basic-page.astro',
        'astro.config.mts': 'configs/astro.config.static.mts',
      },
      fileAssertions: [
        {
          description: 'prod-specific value is present (APP_ENV=prod)',
          fileGlob: 'dist/**/*.html',
          shouldContain: ['env-specific-var--prod'],
          shouldNotContain: ['env-specific-var--dev', 'env-specific-var--default'],
        },
      ],
    });

    astroEnv.describeScenario('leaky static page', {
      command: 'astro build',
      templateFiles: {
        'src/pages/index.astro': 'pages/leaky-page.astro',
        'astro.config.mts': 'configs/astro.config.static.mts',
      },
      expectSuccess: false,
      outputAssertions: [
        {
          description: 'output contains leak detection message',
          shouldContain: ['DETECTED LEAKED SENSITIVE CONFIG'],
        },
      ],
    });

    astroEnv.describeScenario('leaky client script', {
      command: 'astro build',
      templateFiles: {
        'src/pages/index.astro': 'pages/leaky-client-script.astro',
        'astro.config.mts': 'configs/astro.config.static.mts',
      },
      expectSuccess: false,
      outputAssertions: [
        {
          description: 'output contains leak detection message',
          shouldContain: ['DETECTED LEAKED SENSITIVE CONFIG'],
        },
      ],
    });

    astroEnv.describeScenario('empty optional sensitive var', {
      command: 'astro build',
      templateFiles: {
        'src/pages/index.astro': 'pages/empty-secret-page.astro',
        'astro.config.mts': 'configs/astro.config.static.mts',
        '.env.schema': 'schemas/.env.schema.empty-secret',
      },
      fileAssertions: [
        {
          description: 'public var is still injected',
          fileGlob: 'dist/**/*.html',
          shouldContain: ['public-var-value'],
        },
        {
          description: 'empty secret is handled correctly',
          fileGlob: 'dist/**/*.html',
          shouldContain: ['empty-is-undefined:true'],
        },
      ],
    });

    astroEnv.describeScenario('non-existent var access fails build', {
      command: 'astro build',
      templateFiles: {
        'src/pages/index.astro': 'pages/bad-var-page.astro',
        'astro.config.mts': 'configs/astro.config.static.mts',
      },
      expectSuccess: false,
      outputAssertions: [
        {
          description: 'error mentions non-existent var',
          shouldContain: ['THIS_VAR_DOES_NOT_EXIST'],
        },
      ],
    });

    astroEnv.describeScenario('env vars accessible in astro config', {
      command: 'astro build',
      templateFiles: {
        'src/pages/index.astro': 'pages/env-in-config-page.astro',
        'astro.config.mts': 'configs/astro.config.env-check.mts',
      },
      fileAssertions: [
        {
          description: 'config env var is verified',
          fileGlob: 'dist/**/*.html',
          shouldContain: ['config-env-ok'],
        },
      ],
    });

    astroEnv.describeScenario('invalid schema causes build failure', {
      command: 'astro build',
      expectSuccess: false,
      templateFiles: {
        'src/pages/index.astro': 'pages/basic-page.astro',
        'astro.config.mts': 'configs/astro.config.static.mts',
        '.env.schema': 'schemas/.env.schema.invalid',
      },
      outputAssertions: [
        {
          description: 'build output indicates config validation failure',
          shouldContain: ['MISSING_REQUIRED_VAR'],
        },
      ],
    });
  });

  // ---- Server output mode (SSR with dev server) ----

  describe('server output', () => {
    astroEnv.describeDevScenario('basic SSR page', {
      command: 'astro dev --port 14321',
      readyPattern: /http:\/\/localhost/,
      readyTimeout: 30_000,
      templateFiles: {
        'src/pages/index.astro': 'pages/server-basic-page.astro',
        'astro.config.mts': 'configs/astro.config.server.mts',
      },
      requests: [
        {
          path: '/',
          bodyAssertions: {
            shouldContain: [
              'public-var-value',
              'unprefixed-public-var',
              'env-specific-var--dev',
              'sensitive-var-available',
            ],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
      outputAssertions: [
        {
          description: 'sensitive value is redacted in console output',
          shouldContain: ['secret-log-test:'],
          shouldNotContain: ['super-secret-value'],
        },
      ],
    });

    astroEnv.describeDevScenario('leaky SSR page', {
      command: 'astro dev --port 14322',
      readyPattern: /http:\/\/localhost/,
      readyTimeout: 30_000,
      templateFiles: {
        'src/pages/index.astro': 'pages/leaky-server-page.astro',
        'astro.config.mts': 'configs/astro.config.server.mts',
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

    astroEnv.describeDevScenario('API endpoint', {
      command: 'astro dev --port 14323',
      readyPattern: /http:\/\/localhost/,
      readyTimeout: 30_000,
      templateFiles: {
        'src/pages/index.astro': 'pages/basic-page.astro',
        'src/pages/api/health.ts': 'pages/api-endpoint.ts',
        'astro.config.mts': 'configs/astro.config.server.mts',
      },
      requests: [
        {
          path: '/api/health',
          bodyAssertions: {
            shouldContain: [
              'public_var::public-var-value',
              'has_secret::yes',
            ],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
    });

    astroEnv.describeDevScenario('leaky API endpoint', {
      command: 'astro dev --port 14324',
      readyPattern: /http:\/\/localhost/,
      readyTimeout: 30_000,
      templateFiles: {
        'src/pages/index.astro': 'pages/basic-page.astro',
        'src/pages/api/leak.ts': 'pages/leaky-api-endpoint.ts',
        'astro.config.mts': 'configs/astro.config.server.mts',
      },
      requests: [
        {
          path: '/api/leak',
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

    astroEnv.describeDevScenario('non-existent var access in API endpoint', {
      command: 'astro dev --port 14325',
      readyPattern: /http:\/\/localhost/,
      readyTimeout: 30_000,
      templateFiles: {
        'src/pages/index.astro': 'pages/basic-page.astro',
        'src/pages/api/bad.ts': 'pages/bad-var-api-endpoint.ts',
        'astro.config.mts': 'configs/astro.config.server.mts',
      },
      requests: [
        {
          path: '/api/bad',
          expectedStatus: 500,
          bodyAssertions: {
            shouldNotContain: ['THIS_VAR_DOES_NOT_EXIST'],
          },
        },
      ],
      outputAssertions: [
        {
          description: 'error mentions non-existent var',
          shouldContain: ['THIS_VAR_DOES_NOT_EXIST'],
        },
      ],
    });

    astroEnv.describeDevScenario('env reload on file change', {
      command: 'astro dev --port 14326',
      readyPattern: /http:\/\/localhost/,
      readyTimeout: 30_000,
      templateFiles: {
        'src/pages/index.astro': 'pages/server-basic-page.astro',
        'astro.config.mts': 'configs/astro.config.server.mts',
      },
      requests: [
        // first request — original value
        {
          path: '/',
          bodyAssertions: {
            shouldContain: ['public-var:public-var-value'],
          },
        },
        // second request — after editing .env.schema to change PUBLIC_VAR
        {
          path: '/',
          fileEdits: {
            '.env.schema': [
              '# @defaultSensitive=false @defaultRequired=infer',
              '# @generateTypes(lang="ts", path="env.d.ts")',
              '# @currentEnv=$APP_ENV',
              '# ---',
              '',
              '# @type=enum(dev, preview, prod, test)',
              'APP_ENV=dev',
              '',
              'PUBLIC_VAR=updated-public-value',
              'UNPREFIXED_PUBLIC=unprefixed-public-var',
              'ENV_SPECIFIC_VAR=env-specific-var--default',
              '',
              '# @sensitive',
              'SENSITIVE_VAR=super-secret-value',
            ].join('\n'),
          },
          // Astro reloads config in-place without restarting the server,
          // so the readyPattern never re-appears — use a fixed delay instead
          fileEditDelay: 3_000,
          bodyAssertions: {
            shouldContain: ['public-var:updated-public-value'],
            shouldNotContain: ['public-var:public-var-value'],
          },
        },
      ],
    });

    // Note: unlike Vite, Astro's dev server exits entirely when config is
    // invalid (initVarlockEnv fails during config loading), so we cannot test
    // dev server recovery from invalid config. The static build failure case
    // is covered above in "invalid schema causes build failure".
  });
});
