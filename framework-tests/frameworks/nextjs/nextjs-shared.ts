import { randomBytes } from 'node:crypto';
import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

const ALL_BUNDLERS = [
  'webpack',
  'turbopack',
];

// CI splits each version's full suite into one job per bundler via NEXTJS_BUNDLER.
// Quick mode (just v16) skips webpack to cut build time in half.
const BUNDLER_FILTER = process.env.NEXTJS_BUNDLER
  || (process.env.NEXTJS_TURBO_ONLY ? 'turbopack' : undefined);
if (BUNDLER_FILTER && !ALL_BUNDLERS.includes(BUNDLER_FILTER)) {
  throw new Error(`Unknown NEXTJS_BUNDLER "${BUNDLER_FILTER}" (expected ${ALL_BUNDLERS.join(' or ')})`);
}
const BUNDLERS = BUNDLER_FILTER
  ? ALL_BUNDLERS.filter((b) => b === BUNDLER_FILTER)
  : ALL_BUNDLERS;

/** an encrypted env payload (not just the `varlock:v1:` prefix, which the runtime code contains) */
const ENCRYPTED_PAYLOAD_RE = /varlock:v1:[A-Za-z0-9+/=:_-]{100,}/;

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
  const defaultBundler = nextVersion >= 16 ? 'turbopack' : 'webpack';
  // Scenarios outside the per-bundler loop run once, in the default bundler's job
  const runSharedScenarios = BUNDLERS.includes(defaultBundler);

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

    describe.skipIf(!runSharedScenarios)('invalid config', () => {
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

    // next.config.ts (supported since Next 15) loads through Next's own TS
    // transpile + require-hook path, which is a different code path than
    // next.config.mjs. That hook re-transpiles required .mjs files to CJS but
    // Node still evaluates them as ESM, so the plugin's CJS output must never
    // require() varlock's ESM-only entry points ("exports is not defined in ES
    // module scope" regression).
    nextEnv.describeDevScenario('dev: next.config.ts config loading', {
      skip: nextVersion < 15 || !runSharedScenarios,
      command: `next dev ${getBuildToolFlag(nextVersion, 'turbopack')} --port ${13800 + nextVersion}`,
      readyPattern: /Ready in|Starting\.\.\./,
      readyTimeout: 40_000,
      templateFiles: {
        'app/page.tsx': 'pages/basic-page.tsx',
        'next.config.ts': 'configs/next.config.ts',
      },
      deleteFiles: ['next.config.mjs'],
      requests: [
        {
          label: 'page load serves env values',
          path: '/',
          bodyAssertions: {
            shouldContain: ['Varlock Framework Test - Next.js', 'env-specific-var--dev'],
          },
        },
      ],
      outputAssertions: [
        {
          description: 'config loads without error',
          shouldNotContain: ['Failed to load next.config.ts', 'exports is not defined'],
        },
      ],
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
            'pages/api/leaky.ts': 'pages-router/leaky-api-route.ts',
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
              // Byte-level change that resolves to the same env: the reload runs, but
              // must report "no changes found" and keep serving the same value.
              label: 'cosmetic content change: reloads but reports no env changes',
              path: '/',
              fileEdits: {
                '.env.dev': '# a comment that changes the file bytes\nENV_SPECIFIC_VAR=env-specific-var--dev',
              },
              fileEditDelay: 2500,
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
            {
              // API route leak: `res.json()` sends the whole body through a single
              // `end()` with no `write()`, which is the only path where the scanner
              // sees the body for the first time at `end`. In dev the integration
              // patches in redact mode, so the response still completes - the secret
              // just comes out scrubbed, and the client is never left hanging.
              label: 'runtime leak detection redacts a pages-router API route body',
              path: '/api/leaky',
              bodyAssertions: {
                shouldContain: ['leaked'],
                shouldNotContain: ['super-secret-var'],
              },
            },
            {
              // The fail-closed kill must only affect that one response — the dev
              // server has to keep serving afterwards. The gzip header assertion
              // pins that responses actually flow through the compressed scan path
              // (the leak scanner decodes gzip; if dev ever stopped compressing,
              // the leak scenario above would silently degrade to the plaintext path).
              label: 'dev server still serves (gzipped) after leak detection kills a response',
              path: '/pages-ssr',
              headerAssertions: { 'content-encoding': 'gzip' },
              bodyAssertions: {
                shouldContain: ['Varlock Pages Router SSR Page'],
              },
            },
          ],
          outputAssertions: [
            {
              description: 'cosmetic env file edit reloads but reports no changes',
              shouldContain: ['reloaded env, no changes found'],
            },
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

          nextEnv.describeScenario('dynamic public access in page marks route dynamic', {
            command: buildCommand,
            skip: nextVersion === 14,
            templateFiles: {
              'app/page.tsx': 'pages/dynamic-direct-page.tsx',
              'app/components/dynamic-client-widget.tsx': 'pages/dynamic-client-widget.tsx',
              '.env.schema': 'schemas/.env.schema.dynamic-public',
            },
            outputAssertions: [
              {
                description: 'route is treated as dynamic (not prerendered)',
                shouldContain: ['┌ ƒ /'],
              },
            ],
            fileAssertions: [
              {
                description: 'client bundles carry the declared public+dynamic key list, never the value',
                fileGlob: '.next/static/chunks/**/*.js',
                shouldContain: ['__varlockPublicDynamicKeys', 'PUBLIC_DYNAMIC_VAR'],
                shouldNotContain: ['public-dynamic-var'],
              },
            ],
          });

          nextEnv.describeScenario('nested dynamic public access marks route dynamic', {
            command: buildCommand,
            skip: nextVersion === 14,
            templateFiles: {
              'app/page.tsx': 'pages/dynamic-nested-page.tsx',
              '.env.schema': 'schemas/.env.schema.dynamic-public',
              'app/components/nested-dynamic-value.tsx': 'pages/dynamic-nested-component.tsx',
            },
            outputAssertions: [
              {
                description: 'route is treated as dynamic (not prerendered)',
                shouldContain: ['┌ ƒ /'],
              },
            ],
          });

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

          // Freezing the env into the bundle happens once per build, independent of the
          // bundler's compilation, so these run only on the version's default bundler.
          nextEnv.describeScenario('not frozen by default: no resolved env in the build output', {
            skip: webpackOrTurbo !== defaultBundler,
            command: buildCommand,
            env: { _VARLOCK_ENV_KEY: randomBytes(32).toString('hex') },
            templateFiles: {
              'app/page.tsx': 'pages/basic-page.tsx',
            },
            expectSuccess: true,
            outputAssertions: [
              {
                description: 'no freeze announcement',
                shouldNotContain: ['frozen into the bundle'],
              },
            ],
            fileAssertions: [
              {
                description: 'server JS files carry no env payload, encrypted or not',
                fileGlob: '.next/server/**/*.js',
                shouldNotContain: ['super-secret-var'],
                // the bare prefix appears in the varlock runtime code itself
                shouldNotMatch: [ENCRYPTED_PAYLOAD_RE],
              },
            ],
          });

          nextEnv.describeScenario('frozen into the bundle on Vercel (auto), encrypted', {
            skip: webpackOrTurbo !== defaultBundler,
            command: buildCommand,
            env: { VERCEL: '1', _VARLOCK_ENV_KEY: randomBytes(32).toString('hex') },
            templateFiles: {
              'app/page.tsx': 'pages/basic-page.tsx',
            },
            expectSuccess: true,
            outputAssertions: [
              {
                description: 'build announces the freeze and why',
                shouldContain: ['env frozen into the bundle (Vercel', 'encrypted with _VARLOCK_ENV_KEY'],
              },
            ],
            fileAssertions: [
              {
                description: 'server JS files contain the encrypted frozen env, no plaintext secret',
                fileGlob: '.next/server/**/*.js',
                shouldMatch: [ENCRYPTED_PAYLOAD_RE],
                shouldNotContain: ['super-secret-var'],
              },
            ],
          });

          nextEnv.describeScenario('freezing into the bundle without _VARLOCK_ENV_KEY fails the build', {
            skip: webpackOrTurbo !== defaultBundler,
            command: buildCommand,
            env: { VERCEL: '1' },
            templateFiles: {
              'app/page.tsx': 'pages/basic-page.tsx',
            },
            expectSuccess: false,
            outputAssertions: [
              {
                description: 'output explains the missing key and the opt-out',
                shouldContain: ['_VARLOCK_ENV_KEY is not set', '_VARLOCK_ALLOW_PLAINTEXT_FROZEN_ENV'],
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

        describe.skipIf(!runBuildScenarios)('output=standalone', () => {
          // A standalone server is copied outside the project tree (so varlock cannot be
          // found by walking up to the fixture node_modules) and booted with a stripped
          // environment and no varlock CLI, mimicking a real container image.
          const standalonePort = 15000 + (nextVersion * 10) + (webpackOrTurbo === 'turbopack' ? 5 : 0);
          const standaloneCopyDir = `/tmp/varlock-next-standalone-${label}-${webpackOrTurbo}`;
          const standaloneBootCommand = [
            `next build ${buildToolFlag}`.replace(/\s+/g, ' ').trim(),
            `rm -rf ${standaloneCopyDir}`,
            `cp -R .next/standalone ${standaloneCopyDir}`,
            // remove all package-manager bin dirs so the varlock CLI is unreachable
            `find ${standaloneCopyDir} -type d -name .bin -prune -exec rm -rf {} +`,
            // server.js is nested at the traced workspace root, which varies by next
            // version (it walks up to whatever lockfiles it finds above the project)
            `cd "$(dirname "$(find ${standaloneCopyDir} -name server.js -not -path "*/node_modules/*" | head -1)")"`,
            'NODE_BIN="$(command -v node)"',
            [
              'env -i PATH=/usr/bin:/bin NODE_ENV=production',
              `HOSTNAME=127.0.0.1 PORT=${standalonePort}`,
              '_VARLOCK_ENV_KEY=$_VARLOCK_ENV_KEY',
              'RUNTIME_BOOT_VAR=runtime-boot-value',
              '"$NODE_BIN" server.js',
            ].join(' '),
          ].join(' && ');
          const standaloneConfig = (pluginOptions?: string) => ({
            path: '_base/next.config.mjs' as const,
            replacements: {
              '// OUTPUT-MODE': "output: 'standalone',",
              ...pluginOptions && { '/* PLUGIN-OPTIONS */': pluginOptions },
            },
          });

          // A standalone build has to choose how its server gets the env: it carries neither
          // the varlock CLI nor the .env files, so leaving it to 'auto' would only fail at boot.
          nextEnv.describeScenario('standalone build without an explicit freezeIntoBundle fails the build', {
            command: buildCommand,
            env: { NODE_ENV: 'production' },
            templateFiles: {
              'next.config.mjs': standaloneConfig(),
              'app/page.tsx': 'pages/basic-page.tsx',
            },
            expectSuccess: false,
            outputAssertions: [
              {
                description: 'build fails naming both choices',
                shouldContain: [
                  'needs an explicit `freezeIntoBundle` setting',
                  'freezeIntoBundle: true',
                  'freezeIntoBundle: false',
                ],
              },
            ],
          });

          // Not frozen: the server resolves at boot, so with no varlock CLI it must fail at
          // boot with the fixes - never fall back to values resolved at build time.
          nextEnv.describeScenario('not frozen: booting with no varlock CLI fails with the fixes', {
            command: `sh -c '${standaloneBootCommand}'`,
            env: { NODE_ENV: 'production' },
            timeout: 300_000,
            templateFiles: {
              'next.config.mjs': standaloneConfig('{ freezeIntoBundle: false }'),
              'app/page.tsx': 'pages/basic-page.tsx',
            },
            expectSuccess: false,
            outputAssertions: [
              {
                description: 'boot fails naming the fixes',
                shouldContain: [
                  'no resolved env reached this Next.js server',
                  'freezeIntoBundle: true',
                ],
              },
            ],
          });

          nextEnv.describeDevScenario('frozen into the bundle: boots with no varlock CLI', {
            command: `sh -c '${standaloneBootCommand}'`,
            env: { NODE_ENV: 'production', _VARLOCK_ENV_KEY: randomBytes(32).toString('hex') },
            readyPattern: /Ready in|Starting\.\.\./,
            readyTimeout: 240_000,
            timeout: 300_000,
            templateFiles: {
              '.env.schema': {
                path: 'schemas/.env.schema',
                append: '\n# set per instance at boot (e.g. `docker run -e ...`)\n# @dynamic=boot\nRUNTIME_BOOT_VAR=build-default\n',
              },
              'next.config.mjs': standaloneConfig('{ freezeIntoBundle: true }'),
              'app/page.tsx': 'pages/runtime-boot-page.tsx',
              // production is the only mode where the response scanner throws rather
              // than redacts, so this is where an `end()`-only leak has to be handled
              'pages/api/leaky.ts': 'pages-router/leaky-api-route.ts',
            },
            requests: [
              {
                label: 'a @dynamic=boot value set at boot replaces its frozen default',
                path: '/',
                bodyAssertions: {
                  shouldContain: [
                    'Varlock Framework Test - runtime boot',
                    'runtime var via ENV: runtime-boot-value',
                    'runtime var via process.env: runtime-boot-value',
                  ],
                },
              },
              {
                // `res.json()` reaches the scanner at `end()` with no preceding
                // `write()`, but next's compression layer has already emitted the
                // headers by then, so the response cannot be rewritten and the
                // connection is killed instead. Before this was handled, the client got
                // a 200 whose Content-Length promised more bytes than were ever sent,
                // and hung waiting for them.
                label: 'leaking pages-router API route does not leave the client hanging',
                path: '/api/leaky',
                // a network failure, specifically: accepting any failure would let the
                // original hang (a client-side timeout) pass this scenario
                expectedFailure: 'network',
                bodyAssertions: {
                  shouldNotContain: ['super-secret-var'],
                },
              },
              {
                // next answers the rethrown leak error by calling `res.end()` a second
                // time; the server has to survive that and keep serving.
                label: 'server still serves after a leaking API route response',
                path: '/',
                bodyAssertions: {
                  shouldContain: ['Varlock Framework Test - runtime boot'],
                },
              },
            ],
            outputAssertions: [
              {
                description: 'build announces the freeze, and leak detection fires without logging the secret',
                shouldContain: ['env frozen into the bundle (freezeIntoBundle: true)', 'DETECTED LEAKED SENSITIVE CONFIG'],
                shouldNotContain: ['super-secret-var'],
              },
            ],
          });
        });
      });
    });
  });
}
