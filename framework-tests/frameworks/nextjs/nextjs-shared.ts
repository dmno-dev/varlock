import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

const ALL_BUNDLERS = [
  'webpack',
  'turbopack',
];

// When running quick mode (just v16), skip webpack to cut build time in half
const BUNDLERS = process.env.NEXTJS_TURBO_ONLY
  ? ALL_BUNDLERS.filter((b) => b === 'turbopack')
  : ALL_BUNDLERS;

const EXPORT_CONFIG = {
  path: '_base/next.config.mjs' as const,
  replacements: { '// OUTPUT-MODE': "output: 'export'," },
};

function getBuildToolFlag(nextVersion: number, bundler: string): string {
  if (nextVersion === 14) return bundler === 'turbopack' ? '--turbo' : '';
  if (nextVersion === 15) return bundler === 'turbopack' ? '--turbopack' : '';
  if (nextVersion === 16) return bundler === 'turbopack' ? '' : '--webpack';
  throw new Error(`Unsupported Next.js version: ${nextVersion}`);
}

export function defineNextjsTests(nextVersion: number, testDir: string) {
  describe(`Next.js v${nextVersion}`, () => {
    const nextEnv = new FrameworkTestEnv({
      testDir,
      framework: `next-v${nextVersion}`,
      packageManager: 'pnpm',
      dependencies: {
        next: `^${nextVersion}`,
        react: '^19',
        'react-dom': '^19',
        '@types/react': '^19',
        varlock: 'will-be-replaced',
        '@varlock/nextjs-integration': 'will-be-replaced',
      },
      templateFiles: {
        '.env.schema': 'schemas/.env.schema',
        '.env.dev': 'schemas/.env.dev',
        '.env.prod': 'schemas/.env.prod',
      },
      scripts: {
        dev: 'next dev',
        build: 'next build',
      },
      overrides: {
        '@next/env': '<packed:@varlock/nextjs-integration>',
      },
    });
    beforeAll(() => nextEnv.setup(), 180_000);
    afterAll(() => nextEnv.teardown());

    describe('invalid config', () => {
      nextEnv.describeScenario('invalid schema causes build failure', {
        command: 'next build',
        expectSuccess: false,
        templateFiles: {
          'app/page.tsx': 'pages/basic-page.tsx',
          '.env.schema': 'schemas/.env.schema.invalid',
        },
        outputAssertions: [
          {
            description: 'validation error details are shown',
            shouldContain: ['Configuration is currently invalid', 'MISSING_REQUIRED_VAR'],
          },
        ],
      });

      // Next 14's turbo dev support is limited; skip this test for v14
      const devFlag = getBuildToolFlag(nextVersion, 'turbopack');
      nextEnv.describeDevScenario('invalid schema shows errors in dev and boots', {
        skip: nextVersion === 14,
        command: `next dev ${devFlag} --port ${13900 + nextVersion}`,
        readyPattern: /Ready in|Starting\.\.\./,
        readyTimeout: 30_000,
        templateFiles: {
          'app/page.tsx': 'pages/basic-page.tsx',
          '.env.schema': 'schemas/.env.schema.invalid',
        },
        requests: [
          {
            path: '/',
            // dev server should still boot even with invalid config
          },
        ],
        outputAssertions: [
          {
            description: 'error details shown in terminal',
            shouldContain: ['Configuration is currently invalid', 'MISSING_REQUIRED_VAR'],
          },
        ],
      });
    });

    BUNDLERS.forEach((webpackOrTurbo) => {
      const buildToolFlag = getBuildToolFlag(nextVersion, webpackOrTurbo);

      // next 14 only supports --turbo for dev command, which we are not testing yet
      // TODO: smarter skipping once we add dev tests
      if (nextVersion === 14 && webpackOrTurbo === 'turbopack') {
        return;
      }

      const buildCommand = `next build ${buildToolFlag}`;

      describe(`bundler=${webpackOrTurbo}`, () => {
        const devPort = 14000 + (nextVersion * 10) + (webpackOrTurbo === 'turbopack' ? 1 : 0);
        const devCommand = `next dev ${buildToolFlag} --port ${devPort}`.replace(/\s+/g, ' ').trim();

        nextEnv.describeDevScenario('dev: unchanged extra env file content does not trigger reload', {
          command: devCommand,
          readyPattern: /Ready in|Starting\.\.\./,
          readyTimeout: 40_000,
          templateFiles: {
            'app/page.tsx': 'pages/basic-page.tsx',
          },
          requests: [
            {
              path: '/',
              bodyAssertions: {
                shouldContain: ['Varlock Framework Test - Next.js'],
              },
            },
            {
              path: '/',
              fileEdits: {
                '.env.dev': 'ENV_SPECIFIC_VAR=env-specific-var--dev',
              },
              // Watchers are debounced; wait long enough to assert no reload path.
              fileEditDelay: 2000,
              bodyAssertions: {
                shouldContain: ['Varlock Framework Test - Next.js'],
              },
            },
          ],
        });

        nextEnv.describeDevScenario('dev: changed extra env file content triggers reload', {
          command: devCommand,
          readyPattern: /Ready in|Starting\.\.\./,
          readyTimeout: 40_000,
          templateFiles: {
            'app/page.tsx': 'pages/basic-page.tsx',
          },
          requests: [
            {
              path: '/',
              bodyAssertions: {
                shouldContain: ['Varlock Framework Test - Next.js'],
              },
            },
            {
              path: '/',
              fileEdits: {
                '.env.dev': 'ENV_SPECIFIC_VAR=env-specific-var--dev-updated',
              },
              fileEditDelay: 2500,
              bodyAssertions: {
                shouldContain: ['Varlock Framework Test - Next.js'],
              },
            },
          ],
        });

        describe('output=export', () => {
          nextEnv.describeScenario('basic page', {
            command: buildCommand,
            templateFiles: {
              'app/page.tsx': 'pages/basic-page.tsx',
              'next.config.mjs': EXPORT_CONFIG,
            },
            fileAssertions: [
              {
                description: 'env vars are injected into output',
                fileGlob: 'out/**/*.html',
                shouldContain: [
                  'next-prefixed-public-var',
                  'unprefixed-public-var',
                  'env-specific-var--dev',
                  'sensitive-var-available',
                ],
                shouldNotContain: [
                  'super-secret-value',
                  'env-specific-var--prod',
                ],
              },
            ],
            outputAssertions: [
              {
                description: 'secret is redacted from stdout',
                shouldContain: ['secret-log-test:'],
                shouldNotContain: ['super-secret-var'],
              },
            ],
          });

          nextEnv.describeScenario('leaky static page', {
            command: buildCommand,
            templateFiles: {
              'app/page.tsx': 'pages/leaky-page.tsx',
              'next.config.mjs': EXPORT_CONFIG,
            },
            expectSuccess: false,
            outputAssertions: [
              {
                description: 'output contains leak detection message',
                shouldContain: ['DETECTED LEAKED SENSITIVE CONFIG'],
              },
            ],
          });

          nextEnv.describeScenario('client component page', {
            command: buildCommand,
            templateFiles: {
              'app/page.tsx': {
                path: 'pages/basic-page.tsx',
                prepend: "'use client';",
              },
              'next.config.mjs': EXPORT_CONFIG,
            },
            fileAssertions: [
              {
                description: 'public env vars are inlined into client output',
                fileGlob: 'out/**/*.html',
                shouldContain: [
                  'next-prefixed-public-var',
                  'unprefixed-public-var',
                  'env-specific-var--dev',
                ],
                shouldNotContain: ['super-secret-value'],
              },
            ],
          });

          nextEnv.describeScenario('leaky client page', {
            command: buildCommand,
            templateFiles: {
              'app/page.tsx': {
                path: 'pages/leaky-page.tsx',
                prepend: "'use client';",
              },
              'next.config.mjs': EXPORT_CONFIG,
            },
            expectSuccess: false,
            outputAssertions: [
              {
                description: 'output contains leak detection message',
                shouldContain: ['DETECTED LEAKED SENSITIVE CONFIG'],
              },
            ],
          });
        });

        describe('default output mode', () => {
          nextEnv.describeScenario('basic static page', {
            command: buildCommand,
            templateFiles: {
              'app/page.tsx': 'pages/basic-page.tsx',
            },
            fileAssertions: [
              {
                description: 'env vars are injected into output',
                // pre-rendered HTML files
                fileGlob: '.next/**/*.html',
                shouldContain: [
                  'next-prefixed-public-var',
                  'unprefixed-public-var',
                  'env-specific-var--dev',
                  'sensitive-var-available',
                ],
                shouldNotContain: [
                  'super-secret-value',
                  'env-specific-var--prod',
                ],
              },
              {
                description: 'secrets are scrubbed from sourcemaps',
                fileGlob: '.next/**/*.map',
                shouldNotContain: ['super-secret-var'],
              },
            ],
            outputAssertions: [
              {
                description: 'secret is redacted from stdout',
                shouldContain: ['secret-log-test:'],
                shouldNotContain: ['super-secret-var'],
              },
            ],
          });

          nextEnv.describeScenario('leaky static page', {
            command: buildCommand,
            templateFiles: {
              'app/page.tsx': 'pages/leaky-page.tsx',
            },
            expectSuccess: false,
            outputAssertions: [
              {
                description: 'output contains leak detection message',
                shouldContain: ['DETECTED LEAKED SENSITIVE CONFIG'],
              },
            ],
          });

          nextEnv.describeScenario('client component page', {
            command: buildCommand,
            templateFiles: {
              'app/page.tsx': {
                path: 'pages/basic-page.tsx',
                prepend: "'use client';",
              },
            },
            fileAssertions: [
              {
                description: 'public env vars are inlined into client output',
                fileGlob: '.next/**/*.html',
                shouldContain: [
                  'next-prefixed-public-var',
                  'unprefixed-public-var',
                  'env-specific-var--dev',
                ],
                shouldNotContain: ['super-secret-value'],
              },
            ],
          });

          nextEnv.describeScenario('leaky client page', {
            command: buildCommand,
            templateFiles: {
              'app/page.tsx': {
                path: 'pages/leaky-page.tsx',
                prepend: "'use client';",
              },
            },
            expectSuccess: false,
            outputAssertions: [
              {
                description: 'output contains leak detection message',
                shouldContain: ['DETECTED LEAKED SENSITIVE CONFIG'],
              },
            ],
          });

          nextEnv.describeScenario('encrypted env blob with _VARLOCK_ENV_KEY', {
            command: buildCommand,
            env: { _VARLOCK_ENV_KEY: '846a4cbdf4fefeff0da38d8f3766ffe50d8db12f8ce32849bb1e1a60ecb4ba0d' },
            templateFiles: {
              'app/page.tsx': 'pages/basic-page.tsx',
            },
            fileAssertions: [
              {
                description: 'runtime files contain encrypted blob (varlock:v1: prefix) instead of plaintext',
                fileGlob: '.next/server/**/*runtime*.js',
                shouldContain: ['varlock:v1:'],
                shouldNotContain: ['super-secret-var'],
              },
              {
                description: 'prerendered HTML still has correct values (build uses plaintext env)',
                fileGlob: '.next/**/*.html',
                shouldContain: [
                  'next-prefixed-public-var',
                  'unprefixed-public-var',
                  'sensitive-var-available',
                ],
                shouldNotContain: ['super-secret-value'],
              },
            ],
          });

          nextEnv.describeScenario('leaky edge page', {
            command: buildCommand,
            templateFiles: {
              'app/page.tsx': {
                path: 'pages/leaky-page.tsx',
                prepend: 'const runtime = "edge";',
              },
            },
            expectSuccess: false,
            outputAssertions: [
              {
                description: 'output contains leak detection message',
                shouldContain: ['DETECTED LEAKED SENSITIVE CONFIG'],
              },
            ],
          });
        });
      });
    });
  });
}
