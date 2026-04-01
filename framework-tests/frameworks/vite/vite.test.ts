/*
Tests varlock + vite integration (plain Vite SPA and SSR builds).
Covers static builds, HTML constant replacement, leak detection,
log redaction, sourcemap scrubbing, SSR init injection, and dev server.
*/
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

    viteEnv.describeScenario('env-specific vars use correct environment', {
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
  });
});
