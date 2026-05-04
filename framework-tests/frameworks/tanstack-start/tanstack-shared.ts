/*
Shared TanStack Start test definitions, parameterized by Vite version.
*/
import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

const TANSTACK_DEPS = {
  '@tanstack/react-router': '^1.169.1',
  '@tanstack/react-start': '^1.167.62',
  '@tanstack/router-plugin': '^1.167.32',
  react: '19.2.4',
  'react-dom': '19.2.4',
};

export function defineTanstackTests(
  label: string,
  testDir: string,
  opts: {
    viteVersion: string;
    reactPluginVersion?: string;
  },
) {
  const { viteVersion, reactPluginVersion = '^5' } = opts;

  // ---- Node target (plain vite plugin) ------------------------------------
  describe(`TanStack Start (${label}) — node target`, () => {
    const nodeEnv = new FrameworkTestEnv({
      testDir,
      framework: `tanstack-start-node-${label}`,
      packageManager: 'pnpm',
      dependencies: {
        varlock: 'will-be-replaced',
        '@varlock/vite-integration': 'will-be-replaced',
        vite: viteVersion,
        '@vitejs/plugin-react': reactPluginVersion,
        ...TANSTACK_DEPS,
      },
      templateFiles: {
        '.env.schema': 'schemas/.env.schema',
        '.env.dev': 'schemas/.env.dev',
        'tsconfig.json': '_base/tsconfig.json',
        'src/routes/__root.tsx': 'routes/__root.tsx',
        'src/routes/index.tsx': 'routes/index.tsx',
        'src/router.tsx': 'routes/router.tsx',
      },
    });
    beforeAll(() => nodeEnv.setup(), 180_000);
    afterAll(() => nodeEnv.teardown());

    nodeEnv.describeDevScenario('dev server', {
      command: 'vite dev --port 15190',
      readyPattern: /Local:.*http/,
      readyTimeout: 45_000,
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.node.ts',
      },
      requests: [
        {
          path: '/',
          bodyAssertions: {
            shouldContain: [
              'public_var::public-test-value',
              'api_url::https://api.example.com',
              'has_sensitive::yes',
            ],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
      outputAssertions: [
        {
          description: 'sensitive value is redacted in console output',
          shouldContain: ['secret-log-test::'],
          shouldNotContain: ['super-secret-value'],
        },
      ],
    });

    nodeEnv.describeScenario('static build', {
      command: 'vite build',
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.node.ts',
      },
      fileAssertions: [
        {
          description: 'server bundle does not contain sensitive values',
          fileGlob: 'dist/server/**/*.js',
          shouldNotContain: ['super-secret-value'],
        },
      ],
    });

    nodeEnv.describeDevScenario('build + preview', {
      command: 'vite build && vite preview --port 15193',
      readyPattern: /Local:.*http/,
      readyTimeout: 60_000,
      timeout: 120_000,
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.node.ts',
      },
      requests: [
        {
          path: '/',
          bodyAssertions: {
            shouldContain: [
              'public_var::public-test-value',
              'api_url::https://api.example.com',
              'has_sensitive::yes',
            ],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
    });
  });

  // ---- Cloudflare target --------------------------------------------------
  describe(`TanStack Start (${label}) — cloudflare target`, () => {
    const cfEnv = new FrameworkTestEnv({
      testDir,
      framework: `tanstack-start-cf-${label}`,
      packageManager: 'pnpm',
      dependencies: {
        varlock: 'will-be-replaced',
        '@varlock/cloudflare-integration': 'will-be-replaced',
        vite: viteVersion,
        '@vitejs/plugin-react': reactPluginVersion,
        wrangler: '^4',
        '@cloudflare/vite-plugin': '^1.30.0',
        ...TANSTACK_DEPS,
      },
      overrides: {
        punycode: 'npm:punycode@^2.3.1',
      },
      templateFiles: {
        '.env.schema': 'schemas/.env.schema',
        '.env.dev': 'schemas/.env.dev',
        'tsconfig.json': '_base/tsconfig.json',
        'src/routes/__root.tsx': 'routes/__root.tsx',
        'src/routes/index.tsx': 'routes/index.tsx',
        'src/router.tsx': 'routes/router.tsx',
      },
    });
    beforeAll(() => cfEnv.setup(), 180_000);
    afterAll(() => cfEnv.teardown());

    cfEnv.describeDevScenario('dev server', {
      command: 'vite dev --port 15191',
      readyPattern: /Local:.*http/,
      readyTimeout: 45_000,
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.cloudflare.ts',
        'wrangler.jsonc': 'configs/wrangler.jsonc',
      },
      requests: [
        {
          path: '/',
          bodyAssertions: {
            shouldContain: [
              'public_var::public-test-value',
              'api_url::https://api.example.com',
              'has_sensitive::yes',
            ],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
      outputAssertions: [
        {
          description: 'sensitive value is redacted in console output',
          shouldContain: ['secret-log-test::'],
          shouldNotContain: ['super-secret-value'],
        },
      ],
    });

    cfEnv.describeScenario('cloudflare build', {
      command: 'vite build',
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.cloudflare.ts',
        'wrangler.jsonc': 'configs/wrangler.jsonc',
      },
      fileAssertions: [
        {
          description: 'server bundle does not contain sensitive values',
          fileGlob: 'dist/server/**/*.js',
          shouldNotContain: ['super-secret-value'],
        },
        {
          description: 'init code is injected only once',
          fileGlob: 'dist/server/**/*.js',
          shouldMatch: [
            // only one initVarlockEnv() call across all server JS files
            /^(?![\s\S]*initVarlockEnv\(\)[\s\S]*initVarlockEnv\(\))[\s\S]*initVarlockEnv\(\)/,
          ],
        },
      ],
    });

    cfEnv.describeDevScenario('build + preview', {
      command: 'vite build && vite preview --port 15192',
      readyPattern: /Local:.*http/,
      readyTimeout: 60_000,
      timeout: 120_000,
      templateFiles: {
        'vite.config.ts': 'configs/vite.config.cloudflare.ts',
        'wrangler.jsonc': 'configs/wrangler.jsonc',
      },
      requests: [
        {
          path: '/',
          bodyAssertions: {
            shouldContain: [
              'public_var::public-test-value',
              'api_url::https://api.example.com',
              'has_sensitive::yes',
            ],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
    });
  });
}
