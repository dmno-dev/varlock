import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

export function defineAstroTests(astroVersion: number, testDir: string, opts: { portBase: number }) {
  let nodeAdapterVersion = '^9';
  if (astroVersion >= 7) nodeAdapterVersion = '^11';
  else if (astroVersion >= 6) nodeAdapterVersion = '^10';
  let nextPort = opts.portBase;
  const port = () => nextPort++;

  describe(`Astro v${astroVersion}`, () => {
    const astroEnv = new FrameworkTestEnv({
      testDir,
      framework: `astro-v${astroVersion}`,
      packageManager: 'pnpm',
      dependencies: {
        astro: `^${astroVersion}`,
        varlock: 'will-be-replaced',
        '@varlock/astro-integration': 'will-be-replaced',
        '@astrojs/node': nodeAdapterVersion,
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
            shouldContain: ['Configuration is currently invalid', 'MISSING_REQUIRED_VAR'],
          },
        ],
      });
    });

    // ---- Server output mode (SSR with dev server) ----

    describe('server output', () => {
      astroEnv.describeDevScenario('basic SSR page', {
        command: `astro dev --port ${port()}`,
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
        command: `astro dev --port ${port()}`,
        readyPattern: /http:\/\/localhost/,
        readyTimeout: 30_000,
        templateFiles: {
          'src/pages/index.astro': 'pages/leaky-server-page.astro',
          'astro.config.mts': 'configs/astro.config.server.mts',
        },
        requests: [
          {
            // Astro commits response headers (status 200) before the body is
            // written, so we can't override the status code. The important
            // thing is the leaked secret is stripped from the response body.
            path: '/',
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
        command: `astro dev --port ${port()}`,
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
                'toplevel_has_secret::yes',
              ],
              shouldNotContain: ['super-secret-value'],
            },
          },
        ],
      });

      astroEnv.describeDevScenario('leaky API endpoint', {
        command: `astro dev --port ${port()}`,
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
        command: `astro dev --port ${port()}`,
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

      // Env reload works in real usage — confirmed manually and via standalone
      // node scripts. But chokidar inside Astro's dev server (spawned as a
      // child process) never fires change events when writeFileSync is called
      // from a vitest worker, regardless of watcher backend (FSEvents, native
      // fs.watch, or polling). The Vite env reload test doesn't have this
      // problem because Vite reloads config in-place without a server restart.
      // This appears to be a vitest + Astro-specific interaction issue.
      astroEnv.describeDevScenario('env reload on .env file change', {
        skip: true,
        command: `astro dev --port ${port()}`,
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
              shouldContain: ['public-var:public-var-value'],
            },
          },
          {
            path: '/',
            fileEditDelay: 5_000,
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

  // ---- Cloudflare adapter (@astrojs/cloudflare) ----
  // @astrojs/cloudflare v14 requires Astro v7, so this suite is v7+ only.
  // It runs SSR in workerd via @cloudflare/vite-plugin and relies on
  // @varlock/cloudflare-integration to inject env into the worker.
  if (astroVersion >= 7) {
    describe(`Astro v${astroVersion} — Cloudflare adapter`, () => {
      const cfEnv = new FrameworkTestEnv({
        testDir,
        framework: `astro-v${astroVersion}-cloudflare`,
        packageManager: 'pnpm',
        dependencies: {
          astro: `^${astroVersion}`,
          varlock: 'will-be-replaced',
          '@varlock/astro-integration': 'will-be-replaced',
          '@varlock/cloudflare-integration': 'will-be-replaced',
          '@astrojs/cloudflare': '^14',
          wrangler: '^4',
        },
        overrides: {
          punycode: 'npm:punycode@^2.3.1',
        },
        templateFiles: {
          '.env.schema': 'schemas/.env.schema',
          '.env.dev': 'schemas/.env.dev',
          '.env.prod': 'schemas/.env.prod',
        },
      });

      beforeAll(() => cfEnv.setup(), 180_000);
      afterAll(() => cfEnv.teardown());

      cfEnv.describeDevScenario('SSR + env injection via worker bindings', {
        command: `astro dev --port ${port()}`,
        readyPattern: /http:\/\/localhost/,
        readyTimeout: 60_000,
        timeout: 120_000,
        templateFiles: {
          'src/pages/index.astro': 'pages/server-basic-page.astro',
          'src/pages/api/health.ts': 'pages/api-endpoint.ts',
          'astro.config.mts': 'configs/astro.config.cloudflare.mts',
          // @astrojs/cloudflare runs SSR in workerd and requires a wrangler config.
          'wrangler.jsonc': 'configs/wrangler.jsonc',
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
          {
            path: '/api/health',
            bodyAssertions: {
              shouldContain: [
                'public_var::public-var-value',
                'has_secret::yes',
                'toplevel_has_secret::yes',
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
          {
            // varlock disables wrangler's redundant .env auto-loading and prints
            // its own notice in place of "Using secrets defined in .env".
            description: 'wrangler .env auto-load message is replaced by a varlock notice',
            shouldContain: ['injecting resolved env into the Cloudflare worker'],
            shouldNotContain: ['Using secrets defined in .env'],
          },
        ],
      });
    });
  }
}
