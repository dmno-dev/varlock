import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

const BUNDLERS = [
  'webpack',
  'turbopack',
];

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
            shouldContain: ['MISSING_REQUIRED_VAR'],
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
