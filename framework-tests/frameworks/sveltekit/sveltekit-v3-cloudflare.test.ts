/*
SvelteKit 3 + adapter-cloudflare 8.

Adapter 8 resolves `cloudflare:workers` itself: in `vite dev` it maps to
wrangler's platform proxy env (running in Node), and during the build it maps to
a stub that throws on any property access outside a request. Varlock's injected
Workers env loader must not mistake either one for a real Worker.
*/
import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

describe('SvelteKit 3 + Cloudflare adapter 8', () => {
  const env = new FrameworkTestEnv({
    testDir: import.meta.dirname,
    framework: 'sveltekit-v3-cloudflare',
    packageManager: 'pnpm',
    dependencies: {
      '@sveltejs/adapter-cloudflare': '^8',
      '@sveltejs/kit': '^3',
      '@sveltejs/vite-plugin-svelte': '^7',
      svelte: '^5',
      vite: '^8',
      wrangler: '^4',
      varlock: 'will-be-replaced',
      '@varlock/vite-integration': 'will-be-replaced',
      '@varlock/cloudflare-integration': 'will-be-replaced',
    },
    packageJsonMerge: {
      packageManager: 'pnpm@10.17.0',
    },
    templateFiles: {
      '.env.schema': 'schemas/.env.schema',
      '.env.dev': 'schemas/.env.dev',
      '.env.prod': 'schemas/.env.prod',
      'vite.config.ts': 'configs/vite.config.v3-cloudflare.ts',
      'tsconfig.json': 'configs/tsconfig.v3.json',
      'wrangler.jsonc': 'configs/wrangler.jsonc',
      'src/routes/+page.svelte': 'pages/basic-page.svelte',
    },
  });

  beforeAll(() => env.setup(), 180_000);
  afterAll(() => env.teardown());

  // SvelteKit 3 no longer supports svelte.config.js
  const deleteFiles = ['svelte.config.js'];

  // Regression for #1267: the loader threw "no __VARLOCK_ENV binding found" on
  // every SSR request, because the platform proxy env has no varlock binding
  env.describeDevScenario('dev: ENV available at runtime, secret redacted', {
    command: 'vite dev --port 14732',
    readyPattern: /localhost:14732/,
    readyTimeout: 60_000,
    deleteFiles,
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
      {
        path: '/',
        bodyAssertions: {
          shouldContain: ['public-test-value'],
          shouldNotContain: ['__VARLOCK_ENV binding'],
        },
      },
    ],
  });

  env.describeDevScenario('dev: deprecated varlockSvelteKitCloudflarePlugin still works', {
    command: 'vite dev --port 14733',
    readyPattern: /localhost:14733/,
    readyTimeout: 60_000,
    deleteFiles,
    templateFiles: {
      'vite.config.ts': 'configs/vite.config.v3-cloudflare-legacy.ts',
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
    outputAssertions: [
      {
        description: 'logs the deprecation warning',
        shouldContain: ['varlockSvelteKitCloudflarePlugin is deprecated'],
      },
    ],
  });

  env.describeScenario('build: deprecated varlockSvelteKitCloudflarePlugin injects the edge loader', {
    command: 'vite build',
    expectSuccess: true,
    timeout: 180_000,
    deleteFiles,
    templateFiles: {
      'vite.config.ts': 'configs/vite.config.v3-cloudflare-legacy.ts',
      'src/routes/api/env/+server.ts': 'routes/env-endpoint.ts',
    },
    fileAssertions: [
      {
        description: 'SSR bundle contains the injected Cloudflare runtime env-loader',
        fileGlob: '.svelte-kit/output/server/**/*.js',
        shouldContain: ['__VARLOCK_ENV_CHUNKS'],
      },
    ],
  });

  env.describeScenario('build: adapter detected and the edge loader injected', {
    command: 'vite build',
    expectSuccess: true,
    timeout: 180_000,
    deleteFiles,
    templateFiles: {
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
        shouldContain: ['__VARLOCK_ENV_CHUNKS'],
      },
      {
        description: 'sensitive value is not inlined into any built output',
        fileGlob: '.svelte-kit/**/*.js',
        shouldNotContain: ['super-secret-value'],
      },
    ],
  });

  // SvelteKit evaluates the SSR entry in Node while prerendering, where the
  // adapter's `cloudflare:workers` stub throws on property access
  env.describeScenario('build: fully prerendered app does not break', {
    command: 'vite build',
    expectSuccess: true,
    timeout: 180_000,
    deleteFiles,
    templateFiles: {
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
