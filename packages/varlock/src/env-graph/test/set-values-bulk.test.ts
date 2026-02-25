import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';

describe('@setValuesBulk() root decorator', () => {
  describe('JSON format', () => {
    test('explicit format=json', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"from-json"}', format=json)
        # ---
        API_KEY=
      `,
      expectValues: {
        API_KEY: 'from-json',
      },
    }));

    test('auto-detect JSON format', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"from-json"}')
        # ---
        API_KEY=
      `,
      expectValues: {
        API_KEY: 'from-json',
      },
    }));

    test('invalid JSON', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{bad-json}', format=json)
        # ---
      `,
      loadingError: true,
    }));

    test('numeric and boolean values remain typed', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"STRING":"foo","NUM":123,"NUM_STR":"123","BOOLEAN":true}', format=json, createMissing=true)
        # ---
      `,
      expectValues: {
        STRING: 'foo',
        NUM: 123,
        NUM_STR: '123',
        BOOLEAN: true,
      },
    }));
  });

  describe('.env format', () => {
    test('explicit format=env', envFilesTest({
      envFile: outdent`
        # @setValuesBulk("API_KEY=from-env", format=env)
        # ---
        API_KEY=
      `,
      expectValues: {
        API_KEY: 'from-env',
      },
    }));

    test('auto-detect env format', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('API_KEY=from-env')
        # ---
        API_KEY=
      `,
      expectValues: {
        API_KEY: 'from-env',
      },
    }));

    test('invalid env format', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('NOT_VALID_ENV', format=env)
        # ---
      `,
      loadingError: true,
    }));

    test('quoted values handled correctly', envFilesTest({
      // newlines are awkward here, so we just use multiple calls
      envFile: outdent`
        # @setValuesBulk("API_KEY=unquoted with spaces", format=env)
        # @setValuesBulk("QUOTED='quoted value'", format=env)
        # ---
        API_KEY=
        QUOTED=
      `,
      expectValues: {
        API_KEY: 'unquoted with spaces',
        QUOTED: 'quoted value',
      },
    }));
  });

  describe('precedence', () => {
    test('bulk values override same-file defaults', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"from-bulk"}', format=json)
        # ---
        API_KEY=from-schema
      `,
      expectValues: {
        API_KEY: 'from-bulk',
      },
    }));

    test('process.env overrides bulk values', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"from-bulk"}', format=json)
        # ---
        API_KEY=from-file
      `,
      overrideValues: {
        API_KEY: 'from-process-env',
      },
      expectValues: {
        API_KEY: 'from-process-env',
      },
    }));

    test('higher-precedence file overrides bulk values', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @setValuesBulk('{"API_KEY":"from-bulk","OTHER":"from-bulk"}', format=json)
          # ---
          API_KEY=
          OTHER=
        `,
        '.env.local': outdent`
          API_KEY=from-local
        `,
      },
      expectValues: {
        API_KEY: 'from-local',
        OTHER: 'from-bulk',
      },
    }));
  });

  describe('createMissing option', () => {
    test('createMissing=false (default) skips unknown keys', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"val","NEW_KEY":"new-val"}', format=json)
        # ---
        API_KEY=
      `,
      expectValues: {
        API_KEY: 'val',
      },
      expectNotInSchema: ['NEW_KEY'],
    }));

    test('createMissing=true creates new config items', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"val","NEW_KEY":"new-val"}', format=json, createMissing=true)
        # ---
        API_KEY=
      `,
      expectValues: {
        API_KEY: 'val',
        NEW_KEY: 'new-val',
      },
    }));
  });

  describe('error cases', () => {
    test('no arguments', envFilesTest({
      envFile: outdent`
        # @setValuesBulk()
        # ---
        API_KEY=
      `,
      earlyError: true,
    }));

    test('invalid format option', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{}', format=yaml)
        # ---
        API_KEY=
      `,
      earlyError: true,
    }));

    test('invalid auto-detect format', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('FOO: "bar"')
        # ---
      `,
      loadingError: true,
    }));

    test('unknown option name', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{}', badOption=true)
        # ---
        API_KEY=
      `,
      earlyError: true,
    }));
  });

  describe('edge cases', () => {
    test('empty data string is no-op', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('')
        # ---
        API_KEY=original
      `,
      expectValues: {
        API_KEY: 'original',
      },
    }));

    test('multiple @setValuesBulk in same file - later overwrites', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"first"}', format=json)
        # @setValuesBulk('{"API_KEY":"second"}', format=json)
        # ---
        API_KEY=file
      `,
      expectValues: {
        API_KEY: 'second',
      },
    }));
  });
});
