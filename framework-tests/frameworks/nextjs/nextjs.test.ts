import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

// add these at the top, so easier to comment/uncomment
const BUNDLERS = [
  'webpack',
  'turbopack',
];
const NEXT_VERSIONS = [
  '15',
  '16',
];

NEXT_VERSIONS.forEach((nextVersion) => {
  describe(`Next.js v${nextVersion}`, () => {
    const nextEnv = new FrameworkTestEnv({
      testDir: import.meta.dirname,
      framework: `next-v${nextVersion}`,
      packageManager: 'pnpm',
      dependencies: {
        next: `^${nextVersion}`,
        react: '^19',
        'react-dom': '^19',
        varlock: 'will-be-replaced',
        '@varlock/nextjs-integration': 'will-be-replaced',
      },
      templateFiles: {
        '.env.schema': 'schemas/.env.schema',
        '.env.dev': 'schemas/.env.dev',
        '.env.prod': 'schemas/.env.prod',
      },
      packageJsonMerge: {
        scripts: {
          dev: 'COREPACK_ENABLE_PROJECT_SPEC=0 next dev',
          build: 'COREPACK_ENABLE_PROJECT_SPEC=0 next build',
        },
        pnpm: {
          overrides: {
            '@next/env': '<packed:@varlock/nextjs-integration>',
          },
        },
      },
    });
    beforeAll(() => nextEnv.setup(), 180_000);
    afterAll(() => nextEnv.teardown());

    BUNDLERS.forEach((webpackOrTurbo) => {
      let buildToolFlag = webpackOrTurbo === 'turbopack' ? '--turbopack' : '--webpack';
      if (nextVersion === '15') {
        buildToolFlag = webpackOrTurbo === 'turbopack' ? '--turbopack' : '';
      } else {
        buildToolFlag = webpackOrTurbo === 'turbopack' ? '' : '--webpack';
      }

      const buildCommand = `next build ${buildToolFlag}`;

      describe(`bundler=${webpackOrTurbo}`, () => {
        describe('output=export', () => {
          nextEnv.describeScenario('basic page', {
            command: buildCommand,
            templateFiles: {
              'app/page.tsx': 'pages/basic-page.tsx',
              'next.config.mjs': {
                path: '_base/next.config.mjs',
                replacements: { '// OUTPUT-MODE': "output: 'export'," },
              },
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
              'next.config.mjs': {
                path: '_base/next.config.mjs',
                replacements: { '// OUTPUT-MODE': "output: 'export'," },
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
});
