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
