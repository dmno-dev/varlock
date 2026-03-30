import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';

/**
 * Tests that @import(enabled=...) and @disable(...) correctly resolve
 * variables that are set in gitignored files (.env, .env.local, .env.ENV, .env.ENV.local).
 *
 * The bug: early resolution of these directives happens before gitignored
 * files are loaded, so values from .env.local etc. are not available.
 */

describe('early resolve order - @import enabled with values from local files', () => {
  test('import enabled condition resolves var set in .env', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.azure, enabled=eq($AUTH_MODE, "azure"))
        # ---
        AUTH_MODE=none
      `,
      '.env': outdent`
        AUTH_MODE=azure
      `,
      '.env.azure': outdent`
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'azure',
      AZURE_CLIENT_ID: 'some-client-id',
    },
  }));

  test('import enabled condition resolves var set in .env.local', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.azure, enabled=eq($AUTH_MODE, "azure"))
        # ---
        AUTH_MODE=none
      `,
      '.env.local': outdent`
        AUTH_MODE=azure
      `,
      '.env.azure': outdent`
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'azure',
      AZURE_CLIENT_ID: 'some-client-id',
    },
  }));

  test('import enabled condition resolves var set in .env.ENV file', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # @import(./.env.azure, enabled=eq($AUTH_MODE, "azure"))
        # ---
        APP_ENV=dev
        AUTH_MODE=none
      `,
      '.env.dev': outdent`
        AUTH_MODE=azure
      `,
      '.env.azure': outdent`
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'azure',
      AZURE_CLIENT_ID: 'some-client-id',
    },
  }));

  test('import enabled condition resolves var set in .env.ENV.local file', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # @import(./.env.azure, enabled=eq($AUTH_MODE, "azure"))
        # ---
        APP_ENV=dev
        AUTH_MODE=none
      `,
      '.env.dev.local': outdent`
        AUTH_MODE=azure
      `,
      '.env.azure': outdent`
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'azure',
      AZURE_CLIENT_ID: 'some-client-id',
    },
  }));

  test('import stays disabled when .env.local does NOT set the enabling value', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.azure, enabled=eq($AUTH_MODE, "azure"))
        # ---
        AUTH_MODE=none
      `,
      '.env.local': outdent`
        AUTH_MODE=none
      `,
      '.env.azure': outdent`
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'none',
    },
    expectNotInSchema: ['AZURE_CLIENT_ID'],
  }));
});

describe('early resolve order - import in env-specific file with values from local files', () => {
  test('import in .env.ENV can be enabled by a value in .env.ENV.local', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        AUTH_MODE=none
      `,
      '.env.dev': outdent`
        # @import(./.env.azure, enabled=eq($AUTH_MODE, "azure"))
        # ---
      `,
      '.env.dev.local': outdent`
        AUTH_MODE=azure
      `,
      '.env.azure': outdent`
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'azure',
      AZURE_CLIENT_ID: 'some-client-id',
    },
  }));

  test('import in .env.ENV stays disabled when .env.ENV.local does not set the enabling value', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        AUTH_MODE=none
      `,
      '.env.dev': outdent`
        # @import(./.env.azure, enabled=eq($AUTH_MODE, "azure"))
        # ---
      `,
      '.env.dev.local': outdent`
        AUTH_MODE=none
      `,
      '.env.azure': outdent`
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'none',
    },
    expectNotInSchema: ['AZURE_CLIENT_ID'],
  }));
});

describe('early resolve order - @disable with values from local files', () => {
  test('@disable condition resolves var set in .env.local', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.azure)
        # ---
        AUTH_MODE=none
      `,
      '.env.local': outdent`
        AUTH_MODE=azure
      `,
      '.env.azure': outdent`
        # @disable=not(eq($AUTH_MODE, "azure"))
        # ---
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'azure',
      AZURE_CLIENT_ID: 'some-client-id',
    },
  }));

  test('@disable condition resolves var set in .env', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.azure)
        # ---
        AUTH_MODE=none
      `,
      '.env': outdent`
        AUTH_MODE=azure
      `,
      '.env.azure': outdent`
        # @disable=not(eq($AUTH_MODE, "azure"))
        # ---
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'azure',
      AZURE_CLIENT_ID: 'some-client-id',
    },
  }));

  test('@disable condition resolves var set in .env.ENV file', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # @import(./.env.azure)
        # ---
        APP_ENV=dev
        AUTH_MODE=none
      `,
      '.env.dev': outdent`
        AUTH_MODE=azure
      `,
      '.env.azure': outdent`
        # @disable=not(eq($AUTH_MODE, "azure"))
        # ---
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'azure',
      AZURE_CLIENT_ID: 'some-client-id',
    },
  }));

  test('@disable condition resolves var set in .env.ENV.local file', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # @import(./.env.azure)
        # ---
        APP_ENV=dev
        AUTH_MODE=none
      `,
      '.env.dev.local': outdent`
        AUTH_MODE=azure
      `,
      '.env.azure': outdent`
        # @disable=not(eq($AUTH_MODE, "azure"))
        # ---
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'azure',
      AZURE_CLIENT_ID: 'some-client-id',
    },
  }));

  test('file stays disabled when .env.local does NOT set the enabling value', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.azure)
        # ---
        AUTH_MODE=none
      `,
      '.env.local': outdent`
        AUTH_MODE=none
      `,
      '.env.azure': outdent`
        # @disable=not(eq($AUTH_MODE, "azure"))
        # ---
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'none',
    },
    expectNotInSchema: ['AZURE_CLIENT_ID'],
  }));
});

describe('early resolve order - error when later file redefines early-resolved item', () => {
  test('error when env-specific file redefines the @currentEnv item', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-schema
      `,
      '.env.dev': outdent`
        APP_ENV=staging
      `,
    },
    earlyError: true,
  }));

  test('error when imported file redefines item used in @import enabled condition', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.azure, enabled=eq($AUTH_MODE, "azure"))
        # ---
        AUTH_MODE=none
      `,
      '.env.local': outdent`
        AUTH_MODE=azure
      `,
      '.env.azure': outdent`
        AUTH_MODE=none
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    earlyError: true,
  }));

  test('error when imported file redefines item used in @disable condition', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.azure)
        # ---
        AUTH_MODE=none
      `,
      '.env.local': outdent`
        AUTH_MODE=azure
      `,
      '.env.azure': outdent`
        # @disable=not(eq($AUTH_MODE, "azure"))
        # ---
        AUTH_MODE=none
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    earlyError: true,
  }));

  test('no error when imported file defines a different item (not the early-resolved one)', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.azure, enabled=eq($AUTH_MODE, "azure"))
        # ---
        AUTH_MODE=none
      `,
      '.env.local': outdent`
        AUTH_MODE=azure
      `,
      '.env.azure': outdent`
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'azure',
      AZURE_CLIENT_ID: 'some-client-id',
    },
  }));

  test('no error when imported file sets the same value as early-resolved', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.azure, enabled=eq($AUTH_MODE, "azure"))
        # ---
        AUTH_MODE=none
      `,
      '.env.local': outdent`
        AUTH_MODE=azure
      `,
      '.env.azure': outdent`
        AUTH_MODE=azure
        AZURE_CLIENT_ID=some-client-id
      `,
    },
    expectValues: {
      AUTH_MODE: 'azure',
      AZURE_CLIENT_ID: 'some-client-id',
    },
  }));

  test('no error when env-specific file sets the same value as early-resolved @currentEnv item', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-schema
      `,
      '.env.dev': outdent`
        ITEM1=val-from-dev
        APP_ENV=dev
      `,
    },
    expectValues: {
      ITEM1: 'val-from-dev',
      APP_ENV: 'dev',
    },
  }));

  test('no error when later file only adds decorators to early-resolved item (no value)', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=dev
        ITEM1=val-from-schema
      `,
      '.env.dev': outdent`
        # ---
        # @required
        APP_ENV=
        ITEM1=val-from-dev
      `,
    },
    expectValues: {
      ITEM1: 'val-from-dev',
      APP_ENV: 'dev',
    },
  }));
});
