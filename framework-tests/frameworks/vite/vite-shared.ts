/*
Shared Vite test definitions, parameterized by Vite version.
Covers static builds, HTML constant replacement, leak detection,
log redaction, sourcemap scrubbing, SSR init injection, and dev server.
*/
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describe, beforeAll, afterAll, test, expect,
} from 'vitest';
import { encryptEnvBlobSync, generateEncryptionKeyHex } from 'varlock/encrypt-env';
import { FrameworkTestEnv } from '../../harness/index';

export function defineViteTests(
  label: string,
  testDir: string,
  opts: {
    viteVersion: string;
    /** Base port — each dev scenario offsets from this */
    basePort: number;
  },
) {
  const { viteVersion, basePort } = opts;

  describe(`Vite (${label})`, () => {
    const viteEnv = new FrameworkTestEnv({
      testDir,
      framework: `vite-${label}`,
      packageManager: 'pnpm',
      dependencies: {
        vite: viteVersion,
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

      viteEnv.describeScenario('public+dynamic var not inlined in client code', {
        command: 'vite build',
        templateFiles: {
          '.env.schema': 'schemas/.env.schema.dynamic',
          'vite.config.ts': 'vite-configs/vite.config.ts',
          'index.html': 'html/basic.html',
          'src/main.ts': 'pages/dynamic-ref-page.ts',
        },
        fileAssertions: [
          {
            description: 'dynamic public value is not inlined; key stays a runtime reference',
            fileGlob: 'dist/assets/*.js',
            // the key name appears via the runtime ENV access and the injected
            // __varlockPublicDynamicKeys list; the value must not
            shouldContain: ['PUBLIC_DYNAMIC_VAR', '__varlockPublicDynamicKeys'],
            shouldNotContain: ['public-dynamic-value', 'super-secret-value'],
          },
          {
            description: 'static public var is still replaced',
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

      viteEnv.describeScenario('public+dynamic var in HTML causes build failure', {
        command: 'vite build',
        expectSuccess: false,
        templateFiles: {
          '.env.schema': 'schemas/.env.schema.dynamic',
          'vite.config.ts': 'vite-configs/vite.config.ts',
          'index.html': 'html/dynamic-html.html',
          'src/main.ts': 'pages/minimal-page.ts',
        },
        outputAssertions: [
          {
            description: 'error mentions dynamic config item',
            shouldContain: ['PUBLIC_DYNAMIC_VAR', 'dynamic'],
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
        env: { _VARLOCK_ENV_KEY: randomBytes(32).toString('hex') },
        templateFiles: {
          'vite.config.ts': 'vite-configs/vite.config.resolved-env.ts',
          'index.html': 'html/basic.html',
          'src/ssr-entry.ts': 'pages/ssr-entry.ts',
        },
        expectSuccess: true,
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

    // ---- Undefined injection modes ----

    // Build an SSR entry with the resolved env inlined, then execute it with plain node so
    // the inlined varlock init performs the process.env injection per the blob's settings.
    // This verifies how an unset schema item (`UNSET_VAR=`) appears on each env surface.
    describe('undefined injection modes (SSR runtime)', () => {
      async function buildAndRunSsrEntry(
        schemaTemplate: string,
        runEnv: Record<string, string> = {},
        viteConfig = 'vite-configs/vite.config.resolved-env.ts',
      ) {
        const buildResult = await viteEnv.runScenario({
          command: 'vite build --ssr src/ssr-undefined-entry.ts',
          templateFiles: {
            'vite.config.ts': viteConfig,
            'index.html': 'html/basic.html',
            '.env.schema': schemaTemplate,
            'src/ssr-undefined-entry.ts': 'pages/ssr-undefined-entry.ts',
          },
        });
        expect(buildResult.exitCode).toBe(0);

        // scrub anything that could interfere with the standalone run: the bundle must
        // hydrate from its inlined blob, and ambient values must not mask the scenario
        const cleanEnv = { ...process.env };
        for (const key of ['__VARLOCK_ENV', '_VARLOCK_ENV_KEY', 'UNSET_VAR', 'PUBLIC_VAR']) {
          delete cleanEnv[key];
        }
        const runResult = spawnSync('node', ['dist/ssr-undefined-entry.js'], {
          cwd: viteEnv.dir,
          encoding: 'utf-8',
          timeout: 30_000,
          env: { ...cleanEnv, ...runEnv },
        });
        const output = (runResult.stdout ?? '') + (runResult.stderr ?? '');
        return { output, status: runResult.status };
      }

      test('default: unset items are left out of process.env', async () => {
        const { output } = await buildAndRunSsrEntry('schemas/.env.schema.undefined-injection');
        expect(output).toContain('ssr-undefined-check-done');
        expect(output).toContain('unset-in-process-env::false');
        expect(output).toContain('process-env-unset::undefined');
        expect(output).toContain('process-env-set::public-test-value');
        expect(output).toContain('import-meta-env-unset::undefined');
        expect(output).toContain('env-proxy-unset::undefined');
      }, 180_000);

      test('@injectUndefinedAsEmpty: empty strings land on process.env but not import.meta.env', async () => {
        const { output } = await buildAndRunSsrEntry('schemas/.env.schema.undefined-injection-empty');
        expect(output).toContain('ssr-undefined-check-done');
        expect(output).toContain('unset-in-process-env::true');
        expect(output).toContain('process-env-unset::""');
        expect(output).toContain('process-env-set::public-test-value');
        // import.meta.env only carries framework-prefixed keys, so the unset schema
        // item stays undefined there even in empty-injection mode
        expect(output).toContain('import-meta-env-unset::undefined');
        // the ENV surface always reflects the real resolved value
        expect(output).toContain('env-proxy-unset::undefined');
      }, 180_000);

      test('a differing runtime env value warns loudly but boots on baked values', async () => {
        // a runtime env value the build resolved differently (or not at all) cannot be
        // validated or applied from a baked snapshot, so it is ignored by ENV and
        // surfaced as a loud warning - the boot itself is never blocked.
        const { output, status } = await buildAndRunSsrEntry('schemas/.env.schema.undefined-injection', {
          UNSET_VAR: 'runtime-provided-value',
        });
        expect(status).toBe(0);
        expect(output).toContain('ssr-undefined-check-done');
        expect(output).toContain('Runtime environment differs');
        expect(output).toContain('UNSET_VAR');
        // the runtime-provided value is ignored by ENV but never deleted from process.env
        expect(output).toContain('env-proxy-unset::undefined');
        expect(output).toContain('process-env-unset::"runtime-provided-value"');
      }, 180_000);

      test('the baked payload stays authoritative even under an ambient runtime blob', async () => {
        // `resolved-env` freezes the artifact's config on purpose: static values are
        // already inlined into the bundle at build time, so honoring a boot-time blob
        // would only override the runtime-resolved subset and leave the artifact
        // reading from two different resolutions. The baked payload wins, and the
        // differing ambient value is surfaced as a conflict warning.
        const ambientBlob = JSON.stringify({
          sources: [],
          settings: {},
          config: {
            UNSET_VAR: { value: 'from-ambient-blob', isSensitive: false },
            PUBLIC_VAR: { value: 'public-test-value', isSensitive: false },
          },
        });
        const { output, status } = await buildAndRunSsrEntry('schemas/.env.schema.undefined-injection', {
          __VARLOCK_ENV: ambientBlob,
        });
        expect(status).toBe(0);
        expect(output).toContain('ssr-undefined-check-done');
        // baked (unset) wins over the ambient blob's value
        expect(output).toContain('env-proxy-unset::undefined');
        expect(output).not.toContain('from-ambient-blob');
      }, 180_000);

      test('init-only: an ENCRYPTED ambient blob is decrypted before init', async () => {
        // with no baked payload the ambient blob IS the env source, and
        // `varlock run --inject blob` under @encryptInjectedEnv hands over a
        // varlock:v1: ciphertext - the artifact must decrypt it rather than letting
        // initVarlockEnv throw on ciphertext
        const ambientBlob = JSON.stringify({
          sources: [],
          settings: {},
          config: {
            UNSET_VAR: { value: 'from-encrypted-blob', isSensitive: false },
            PUBLIC_VAR: { value: 'public-test-value', isSensitive: false },
          },
        });
        const encryptionKey = generateEncryptionKeyHex();
        const { output, status } = await buildAndRunSsrEntry(
          'schemas/.env.schema.undefined-injection',
          {
            __VARLOCK_ENV: encryptEnvBlobSync(ambientBlob, encryptionKey),
            _VARLOCK_ENV_KEY: encryptionKey,
          },
          'vite-configs/vite.config.init-only.ts',
        );
        expect(status).toBe(0);
        expect(output).toContain('ssr-undefined-check-done');
        expect(output).not.toContain('still encrypted');
        expect(output).toContain('process-env-unset::"from-encrypted-blob"');
      }, 180_000);
    });

    // ---- Dev server ----

    describe('dev server', () => {
      viteEnv.describeDevScenario('serves HTML with env replacements and transformed JS', {
        command: `vite dev --port ${basePort}`,
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
        command: `vite dev --port ${basePort + 1}`,
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
        command: `vite dev --port ${basePort + 2}`,
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
        command: `vite dev --port ${basePort + 3}`,
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
              'src/main.ts': readFileSync(join(testDir, 'files/pages/updated-basic-page.ts'), 'utf-8'),
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
        command: `vite dev --port ${basePort + 4}`,
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
        command: `vite dev --port ${basePort + 5}`,
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
        command: `vite dev --port ${basePort + 6}`,
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
            shouldContain: ['Configuration is currently invalid', 'MISSING_REQUIRED_VAR'],
          },
        ],
      });

      viteEnv.describeDevScenario('invalid schema shows error page then recovers on fix', {
        command: `vite dev --port ${basePort + 7}`,
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
            expectedStatus: 500,
            bodyAssertions: {
              shouldContain: ['invalid'],
              shouldNotContain: ['public-test-value'],
            },
          },
          {
            path: '/',
            fileEdits: {
              '.env.schema': readFileSync(join(testDir, 'files/schemas/.env.schema'), 'utf-8'),
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
}
