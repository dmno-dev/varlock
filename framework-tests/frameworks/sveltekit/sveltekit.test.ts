/*
SvelteKit framework tests.

SvelteKit is built on Vite, so it uses `@varlock/vite-integration` directly.
These cover the common Node deploy path (build + dev) and verify that the same
`varlockVitePlugin()` auto-detects `@sveltejs/adapter-cloudflare` and injects
the Workers runtime env-loader — so no Cloudflare-specific import is needed.
*/
import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

describe('SvelteKit', () => {
  const env = new FrameworkTestEnv({
    testDir: import.meta.dirname,
    framework: 'sveltekit',
    packageManager: 'pnpm',
    dependencies: {
      '@sveltejs/adapter-node': '^5',
      '@sveltejs/adapter-cloudflare': '^7',
      '@sveltejs/kit': '^2',
      '@sveltejs/vite-plugin-svelte': '^6',
      svelte: '^5',
      vite: '^7',
      wrangler: '^4',
      varlock: 'will-be-replaced',
      '@varlock/vite-integration': 'will-be-replaced',
      // CF deployers always have this (it ships `varlock-wrangler`); the vite
      // plugin pulls the edge loader from it once it detects the CF adapter.
      '@varlock/cloudflare-integration': 'will-be-replaced',
    },
    packageJsonMerge: {
      packageManager: 'pnpm@10.17.0',
    },
    templateFiles: {
      '.env.schema': 'schemas/.env.schema',
      '.env.dev': 'schemas/.env.dev',
      '.env.prod': 'schemas/.env.prod',
      'src/routes/+page.svelte': 'pages/basic-page.svelte',
    },
  });

  beforeAll(() => env.setup(), 180_000);
  afterAll(() => env.teardown());

  env.describeScenario('build: non-sensitive inlined, sensitive not leaked', {
    command: 'vite build',
    expectSuccess: true,
    timeout: 180_000,
    fileAssertions: [
      {
        description: 'client bundle inlines the non-sensitive value',
        fileGlob: '.svelte-kit/output/client/**/*.js',
        shouldContain: ['public-test-value'],
      },
      {
        description: 'sensitive value is absent from all output',
        fileGlob: '.svelte-kit/output/**/*.js',
        shouldNotContain: ['super-secret-value'],
      },
    ],
  });

  env.describeDevScenario('dev: ENV available at runtime, secret redacted', {
    command: 'vite dev --port 14730',
    readyPattern: /localhost:14730/,
    readyTimeout: 30_000,
    templateFiles: {
      'src/routes/api/env/+server.ts': 'routes/env-endpoint.ts',
    },
    requests: [
      {
        path: '/api/env',
        bodyAssertions: {
          shouldContain: ['"PUBLIC_VAR":"public-test-value"', '"HAS_SECRET":"yes"'],
          shouldNotContain: ['super-secret-value'],
        },
      },
    ],
  });

  env.describeScenario('cloudflare adapter is auto-detected and the edge loader injected', {
    command: 'vite build',
    expectSuccess: true,
    timeout: 180_000,
    templateFiles: {
      // swap in the Cloudflare adapter + wrangler config — varlockVitePlugin()
      // in vite.config.ts is unchanged from the Node build above.
      'svelte.config.js': 'configs/svelte.config.cloudflare.js',
      'wrangler.jsonc': 'configs/wrangler.jsonc',
      'src/routes/api/env/+server.ts': 'routes/env-endpoint.ts',
    },
    outputAssertions: [
      {
        description: 'logs the auto-detection notice',
        shouldContain: ['detected @sveltejs/adapter-cloudflare'],
      },
    ],
    fileAssertions: [
      {
        description: 'SSR bundle contains the injected Cloudflare runtime env-loader',
        fileGlob: '.svelte-kit/output/server/**/*.js',
        // markers from CLOUDFLARE_SSR_ENTRY_CODE — present only if detection fired
        shouldContain: ['Cloudflare-Workers', '__VARLOCK_ENV', 'cloudflare:workers'],
      },
      {
        description: 'sensitive value is not inlined into any built output',
        fileGlob: '.svelte-kit/**/*.js',
        shouldNotContain: ['super-secret-value'],
      },
    ],
  });

  // Regression guard: a fully prerendered ("totally static") app on the
  // Cloudflare adapter must still build. The injected loader is guarded by a
  // `navigator.userAgent === 'Cloudflare-Workers'` check, so it must be inert
  // when SvelteKit evaluates the SSR entry in Node during prerendering.
  env.describeScenario('cloudflare adapter + fully prerendered build does not break', {
    command: 'vite build',
    expectSuccess: true,
    timeout: 180_000,
    templateFiles: {
      'svelte.config.js': 'configs/svelte.config.cloudflare.js',
      'wrangler.jsonc': 'configs/wrangler.jsonc',
      // no dynamic routes — `prerender = true` makes the whole app static
      'src/routes/+page.ts': 'pages/prerender.ts',
    },
    fileAssertions: [
      {
        description: 'prerendered HTML inlines the non-sensitive value',
        fileGlob: '.svelte-kit/output/prerendered/**/*.html',
        shouldContain: ['public-test-value'],
      },
      {
        description: 'sensitive value is not present in any output',
        fileGlob: '.svelte-kit/**/*.{js,html}',
        shouldNotContain: ['super-secret-value'],
      },
    ],
  });
});
