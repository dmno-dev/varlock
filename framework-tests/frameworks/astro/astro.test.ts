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
  });
});
