import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

describe('Expo Integration', () => {
  const expoEnv = new FrameworkTestEnv({
    testDir: import.meta.dirname,
    framework: 'expo',
    packageManager: 'pnpm',
    dependencies: {
      '@babel/core': '^7.25.0',
      '@babel/preset-typescript': '^7.25.0',
      varlock: 'will-be-replaced',
      '@varlock/expo-integration': 'will-be-replaced',
    },
    templateFiles: {
      '.env.schema': 'schemas/.env.schema',
    },
  });

  beforeAll(() => expoEnv.setup(), 180_000);
  afterAll(() => expoEnv.teardown());

  describe('client page', () => {
    expoEnv.describeScenario('basic page', {
      command: 'node build.mjs',
      templateFiles: {
        'app/page.tsx': 'pages/basic-page.tsx',
      },
      fileAssertions: [
        {
          description: 'public env vars are statically replaced',
          fileGlob: 'dist/**/*.js',
          shouldContain: [
            '"Varlock Expo Test"',
            '"https://api.example.com"',
          ],
        },
        {
          description: 'sensitive var is NOT inlined (secret value absent)',
          fileGlob: 'dist/**/*.js',
          shouldNotContain: ['super-secret-key-12345'],
        },
        {
          description: 'sensitive var reference is preserved',
          fileGlob: 'dist/**/*.js',
          shouldContain: ['ENV.SECRET_KEY'],
        },
      ],
      outputAssertions: [
        {
          description: 'log line appears but secret value is redacted',
          shouldContain: ['secret-log-test:'],
          shouldNotContain: ['super-secret-key-12345'],
        },
      ],
    });

    expoEnv.describeScenario('leaky page — secret value never appears in output', {
      command: 'node build.mjs',
      templateFiles: {
        'app/page.tsx': 'pages/leaky-page.tsx',
      },
      fileAssertions: [
        {
          description: 'sensitive var is NOT inlined even when used directly',
          fileGlob: 'dist/**/*.js',
          shouldNotContain: ['super-secret-key-12345'],
        },
        {
          description: 'sensitive var reference is preserved as ENV.SECRET_KEY',
          fileGlob: 'dist/**/*.js',
          shouldContain: ['ENV.SECRET_KEY'],
        },
      ],
      outputAssertions: [
        {
          description: 'build warns about sensitive var in client file',
          shouldContain: ['@sensitive'],
        },
      ],
    });
  });

  describe('mixed client + server build', () => {
    expoEnv.describeScenario('warns only for client file, not server route', {
      command: 'node build.mjs',
      templateFiles: {
        'app/page.tsx': 'pages/mixed-page.tsx',
        'app/data+api.ts': 'pages/server-route+api.ts',
      },
      fileAssertions: [
        {
          description: 'client page has public var replaced',
          filePath: 'dist/page.js',
          shouldContain: ['"Varlock Expo Test"'],
        },
        {
          description: 'client page does not contain secret value',
          filePath: 'dist/page.js',
          shouldNotContain: ['super-secret-key-12345'],
        },
        {
          description: 'server route has public var replaced',
          filePath: 'dist/data+api.js',
          shouldContain: ['"https://api.example.com"'],
        },
        {
          description: 'server route does not contain secret value',
          filePath: 'dist/data+api.js',
          shouldNotContain: ['super-secret-key-12345'],
        },
      ],
      outputAssertions: [
        {
          description: 'warning mentions the client file path',
          shouldContain: ['page.tsx'],
        },
        {
          description: 'warning does not mention the server +api file',
          shouldNotContain: ['data+api.ts'],
        },
      ],
    });
  });

  describe('empty sensitive var', () => {
    expoEnv.describeScenario('empty optional sensitive var is not inlined', {
      command: 'node build.mjs',
      templateFiles: {
        'app/page.tsx': 'pages/empty-secret-page.tsx',
      },
      fileAssertions: [
        {
          description: 'public var is still replaced',
          fileGlob: 'dist/**/*.js',
          shouldContain: ['"Varlock Expo Test"'],
        },
        {
          description: 'empty sensitive var reference is preserved',
          fileGlob: 'dist/**/*.js',
          shouldContain: ['ENV.EMPTY_SECRET'],
        },
      ],
    });
  });

  describe('invalid schema', () => {
    expoEnv.describeScenario('build fails on invalid config', {
      command: 'node build.mjs',
      expectSuccess: false,
      templateFiles: {
        '.env.schema': 'schemas/.env.schema.invalid',
        'app/page.tsx': 'pages/basic-page.tsx',
      },
      outputAssertions: [
        {
          description: 'error mentions failed config load',
          shouldContain: ['Failed to load varlock config'],
        },
      ],
    });
  });

  describe('server +api route', () => {
    expoEnv.describeScenario('server route handles sensitive vars without warning', {
      command: 'node build.mjs',
      templateFiles: {
        'app/page.tsx': 'pages/public-only-page.tsx',
        'app/data+api.ts': 'pages/server-route+api.ts',
      },
      fileAssertions: [
        {
          description: 'public var is statically replaced in server route',
          filePath: 'dist/data+api.js',
          shouldContain: ['"https://api.example.com"'],
        },
        {
          description: 'sensitive var is NOT inlined in server route',
          filePath: 'dist/data+api.js',
          shouldNotContain: ['super-secret-key-12345'],
        },
        {
          description: 'sensitive var reference is preserved in server route',
          filePath: 'dist/data+api.js',
          shouldContain: ['ENV.SECRET_KEY'],
        },
      ],
      outputAssertions: [
        {
          description: 'no sensitive var warning for server +api files',
          shouldNotContain: ['@sensitive'],
        },
      ],
    });
  });

  describe('metro config', () => {
    expoEnv.describeScenario('initializes resolver and ENV proxy with real varlock', {
      command: 'node test-metro-config.mjs',
      outputAssertions: [
        {
          description: 'all metro-config checks pass',
          shouldContain: ['All metro-config checks passed'],
        },
        {
          description: 'resolver resolves varlock/env',
          shouldContain: ['resolver: varlock/env'],
        },
        {
          description: 'resolver falls through for non-varlock modules',
          shouldContain: ['non-varlock fallthrough OK'],
        },
        {
          description: 'ENV proxy returns real values',
          shouldContain: ['ENV.APP_NAME = Varlock Expo Test', 'ENV.API_URL = https://api.example.com'],
        },
      ],
    });
  });
});
