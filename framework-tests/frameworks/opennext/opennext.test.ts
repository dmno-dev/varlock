/*
Next.js on Cloudflare Workers via OpenNext (@opennextjs/cloudflare), run in local workerd.

`opennextjs-cloudflare build` runs `next build` as a child process, which the Next.js
integration detects and freezes the (encrypted) env into the build output; the worker then
decrypts it at boot with the `_VARLOCK_ENV_KEY` binding. The page fixtures are shared with
the plain Next.js suite so the same contract (env values, middleware, request-time leak
scanning, log redaction) is asserted on this target.
*/
import { randomBytes } from 'node:crypto';
import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

const NEXT_FIXTURES = '../../nextjs/files';

/** an encrypted env payload (not just the `varlock:v1:` prefix, which the runtime code contains) */
const ENCRYPTED_PAYLOAD_RE = /varlock:v1:[A-Za-z0-9+/=:_-]{100,}/;

// A frozen Next.js build needs the key at build time, and the worker needs it as a binding
const ENV_KEY = randomBytes(32).toString('hex');

describe('Next.js on Cloudflare via OpenNext', () => {
  const env = new FrameworkTestEnv({
    testDir: import.meta.dirname,
    framework: 'opennext',
    packageManager: 'pnpm',
    dependencies: {
      next: '^16',
      react: '^19',
      'react-dom': '^19',
      '@types/react': '^19',
      '@opennextjs/cloudflare': '^1.20',
      wrangler: '^4',
      varlock: 'will-be-replaced',
      '@varlock/nextjs-integration': 'will-be-replaced',
    },
    templateFiles: {
      '.env.schema': `${NEXT_FIXTURES}/schemas/.env.schema`,
      '.env.dev': `${NEXT_FIXTURES}/schemas/.env.dev`,
      '.env.prod': `${NEXT_FIXTURES}/schemas/.env.prod`,
      'app/page.tsx': `${NEXT_FIXTURES}/pages/basic-page.tsx`,
      'pages/pages-ssr.tsx': `${NEXT_FIXTURES}/pages-router/ssr-page.tsx`,
      'pages/leaky-ssr.tsx': `${NEXT_FIXTURES}/pages-router/leaky-ssr-page.tsx`,
      'pages/api/leaky.ts': `${NEXT_FIXTURES}/pages-router/leaky-api-route.ts`,
      'middleware.ts': `${NEXT_FIXTURES}/middleware/middleware.ts`,
    },
    // `opennextjs-cloudflare build` runs the project's own `build` script for the Next build
    scripts: {
      build: 'next build',
    },
    overrides: {
      '@next/env': '<packed:@varlock/nextjs-integration>',
    },
  });
  beforeAll(() => env.setup(), 240_000);
  afterAll(() => env.teardown());

  env.describeScenario('build freezes the encrypted env into the worker', {
    command: 'opennextjs-cloudflare build',
    env: { _VARLOCK_ENV_KEY: ENV_KEY },
    timeout: 240_000,
    outputAssertions: [
      {
        description: 'the OpenNext build is detected and the env is frozen, encrypted',
        shouldContain: ['env frozen into the bundle (OpenNext', 'encrypted with _VARLOCK_ENV_KEY'],
      },
      {
        description: 'pre-render secret log is redacted',
        shouldContain: ['secret-log-test:'],
        shouldNotContain: ['super-secret-var'],
      },
    ],
    fileAssertions: [
      {
        // `.open-next/worker.js` is a template that wrangler bundles later; the Next server
        // and the middleware are pre-bundled by OpenNext into these handlers
        description: 'server and middleware handlers carry the encrypted frozen env',
        fileGlob: '.open-next/{server-functions/default,middleware}/handler.mjs',
        shouldMatch: [ENCRYPTED_PAYLOAD_RE],
      },
      {
        description: 'no secret in plaintext anywhere in the build output',
        fileGlob: '.open-next/**/*.{js,mjs,html}',
        shouldNotContain: ['super-secret-var'],
      },
    ],
  });

  env.describeDevScenario('worker serves the app in local workerd', {
    // the harness prefixes only the first command with `pnpm exec`; the second runs in the
    // shell, where wrangler is not on PATH unless installed globally
    command: 'opennextjs-cloudflare build && pnpm exec wrangler dev --port 15400',
    // the dev runner forces NODE_ENV=development for dev servers, but this scenario starts
    // with a production `next build` (a pages-router prerender fails under any other value)
    env: { _VARLOCK_ENV_KEY: ENV_KEY, NODE_ENV: 'production' },
    files: [{ path: '.dev.vars', content: `_VARLOCK_ENV_KEY=${ENV_KEY}\n` }],
    readyPattern: /Ready on/i,
    readyTimeout: 240_000,
    timeout: 300_000,
    requests: [
      {
        label: 'prerendered app-router page has env values from the build',
        path: '/',
        bodyAssertions: {
          shouldContain: [
            'Varlock Framework Test - Next.js',
            'next-prefixed-public-var',
            'unprefixed-public-var',
            'env-specific-var--dev',
            'sensitive-var-available',
          ],
          shouldNotContain: ['super-secret-var'],
        },
      },
      {
        label: 'pages-router getServerSideProps reads the frozen env at request time',
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
        label: 'middleware reads env (incl. sensitive)',
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
        // request-time leak from getServerSideProps: never reaches the client
        label: 'runtime leak detection blocks a secret in an SSR response',
        path: '/leaky-ssr',
        allowRequestFailure: true,
        bodyAssertions: {
          shouldNotContain: ['super-secret-var'],
        },
      },
      {
        label: 'runtime leak detection blocks a secret in a pages-router API route',
        path: '/api/leaky',
        allowRequestFailure: true,
        bodyAssertions: {
          shouldNotContain: ['super-secret-var'],
        },
      },
      {
        label: 'worker still serves after a blocked leak',
        path: '/pages-ssr',
        bodyAssertions: {
          shouldContain: ['Varlock Pages Router SSR Page'],
        },
      },
    ],
    outputAssertions: [
      {
        description: 'runtime secret logs are redacted, leak detection fires, no raw secret in logs',
        shouldContain: ['runtime-secret-log-test:', 'DETECTED LEAKED SENSITIVE CONFIG'],
        shouldNotContain: ['super-secret-var'],
      },
    ],
  });
});
