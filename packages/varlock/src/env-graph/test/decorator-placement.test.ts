import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';
import { SchemaError } from '../lib/errors';

describe('decorator placement validation', () => {
  describe('header without divider', () => {
    test('root decorators work in header without divider', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @defaultRequired=false

          WITH_VALUE=bar
          NO_VALUE=
        `,
      },
      expectRequired: {
        WITH_VALUE: false, NO_VALUE: false,
      },
    }));

    test('root decorators in multiple header blocks (no dividers)', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @defaultRequired=false

          # @currentEnv=$APP_ENV

          APP_ENV=staging
          ITEM=foo
        `,
      },
      expectRequired: {
        ITEM: false,
      },
    }));

    test('root decorators in multiple header blocks (with divider on first)', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @defaultRequired=false
          # ---

          # @currentEnv=$APP_ENV

          APP_ENV=staging
          ITEM=foo
        `,
      },
      expectRequired: {
        ITEM: false,
      },
    }));
  });

  describe('item decorators in header trigger errors', () => {
    test('item decorator in header causes schema error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @required
          # ---
          ITEM=foo
        `,
      },
      earlyError: true,
    }));

    test('item decorator in header without divider causes schema error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @required

          ITEM=foo
        `,
      },
      earlyError: true,
    }));
  });

  describe('root decorators on config items trigger errors', () => {
    test('root decorator on config item causes schema error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @import(../.env)
          ITEM=foo
        `,
      },
      earlyError: true,
    }));

    test('root decorator as post-comment on config item causes schema error', envFilesTest({
      files: {
        '.env.schema': outdent`
          ITEM=foo # @defaultRequired
        `,
      },
      earlyError: true,
    }));
  });

  describe('decorators in orphan comment blocks trigger errors', () => {
    test('decorator in orphan comment block between items causes schema error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # header
          # ---

          ITEM1=foo

          # @required

          ITEM2=bar
        `,
      },
      earlyError: true,
    }));
  });

  describe('unknown decorators trigger errors', () => {
    test('unknown item decorator causes schema error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @requred
          ITEM=foo
        `,
      },
      expectValues: { ITEM: SchemaError },
    }));

    test('unknown root decorator causes schema error', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @nonExistentRootDec
          # ---
          ITEM=foo
        `,
      },
      earlyError: true,
    }));
  });
});
