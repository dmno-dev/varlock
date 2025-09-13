import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';

describe('@envFlag and .env.* file loading logic', () => {
  test('@envFlag key must point to an item present in same file', envFilesTest({
    overrideValues: { APP_ENV: 'test' },
    files: {
      '.env.schema': outdent`
        # @envFlag=APP_ENV
        # ---
        OTHER_ITEM=foo
      `,
      '.env': 'APP_ENV=dev',
    },
    loadingError: true,
  }));

  test('all .env.* files are loaded in correct precedence order', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @envFlag=APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-.env.schema
        ITEM2=val-from-.env.schema
        ITEM3=val-from-.env.schema
        ITEM4=val-from-.env.schema
        ITEM5=val-from-.env.schema
      `,
      '.env': outdent`
        ITEM2=val-from-.env
        ITEM3=val-from-.env
        ITEM4=val-from-.env
        ITEM5=val-from-.env
      `,
      '.env.local': outdent`
        ITEM3=val-from-.env.local
        ITEM4=val-from-.env.local
        ITEM5=val-from-.env.local
      `,
      '.env.dev': outdent`
        ITEM4=val-from-.env.dev
        ITEM5=val-from-.env.dev
      `,
      '.env.dev.local': outdent`
        ITEM5=val-from-.env.dev.local
      `,
      // not loaded
      '.env.prod': outdent`
        ITEM1=val-from-.env.prod
        ITEM2=val-from-.env.prod
        ITEM3=val-from-.env.prod
        ITEM4=val-from-.env.prod
        ITEM5=val-from-.env.prod
      `,
    },
    expectValues: {
      ITEM1: 'val-from-.env.schema',
      ITEM2: 'val-from-.env',
      ITEM3: 'val-from-.env.local',
      ITEM4: 'val-from-.env.dev',
      ITEM5: 'val-from-.env.dev.local',
    },
  }));

  test('correct env-specific files are loaded when envFlag is overridden', envFilesTest({
    overrideValues: { APP_ENV: 'prod' },
    files: {
      '.env.schema': outdent`
        # @envFlag=APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-.env.schema
      `,
      '.env.dev': 'ITEM1=val-from-.env.dev',
      '.env.prod': 'ITEM1=val-from-.env.prod',
    },
    expectValues: {
      ITEM1: 'val-from-.env.prod',
    },
  }));

  // some other tools (e.g. dotenv-expand, Next.js) automatically skip .env.local for test mode
  // while other tools (Vite) do not. We decided to be more explicit, and give helpers to opt into that behaviour
  test('.env.local IS loaded if envFlag value is "test"', envFilesTest({
    overrideValues: { APP_ENV: 'test' },
    files: {
      '.env.schema': outdent`
        # @envFlag=APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-.env.schema
      `,
      '.env.local': 'ITEM1=val-from-.env.local',
    },
    expectValues: {
      ITEM1: 'val-from-.env.local',
    },
  }));

  test('.env.local can be skipped using `@disable=forEnv(test)`', envFilesTest({
    overrideValues: { APP_ENV: 'test' },
    files: {
      '.env.schema': outdent`
        # @envFlag=APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-.env.schema
      `,
      '.env.local': outdent`
        # @disable=forEnv(test)
        # ---
        ITEM1=val-from-.env.local
      `,
    },
    expectValues: {
      ITEM1: 'val-from-.env.schema',
    },
  }));

  test('envFlag value can be set from .env.local', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @envFlag=APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-.env.schema
      `,
      '.env.local': outdent`
        APP_ENV=staging
        ITEM1=val-from-.env.local
      `,
      '.env.staging': outdent`
        ITEM1=val-from-.env.staging
      `,
    },
    expectValues: {
      ITEM1: 'val-from-.env.staging',
    },
  }));

  test('envFlag can use a function and be based on another item', envFilesTest({
    overrideValues: { CURRENT_BRANCH: 'prod' },
    files: {
      '.env.schema': outdent`
        # @envFlag=APP_ENV
        # ---
        APP_ENV=fallback($CURRENT_BRANCH, dev)
        CURRENT_BRANCH=
        ITEM1=val-from-.env.schema
      `,
      '.env.dev': 'ITEM1=val-from-.env.dev',
      '.env.prod': 'ITEM1=val-from-.env.prod',
    },
    expectValues: {
      ITEM1: 'val-from-.env.prod',
    },
  }));

  describe('fallback env (set via cli instead of @envFlag)', () => {
    test('fallback env value can be specified if no envFlag is used', envFilesTest({
      fallbackEnv: 'staging',
      files: {
        '.env.schema': 'ITEM1=val-from-.env.schema',
        '.env.staging': 'ITEM1=val-from-.env.staging',
      },
      expectValues: {
        ITEM1: 'val-from-.env.staging',
      },
    }));
    test('fallback env value is ignored if envFlag is present', envFilesTest({
      fallbackEnv: 'staging',
      files: {
        '.env.schema': outdent`
        # @envFlag=APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-.env.schema
      `,
        '.env.dev': 'ITEM1=val-from-.env.dev',
        '.env.staging': 'ITEM1=val-from-.env.staging',
      },
      expectValues: {
        ITEM1: 'val-from-.env.dev',
      },
    }));
  });
});

describe('multiple data-source handling', () => {
  test('undefined handling for overriding values', envFilesTest({
    files: {
      '.env.schema': outdent`
      # ---
      ITEM1=val-from-.env.schema
      ITEM2=val-from-.env.schema
    `,
      '.env': outdent`
      ITEM1=           # nothing set will not override the value
      ITEM2=undefined  # will override with undefined
    `,
    },
    expectValues: {
      ITEM1: 'val-from-.env.schema',
      ITEM2: undefined,
    },
  }));
});
