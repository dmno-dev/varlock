/*
Tests varlock + cloudflare integration using only `varlock-wrangler`
*/
import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

describe('Cloudflare Workers varlock-wrangler only', () => {
  const wranglerEnv = new FrameworkTestEnv({
    testDir: import.meta.dirname,
    framework: 'cloudflare-wrangler',
    packageManager: 'bun',
    dependencies: {
      varlock: 'will-be-replaced',
      '@varlock/cloudflare-integration': 'will-be-replaced',
      wrangler: '^4',
    },
    templateFiles: {
      '.env.schema': 'schemas/.env.schema',
      '.env.dev': 'schemas/.env.dev',
    },
    scripts: {
      dev: 'varlock-wrangler dev',
    },
    overrides: {
      punycode: 'npm:punycode@^2.3.1',
    },
  });
  beforeAll(() => wranglerEnv.setup(), 180_000);
  afterAll(() => wranglerEnv.teardown());

  wranglerEnv.describeDevScenario('basic worker', {
    command: 'varlock-wrangler dev --port 18787',
    readyPattern: /Ready on|ready in/i,
    readyTimeout: 30_000,
    templateFiles: {
      'src/index.ts': { path: 'workers/basic-worker.ts', prepend: "import '@varlock/cloudflare-integration/init';\n" },
      'wrangler.jsonc': '_base-wrangler/wrangler.jsonc',
      'tsconfig.json': '_base-wrangler/tsconfig.json',
    },
    requests: [
      {
        path: '/',
        bodyAssertions: {
          shouldContain: [
            // varlock ENV proxy - non-sensitive
            'public_var::public-test-value',
            'api_url::https://api.example.com',
            // varlock ENV proxy - sensitive (accessible but value not leaked)
            'has_sensitive::yes',
            // cloudflare native env access (injected via --env-file)
            'native_public_var::public-test-value',
            'native_has_secret::yes',
          ],
          shouldNotContain: ['super-secret-value'],
        },
      },
    ],
    outputAssertions: [
      {
        description: 'varlock notice appears in dev output',
        shouldContain: ['varlock'],
      },
      {
        description: 'sensitive value is redacted in console output',
        shouldContain: ['secret-log-test::'],
        shouldNotContain: ['super-secret-value'],
      },
    ],
  });

  wranglerEnv.describeDevScenario('leaky worker', {
    command: 'varlock-wrangler dev --port 18788',
    readyPattern: /Ready on|ready in/i,
    readyTimeout: 30_000,
    templateFiles: {
      'src/index.ts': { path: 'workers/leaky-worker.ts', prepend: "import '@varlock/cloudflare-integration/init';\n" },
      'wrangler.jsonc': '_base-wrangler/wrangler.jsonc',
      'tsconfig.json': '_base-wrangler/tsconfig.json',
    },
    requests: [
      {
        path: '/',
        expectedStatus: 500,
        bodyAssertions: {
          shouldNotContain: ['super-secret-value'],
        },
      },
    ],
    outputAssertions: [
      {
        description: 'leak detection message appears',
        shouldContain: ['DETECTED LEAKED SENSITIVE CONFIG'],
      },
    ],
  });

  wranglerEnv.describeDevScenario('leaky worker (Uint8Array body)', {
    command: 'varlock-wrangler dev --port 18790',
    readyPattern: /Ready on|ready in/i,
    readyTimeout: 30_000,
    templateFiles: {
      'src/index.ts': { path: 'workers/leaky-uint8array-worker.ts', prepend: "import '@varlock/cloudflare-integration/init';\n" },
      'wrangler.jsonc': '_base-wrangler/wrangler.jsonc',
      'tsconfig.json': '_base-wrangler/tsconfig.json',
    },
    requests: [
      {
        path: '/',
        expectedStatus: 500,
        bodyAssertions: {
          shouldNotContain: ['super-secret-value'],
        },
      },
    ],
    outputAssertions: [
      {
        description: 'leak detection message appears for Uint8Array body',
        shouldContain: ['DETECTED LEAKED SENSITIVE CONFIG'],
      },
    ],
  });

  wranglerEnv.describeDevScenario('large env (chunking)', {
    command: 'varlock-wrangler dev --port 18789',
    readyPattern: /Ready on|ready in/i,
    readyTimeout: 30_000,
    templateFiles: {
      'src/index.ts': { path: 'workers/large-env-worker.ts', prepend: "import '@varlock/cloudflare-integration/init';\n" },
      'wrangler.jsonc': '_base-wrangler/wrangler.jsonc',
      'tsconfig.json': '_base-wrangler/tsconfig.json',
      '.env.schema': 'schemas/.env.schema.large',
    },
    requests: [
      {
        path: '/',
        bodyAssertions: {
          shouldContain: [
            'public_var::public-test-value',
            // two 3000-char vars — verify they survived __VARLOCK_ENV chunking
            'large_var_a_length::3000',
            'large_var_b_length::3000',
            'has_secret::yes',
          ],
        },
      },
    ],
  });

  wranglerEnv.describeDevScenario('env reload on file change', {
    command: 'varlock-wrangler dev --port 18790',
    readyPattern: /Ready on|ready in/i,
    readyTimeout: 30_000,
    templateFiles: {
      'src/index.ts': { path: 'workers/basic-worker.ts', prepend: "import '@varlock/cloudflare-integration/init';\n" },
      'wrangler.jsonc': '_base-wrangler/wrangler.jsonc',
      'tsconfig.json': '_base-wrangler/tsconfig.json',
    },
    requests: [
      // first request — original value
      {
        path: '/',
        bodyAssertions: {
          shouldContain: ['public_var::public-test-value'],
        },
      },
      // second request — after editing .env.schema to change PUBLIC_VAR
      {
        path: '/',
        fileEdits: {
          '.env.schema': [
            '# @defaultSensitive=false @defaultRequired=infer',
            '# @currentEnv=$APP_ENV',
            '# ---',
            '',
            '# @type=enum(dev, prod)',
            'APP_ENV=dev',
            '',
            'PUBLIC_VAR=updated-test-value',
            'API_URL=https://api.example.com',
            '',
            '# @sensitive',
            'SECRET_KEY=super-secret-value',
          ].join('\n'),
        },
        bodyAssertions: {
          shouldContain: ['public_var::updated-test-value'],
          shouldNotContain: ['public_var::public-test-value'],
        },
      },
    ],
  });

  wranglerEnv.describeDevScenario('no restart on unchanged env content', {
    command: 'varlock-wrangler dev --port 18792',
    readyPattern: /Ready on|ready in/i,
    readyTimeout: 30_000,
    templateFiles: {
      'src/index.ts': { path: 'workers/basic-worker.ts', prepend: "import '@varlock/cloudflare-integration/init';\n" },
      'wrangler.jsonc': '_base-wrangler/wrangler.jsonc',
      'tsconfig.json': '_base-wrangler/tsconfig.json',
    },
    requests: [
      // first request — baseline
      {
        path: '/',
        bodyAssertions: {
          shouldContain: ['public_var::public-test-value'],
        },
      },
      // second request — write the same .env.schema content (simulates macOS spurious watch events)
      // use fileEditDelay so we wait without expecting a restart
      {
        path: '/',
        fileEdits: {
          '.env.schema': [
            '# @defaultSensitive=false @defaultRequired=infer',
            '# @currentEnv=$APP_ENV',
            '# ---',
            '',
            '# @type=enum(dev, prod)',
            'APP_ENV=dev',
            '',
            'PUBLIC_VAR=public-test-value',
            'API_URL=https://api.example.com',
            '',
            '# @sensitive',
            'SECRET_KEY=super-secret-value',
          ].join('\n'),
        },
        // wait longer than the 300ms debounce to confirm no restart occurred
        fileEditDelay: 1500,
        bodyAssertions: {
          shouldContain: ['public_var::public-test-value'],
        },
      },
    ],
    outputAssertions: [
      {
        description: 'wrangler is not restarted when env content is unchanged',
        shouldNotContain: ['env changed, restarting wrangler'],
      },
    ],
  });

  describe('invalid config', () => {
    wranglerEnv.describeScenario('invalid schema causes dev failure', {
      command: 'varlock-wrangler dev --port 18791',
      expectSuccess: false,
      templateFiles: {
        'src/index.ts': { path: 'workers/basic-worker.ts', prepend: "import '@varlock/cloudflare-integration/init';\n" },
        'wrangler.jsonc': '_base-wrangler/wrangler.jsonc',
        'tsconfig.json': '_base-wrangler/tsconfig.json',
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

  wranglerEnv.describeScenario('types generation', {
    command: 'varlock-wrangler types',
    templateFiles: {
      'src/index.ts': { path: 'workers/basic-worker.ts', prepend: "import '@varlock/cloudflare-integration/init';\n" },
      'wrangler.jsonc': '_base-wrangler/wrangler.jsonc',
      'tsconfig.json': '_base-wrangler/tsconfig.json',
    },
    fileAssertions: [
      {
        description: 'generated types include varlock env vars',
        filePath: 'worker-configuration.d.ts',
        shouldContain: [
          'PUBLIC_VAR',
          'API_URL',
          'SECRET_KEY',
        ],
        shouldNotContain: ['__VARLOCK_ENV'],
      },
    ],
  });
});
