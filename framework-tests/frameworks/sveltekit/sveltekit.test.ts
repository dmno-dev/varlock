import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

describe('SvelteKit', () => {
  const sveltekitEnv = new FrameworkTestEnv({
    testDir: import.meta.dirname,
    framework: 'sveltekit',
    packageManager: 'pnpm',
    dependencies: {
      '@sveltejs/adapter-static': '^3',
      '@sveltejs/kit': '^2',
      '@sveltejs/vite-plugin-svelte': '^4',
      svelte: '^5',
      vite: '^7',
      varlock: 'will-be-replaced',
      '@varlock/vite-integration': 'will-be-replaced',
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

  beforeAll(() => sveltekitEnv.setup(), 180_000);
  afterAll(() => sveltekitEnv.teardown());

  sveltekitEnv.describeScenario('static build: dynamic+public is not inlined', {
    command: 'vite build',
    fileAssertions: [
      {
        description: 'client bundle contains static public value',
        fileGlob: '.svelte-kit/output/client/**/*.js',
        shouldContain: ['public-static-dev'],
      },
      {
        description: 'client bundle does not inline dynamic public value',
        fileGlob: '.svelte-kit/output/client/**/*.js',
        shouldContain: ['PUBLIC_DYNAMIC_VAR'],
        shouldNotContain: ['public-dynamic-dev'],
      },
      {
        description: 'sensitive value is absent from output',
        fileGlob: '.svelte-kit/output/**/*.js',
        shouldNotContain: [
          'super-secret-dev',
          'public-dynamic-dev',
        ],
      },
    ],
  });

  sveltekitEnv.describeDevScenario('dev: dynamic+public is available at runtime', {
    command: 'vite dev --port 14720',
    readyPattern: /localhost:14720/,
    readyTimeout: 30_000,
    templateFiles: {
      'src/routes/__varlock/public-env/+server.ts': 'routes/public-env-endpoint.ts',
    },
    requests: [
      {
        path: '/__varlock/public-env',
        bodyAssertions: {
          shouldContain: ['"PUBLIC_DYNAMIC_VAR":"public-dynamic-dev"'],
          shouldNotContain: ['super-secret-dev', 'SECRET_VAR'],
        },
      },
      {
        path: '/__varlock/public-env',
        fileEditDelay: 2500,
        fileEdits: {
          '.env.dev': [
            'PUBLIC_STATIC_VAR=public-static-dev',
            'PUBLIC_DYNAMIC_VAR=public-dynamic-dev-updated',
            'SECRET_VAR=super-secret-dev',
          ].join('\n'),
        },
        bodyAssertions: {
          shouldContain: ['"PUBLIC_DYNAMIC_VAR":"public-dynamic-dev-updated"'],
          shouldNotContain: ['super-secret-dev', 'SECRET_VAR'],
        },
      },
    ],
  });

  sveltekitEnv.describeScenario('prerender + dynamic access is rejected (TODO)', {
    skip: true,
    command: 'vite build',
    templateFiles: {
      'src/routes/+page.svelte': 'pages/prerender-dynamic-page.svelte',
    },
    expectSuccess: false,
    outputAssertions: [
      {
        description: 'build error mentions dynamic var in prerender context',
        shouldContain: ['PUBLIC_DYNAMIC_VAR', 'prerender'],
      },
    ],
  });
});
