import { randomBytes } from 'node:crypto';
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
  if (nextVersion >= 16) return bundler === 'turbopack' ? '' : '--webpack';
  throw new Error(`Unsupported Next.js version: ${nextVersion}`);
}

export function defineNextjsTests(versionOrCanary: number | 'canary', testDir: string) {
  const isCanary = versionOrCanary === 'canary';
  // canary follows the newest major's CLI flags / bundler defaults;
  // 99 keeps the version-derived dev ports out of the pinned versions' range
  const nextVersion = isCanary ? 99 : versionOrCanary;
  const label = isCanary ? 'canary' : `v${versionOrCanary}`;

  describe(`Next.js ${label}`, () => {
    const nextEnv = new FrameworkTestEnv({
      testDir,
      framework: `next-${label}`,
      packageManager: 'pnpm',
      dependencies: {
        next: isCanary ? 'canary' : `^${versionOrCanary}`,
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

      // Turbopack production builds only became stable in Next 16, and on v15 there
      // is no persistent build cache, so every build scenario is a slow cold compile
      // (25-54s each vs 5-10s on v16). Real-world v15 turbopack usage is dev-only,
      // so only run the dev scenarios there.
      const runBuildScenarios = !(nextVersion === 15 && webpackOrTurbo === 'turbopack');

      const defaultBundler = nextVersion >= 16 ? 'turbopack' : 'webpack';

      describe(`bundler=${webpackOrTurbo}`, () => {
        const devPort = 14000 + (nextVersion * 10) + (webpackOrTurbo === 'turbopack' ? 1 : 0);
        const devCommand = `next dev ${buildToolFlag} --port ${devPort}`.replace(/\s+/g, ' ').trim();

        // One dev-server session covers both env file watching behaviors:
        // rewriting the file with identical content must not churn the server,
        // and actually changing the content must reload env and serve the new value.
        // The same session also covers the pages-router SSR path (getServerSideProps)
        // and edge middleware, which read env through different code paths.
        // NOTE: on Next 15.5 + turbopack this exercises the plugin's conditioned loader
        // rule (edge files excluded) — middleware env comes through the runtime proxy.
        nextEnv.describeDevScenario('dev: extra env file watching', {
          command: devCommand,
          readyPattern: /Ready in|Starting\.\.\./,
          readyTimeout: 40_000,
          templateFiles: {
            'app/page.tsx': 'pages/basic-page.tsx',
            'pages/pages-ssr.tsx': 'pages-router/ssr-page.tsx',
            'pages/leaky-ssr.tsx': 'pages-router/leaky-ssr-page.tsx',
            'middleware.ts': 'middleware/middleware.ts',
          },
          requests: [
            {
              label: 'initial page load serves dev env value',
              path: '/',
              bodyAssertions: {
                shouldContain: ['Varlock Framework Test - Next.js', 'env-specific-var--dev'],
              },
            },
            {
              label: 'pages-router getServerSideProps reads env at request time',
              path: '/pages-ssr',
              bodyAssertions: {
                shouldContain: [
                  'Varlock Pages Router SSR Page',
                  'next-prefixed-public-var',
                  'unprefixed-public-var',
                  'env-specific-var--dev',
                  'pages-ssr-sensitive-available',
                ],
                shouldNotContain: ['super-secret-var'],
              },
            },
            {
              label: 'edge middleware reads env',
              path: '/middleware-test',
              bodyAssertions: {
                shouldContain: [
                  'varlock-middleware-response',
                  'next-prefixed-public-var',
                  'unprefixed-public-var',
                  'env-specific-var--dev',
                  'middleware-sensitive-available',
                ],
                shouldNotContain: ['super-secret-var'],
              },
            },
            {
              label: 'rewrite with unchanged content: does not reload, same value served',
              path: '/',
              fileEdits: {
                '.env.dev': 'ENV_SPECIFIC_VAR=env-specific-var--dev',
              },
              // Watchers are debounced; wait long enough to assert no reload path.
              fileEditDelay: 2000,
              bodyAssertions: {
                shouldContain: ['Varlock Framework Test - Next.js', 'env-specific-var--dev'],
              },
            },
            {
              label: 'change to content: env is reloaded, updated value served',
              path: '/',
              fileEdits: {
                '.env.dev': 'ENV_SPECIFIC_VAR=env-specific-var--dev-updated',
              },
              fileEditDelay: 2500,
              bodyAssertions: {
                shouldContain: ['Varlock Framework Test - Next.js', 'env-specific-var--dev-updated'],
              },
            },
            {
              label: 'pages-router getServerSideProps serves reloaded env value',
              path: '/pages-ssr',
              bodyAssertions: {
                shouldContain: ['Varlock Pages Router SSR Page', 'env-specific-var--dev-updated'],
              },
            },
            {
              // Runtime leak detection: getServerSideProps leaks a secret at request
              // time (invisible to build scans). The response scanner fails closed —
              // the connection is killed mid-stream, so no bytes reach the client.
              label: 'runtime leak detection blocks secret in SSR response',
              path: '/leaky-ssr',
              allowRequestFailure: true,
              bodyAssertions: {
                shouldNotContain: ['super-secret-var'],
              },
            },
          ],
          outputAssertions: [
            {
              description: 'runtime secret logs are redacted, leak detection fires, no raw secret in dev logs',
              shouldContain: ['runtime-secret-log-test:', 'DETECTED LEAKED SENSITIVE CONFIG'],
              shouldNotContain: ['super-secret-var'],
            },
          ],
        });

        describe.skipIf(!runBuildScenarios)('output=export', () => {
          // One build with three routes: a server component page, a client
          // component page, and a pages-router page (getStaticProps), each
          // asserted against its own output file.
          // NOTE: middleware is not supported with output=export, so it is
          // only covered in the default output mode scenario below.
          nextEnv.describeScenario('static pages (server + client component + pages router)', {
            command: buildCommand,
            expectSuccess: true,
            templateFiles: {
              'app/page.tsx': 'pages/basic-page.tsx',
              'app/client-page/page.tsx': 'pages/client-page.tsx',
              'pages/pages-static.tsx': 'pages-router/static-page.tsx',
              'next.config.mjs': EXPORT_CONFIG,
            },
            fileAssertions: [
              {
                description: 'server page: env vars are injected into output',
                filePath: 'out/index.html',
                shouldContain: [
                  'next-prefixed-public-var',
                  'unprefixed-public-var',
                  'env-specific-var--dev',
                  'sensitive-var-available',
                ],
              },
              {
                description: 'client component page: public env vars are inlined',
                filePath: 'out/client-page.html',
                shouldContain: [
                  'next-prefixed-public-var',
                  'unprefixed-public-var',
                  'env-specific-var--dev',
                  // ENV refs in string/template-literal text render verbatim (inlining must not rewrite them)
                  'ENV.PUBLIC_VAR mentioned in a string',
                  'ENV.PUBLIC_VAR in template text, interpolated: unprefixed-public-var',
                  'ENV.PUBLIC_VAR as jsx text',
                ],
              },
              {
                description: 'pages-router page: env vars are injected via getStaticProps',
                filePath: 'out/pages-static.html',
                shouldContain: [
                  'next-prefixed-public-var',
                  'unprefixed-public-var',
                  'env-specific-var--dev',
                  'pages-static-sensitive-available',
                ],
              },
              {
                description: 'no secrets or wrong-env values in any static output',
                fileGlob: 'out/**/*.html',
                shouldNotContain: [
                  'super-secret-var',
                  'env-specific-var--prod',
                ],
              },
            ],
            outputAssertions: [
              {
                description: 'secret is redacted from stdout',
                shouldContain: ['secret-log-test:', 'pages-static-secret-log-test:'],
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

        describe.skipIf(!runBuildScenarios)('default output mode', () => {
          // Middleware compiles into its own edge bundle; output layout differs by bundler
          const middlewareOutputGlob = webpackOrTurbo === 'turbopack'
            ? '.next/server/edge/**/*.js'
            : '.next/server/middleware.js';

          // One build covering the app router (server + client component),
          // the pages router (getStaticProps), and edge middleware — each
          // asserted against its own output file.
          nextEnv.describeScenario('static pages (server + client component + pages router + middleware)', {
            command: buildCommand,
            expectSuccess: true,
            templateFiles: {
              'app/page.tsx': 'pages/basic-page.tsx',
              'app/client-page/page.tsx': 'pages/client-page.tsx',
              'pages/pages-static.tsx': 'pages-router/static-page.tsx',
              'middleware.ts': 'middleware/middleware.ts',
            },
            fileAssertions: [
              {
                description: 'server page: env vars are injected into output',
                filePath: '.next/server/app/index.html',
                shouldContain: [
                  'next-prefixed-public-var',
                  'unprefixed-public-var',
                  'env-specific-var--dev',
                  'sensitive-var-available',
                ],
              },
              {
                description: 'client component page: public env vars are inlined',
                filePath: '.next/server/app/client-page.html',
                shouldContain: [
                  'next-prefixed-public-var',
                  'unprefixed-public-var',
                  'env-specific-var--dev',
                  // ENV refs in string/template-literal text render verbatim (inlining must not rewrite them)
                  'ENV.PUBLIC_VAR mentioned in a string',
                  'ENV.PUBLIC_VAR in template text, interpolated: unprefixed-public-var',
                  'ENV.PUBLIC_VAR as jsx text',
                ],
              },
              {
                description: 'pages-router page: env vars are injected via getStaticProps',
                filePath: '.next/server/pages/pages-static.html',
                shouldContain: [
                  'next-prefixed-public-var',
                  'unprefixed-public-var',
                  'env-specific-var--dev',
                  'pages-static-sensitive-available',
                ],
              },
              {
                description: 'middleware bundle: public env vars are inlined',
                fileGlob: middlewareOutputGlob,
                shouldContain: [
                  'varlock-middleware-response',
                  'unprefixed-public-var',
                ],
              },
              {
                description: 'no secrets or wrong-env values in any pre-rendered output',
                fileGlob: '.next/**/*.html',
                shouldNotContain: [
                  'super-secret-var',
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
                shouldContain: ['secret-log-test:', 'pages-static-secret-log-test:'],
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

          // A sensitive value passed through getStaticProps leaks into both the
          // rendered HTML and the __NEXT_DATA__ payload. Needs its own build, so
          // only run on the newest major to keep the older version jobs fast.
          nextEnv.describeScenario('leaky pages-router page', {
            skip: nextVersion < 16,
            command: buildCommand,
            templateFiles: {
              'app/page.tsx': 'pages/basic-page.tsx',
              'pages/pages-leaky.tsx': 'pages-router/leaky-page.tsx',
            },
            expectSuccess: false,
            outputAssertions: [
              {
                description: 'output contains leak detection message',
                shouldContain: ['DETECTED LEAKED SENSITIVE CONFIG'],
              },
            ],
          });

          // The encrypted blob is produced by varlock before bundling, so bundler
          // choice doesn't affect it — only run on the version's default bundler.
          nextEnv.describeScenario('encrypted env blob with _VARLOCK_ENV_KEY', {
            skip: webpackOrTurbo !== defaultBundler,
            command: buildCommand,
            env: { _VARLOCK_ENV_KEY: randomBytes(32).toString('hex') },
            templateFiles: {
              'app/page.tsx': 'pages/basic-page.tsx',
            },
            expectSuccess: true,
            fileAssertions: [
              {
                description: 'server JS files contain encrypted blob (varlock:v1: prefix) instead of plaintext',
                fileGlob: '.next/server/**/*.js',
                shouldContain: ['varlock:v1:'],
                shouldNotContain: ['super-secret-var'],
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
