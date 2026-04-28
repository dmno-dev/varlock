/*
Tests varlock + vite integration (plain Vite SPA and SSR builds).
Covers static builds, HTML constant replacement, leak detection,
log redaction, sourcemap scrubbing, SSR init injection, and dev server.
*/
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

describe('Vite', () => {
  const viteEnv = new FrameworkTestEnv({
    testDir: import.meta.dirname,
    framework: 'vite',
    packageManager: 'pnpm',
    dependencies: {
      vite: '^6',
      varlock: 'will-be-replaced',
      '@varlock/vite-integration': 'will-be-replaced',
    },
    templateFiles: {
      '.env.schema': 'schemas/.env.schema',
      '.env.dev': 'schemas/.env.dev',
      '.env.prod': 'schemas/.env.prod',
    },
  });

  beforeAll(() => viteEnv.setup(), 180_000);
  afterAll(() => viteEnv.teardown());

  // ---- Static SPA build ----

  describe('static build', () => {
    viteEnv.describeScenario('basic page with public vars', {
      command: 'vite build',
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/basic.html',
        'src/main.ts': 'pages/basic-page.ts',
      },
      fileAssertions: [
        {
          description: 'public env vars are statically replaced in JS output',
          fileGlob: 'dist/assets/*.js',
          shouldContain: [
            'public-test-value',
            'https://api.example.com',
            'env-specific-dev',
          ],
          shouldNotContain: [
            'super-secret-value',
            'env-specific-default',
          ],
        },
        {
          description: 'HTML entry is present in output',
          filePath: 'dist/index.html',
          shouldContain: ['Varlock Vite Test'],
        },
      ],
    });

    viteEnv.describeScenario('env-specific vars use correct environment (dev)', {
      command: 'vite build',
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/basic.html',
        'src/main.ts': 'pages/basic-page.ts',
      },
      fileAssertions: [
        {
          description: 'dev-specific value is present (APP_ENV=dev)',
          fileGlob: 'dist/assets/*.js',
          shouldContain: ['env-specific-dev'],
          shouldNotContain: ['env-specific-prod', 'env-specific-default'],
        },
      ],
    });

    viteEnv.describeScenario('env-specific vars use prod environment', {
      command: 'vite build',
      env: { APP_ENV: 'prod' },
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/basic.html',
        'src/main.ts': 'pages/basic-page.ts',
      },
      fileAssertions: [
        {
          description: 'prod-specific value is present (APP_ENV=prod)',
          fileGlob: 'dist/assets/*.js',
          shouldContain: ['env-specific-prod'],
          shouldNotContain: ['env-specific-dev', 'env-specific-default'],
        },
      ],
    });

    viteEnv.describeScenario('sensitive var not inlined in client code', {
      command: 'vite build',
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/basic.html',
        'src/main.ts': 'pages/sensitive-ref-page.ts',
      },
      fileAssertions: [
        {
          description: 'sensitive value is absent from client JS',
          fileGlob: 'dist/assets/*.js',
          shouldNotContain: ['super-secret-value'],
        },
        {
          description: 'public var is still replaced',
          fileGlob: 'dist/assets/*.js',
          shouldContain: ['public-test-value'],
        },
      ],
    });
  });

  // ---- HTML constant replacement ----

  describe('HTML constant replacement', () => {
    viteEnv.describeScenario('public vars replaced in HTML via %ENV.x%', {
      command: 'vite build',
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/html-replacement.html',
        'src/main.ts': 'pages/minimal-page.ts',
      },
      fileAssertions: [
        {
          description: 'HTML has public var values in place of %ENV.x% placeholders',
          filePath: 'dist/index.html',
          shouldContain: [
            'public-test-value',
            'https://api.example.com',
            'env-specific-dev',
          ],
          shouldNotContain: [
            '%ENV.',
            'super-secret-value',
          ],
        },
      ],
    });

    viteEnv.describeScenario('sensitive var in HTML causes build failure', {
      command: 'vite build',
      expectSuccess: false,
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/leaky-html.html',
        'src/main.ts': 'pages/minimal-page.ts',
      },
      outputAssertions: [
        {
          description: 'error mentions sensitive config item',
          shouldContain: ['SECRET_KEY', 'sensitive'],
        },
      ],
    });
  });

  // ---- Sourcemap scrubbing ----

  describe('sourcemaps', () => {
    viteEnv.describeScenario('secrets are not present in sourcemaps', {
      command: 'vite build',
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.sourcemaps.ts',
        'index.html': 'html/basic.html',
        'src/main.ts': 'pages/basic-page.ts',
      },
      fileAssertions: [
        {
          description: 'sourcemaps do not contain the sensitive value',
          fileGlob: 'dist/assets/*.js.map',
          shouldNotContain: ['super-secret-value'],
        },
        {
          description: 'JS output still has public vars',
          fileGlob: 'dist/assets/*.js',
          shouldContain: ['public-test-value'],
        },
      ],
    });
  });

  // ---- Log redaction during build ----

  describe('log redaction', () => {
    viteEnv.describeScenario('sensitive value redacted from build stdout', {
      command: 'vite build',
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.log-test.ts',
        'index.html': 'html/basic.html',
        'src/main.ts': 'pages/minimal-page.ts',
      },
      outputAssertions: [
        {
          description: 'log line is present but secret value is redacted',
          shouldContain: ['secret-log-test:'],
          shouldNotContain: ['super-secret-value'],
        },
      ],
    });
  });

  // ---- SSR build ----

  describe('SSR build', () => {
    viteEnv.describeScenario('SSR entry receives init code injection', {
      command: 'vite build --ssr src/ssr-entry.ts',
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/basic.html',
        'src/ssr-entry.ts': 'pages/ssr-entry.ts',
      },
      fileAssertions: [
        {
          description: 'SSR output contains varlock init calls',
          fileGlob: 'dist/*.js',
          shouldContain: [
            'initVarlockEnv',
            'patchGlobalConsole',
            'patchGlobalResponse',
          ],
        },
        {
          description: 'public vars are replaced in SSR output',
          fileGlob: 'dist/*.js',
          shouldContain: [
            'public-test-value',
            'https://api.example.com',
          ],
        },
        {
          description: 'sensitive value is not present in SSR output',
          fileGlob: 'dist/*.js',
          shouldNotContain: ['super-secret-value'],
        },
      ],
    });
  });

  // ---- Encrypted env blob ----

  describe('encrypted env blob', () => {
    viteEnv.describeScenario('SSR build with _VARLOCK_ENV_KEY encrypts the blob', {
      command: 'vite build --ssr src/ssr-entry.ts',
      env: { _VARLOCK_ENV_KEY: '846a4cbdf4fefeff0da38d8f3766ffe50d8db12f8ce32849bb1e1a60ecb4ba0d' },
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.resolved-env.ts',
        'index.html': 'html/basic.html',
        'src/ssr-entry.ts': 'pages/ssr-entry.ts',
      },
      fileAssertions: [
        {
          description: 'SSR output contains encrypted blob (varlock:v1: prefix)',
          fileGlob: 'dist/*.js',
          shouldContain: ['varlock:v1:'],
        },
        {
          description: 'SSR output does not contain plaintext secret',
          fileGlob: 'dist/*.js',
          shouldNotContain: ['super-secret-value'],
        },
        {
          description: 'public vars are still statically replaced',
          fileGlob: 'dist/*.js',
          shouldContain: ['public-test-value'],
        },
      ],
    });
  });

  // ---- Dev server ----

  describe('dev server', () => {
    viteEnv.describeDevScenario('serves HTML with env replacements and transformed JS', {
      command: 'vite dev --port 15180',
      readyPattern: /Local:.*http/,
      readyTimeout: 30_000,
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/html-replacement.html',
        'src/main.ts': 'pages/basic-page.ts',
      },
      requests: [
        {
          path: '/',
          bodyAssertions: {
            shouldContain: [
              'public-test-value',
              'https://api.example.com',
              'env-specific-dev',
            ],
            shouldNotContain: ['super-secret-value'],
          },
        },
        {
          path: '/src/main.ts',
          bodyAssertions: {
            shouldContain: ['public-test-value'],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
    });

    viteEnv.describeDevScenario('env reload on .env file change', {
      command: 'vite dev --port 15181',
      readyPattern: /Local:.*http/,
      readyTimeout: 30_000,
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/html-replacement.html',
        'src/main.ts': 'pages/basic-page.ts',
      },
      requests: [
        {
          path: '/',
          bodyAssertions: {
            shouldContain: ['env-specific-dev'],
          },
        },
        {
          path: '/',
          fileEdits: {
            '.env.dev': 'ENV_SPECIFIC_VAR=env-specific-changed\n',
          },
          // Vite reloads config in-place without restarting the server,
          // so the readyPattern never re-appears — use a fixed delay instead
          fileEditDelay: 3_000,
          bodyAssertions: {
            shouldContain: ['env-specific-changed'],
          },
        },
      ],
    });

    viteEnv.describeDevScenario('log redaction in dev mode', {
      command: 'vite dev --port 15182',
      readyPattern: /Local:.*http/,
      readyTimeout: 30_000,
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.log-test.ts',
        'index.html': 'html/basic.html',
        'src/main.ts': 'pages/minimal-page.ts',
      },
      requests: [
        {
          path: '/',
          bodyAssertions: {
            shouldContain: ['Varlock Vite Test'],
          },
        },
      ],
      outputAssertions: [
        {
          description: 'sensitive value is redacted in dev server output',
          shouldContain: ['secret-log-test:'],
          shouldNotContain: ['super-secret-value'],
        },
      ],
    });

    viteEnv.describeDevScenario('source code hot-reload', {
      command: 'vite dev --port 15183',
      readyPattern: /Local:.*http/,
      readyTimeout: 30_000,
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/basic.html',
        'src/main.ts': 'pages/basic-page.ts',
      },
      requests: [
        {
          path: '/src/main.ts',
          bodyAssertions: {
            shouldContain: ['public-test-value'],
            shouldNotContain: ['hot-reload-success'],
          },
        },
        {
          path: '/src/main.ts',
          fileEdits: {
            'src/main.ts': readFileSync(join(import.meta.dirname, 'files/pages/updated-basic-page.ts'), 'utf-8'),
          },
          // HMR doesn't restart the server — use a fixed delay
          fileEditDelay: 2_000,
          bodyAssertions: {
            shouldContain: ['public-test-value', 'hot-reload-success'],
          },
        },
      ],
    });
  });

  // ---- Leak detection ----

  describe('leak detection', () => {
    viteEnv.describeDevScenario('safe endpoint serves public values', {
      command: 'vite dev --port 15184',
      readyPattern: /Local:.*http/,
      readyTimeout: 30_000,
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.leaky-middleware.ts',
        'index.html': 'html/basic.html',
        'src/main.ts': 'pages/minimal-page.ts',
      },
      requests: [
        {
          path: '/api/safe',
          bodyAssertions: {
            shouldContain: ['public: public-test-value'],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
    });

    viteEnv.describeDevScenario('leaky endpoint triggers leak detection', {
      command: 'vite dev --port 15185',
      readyPattern: /Local:.*http/,
      readyTimeout: 30_000,
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.leaky-middleware.ts',
        'index.html': 'html/basic.html',
        'src/main.ts': 'pages/minimal-page.ts',
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
  });

  // ---- Non-existent config keys ----

  describe('non-existent config keys', () => {
    viteEnv.describeScenario('non-existent key is not replaced in build output', {
      command: 'vite build',
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/basic.html',
        'src/main.ts': 'pages/nonexistent-key-page.ts',
      },
      fileAssertions: [
        {
          description: 'public var is still replaced',
          fileGlob: 'dist/assets/*.js',
          shouldContain: ['public-test-value'],
        },
        {
          description: 'non-existent key reference is not replaced with a real value',
          fileGlob: 'dist/assets/*.js',
          shouldNotContain: ['DOES_NOT_EXIST_VALUE'],
        },
      ],
    });

    viteEnv.describeDevScenario('non-existent key is not replaced in dev server output', {
      command: 'vite dev --port 15186',
      readyPattern: /Local:.*http/,
      readyTimeout: 30_000,
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/basic.html',
        'src/main.ts': 'pages/nonexistent-key-page.ts',
      },
      requests: [
        {
          path: '/src/main.ts',
          bodyAssertions: {
            shouldContain: ['public-test-value', 'DOES_NOT_EXIST'],
            shouldNotContain: ['DOES_NOT_EXIST_VALUE'],
          },
        },
      ],
    });
  });

  // ---- Invalid config handling ----

  describe('invalid config', () => {
    viteEnv.describeScenario('invalid schema causes build failure', {
      command: 'vite build',
      expectSuccess: false,
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/basic.html',
        'src/main.ts': 'pages/minimal-page.ts',
        '.env.schema': 'schemas/.env.schema.invalid',
      },
      outputAssertions: [
        {
          description: 'build output indicates config validation failure',
          shouldContain: ['Varlock config validation failed', 'MISSING_REQUIRED_VAR'],
        },
      ],
    });

    viteEnv.describeDevScenario('invalid schema shows error page then recovers on fix', {
      command: 'vite dev --port 15187',
      readyPattern: /Local:.*http/,
      readyTimeout: 30_000,
      templateFiles: {
        'vite.config.ts': 'vite-configs/vite.config.ts',
        'index.html': 'html/html-replacement.html',
        'src/main.ts': 'pages/basic-page.ts',
        '.env.schema': 'schemas/.env.schema.invalid',
      },
      requests: [
        {
          path: '/',
          bodyAssertions: {
            shouldContain: ['invalid'],
            shouldNotContain: ['public-test-value'],
          },
        },
        {
          path: '/',
          fileEdits: {
            '.env.schema': readFileSync(join(import.meta.dirname, 'files/schemas/.env.schema'), 'utf-8'),
          },
          // Config reload after fixing .env.schema — Vite doesn't restart
          fileEditDelay: 3_000,
          bodyAssertions: {
            shouldContain: ['public-test-value'],
            shouldNotContain: ['invalid'],
          },
        },
      ],
      outputAssertions: [
        {
          description: 'validation error details are shown in terminal',
          shouldContain: ['MISSING_REQUIRED_VAR'],
        },
      ],
    });
  });
});
