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
      resolutionError: true,
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
      resolutionError: true,
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

    test('createMissing=sensitive creates new items as sensitive', envFilesTest({
      envFile: outdent`
        # @defaultSensitive=false
        # @setValuesBulk('{"NEW_KEY":"new-val"}', format=json, createMissing="sensitive")
        # ---
        API_KEY=val
      `,
      expectValues: {
        NEW_KEY: 'new-val',
      },
      expectSensitive: {
        NEW_KEY: true,
        API_KEY: false,
      },
    }));

    test('invalid createMissing value is an error', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"A":"val"}', format=json, createMissing="banana")
        # ---
      `,
      expectError: true,
    }));
  });

  describe('key filters', () => {
    test('no filter args injects every key', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"from-bulk","OTHER":"from-bulk"}', format=json)
        # ---
        API_KEY=from-schema
        OTHER=from-schema
      `,
      expectValues: {
        API_KEY: 'from-bulk',
        OTHER: 'from-bulk',
      },
    }));

    test('pick (allowlist) only injects listed keys', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"from-bulk","OTHER":"from-bulk"}', format=json, pick=[API_KEY])
        # ---
        API_KEY=from-schema
        OTHER=from-schema
      `,
      expectValues: {
        API_KEY: 'from-bulk',
        OTHER: 'from-schema',
      },
    }));

    test('pick with multiple keys', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"A":"bulk","B":"bulk","C":"bulk"}', format=json, pick=[A, C])
        # ---
        A=schema
        B=schema
        C=schema
      `,
      expectValues: {
        A: 'bulk',
        B: 'schema',
        C: 'bulk',
      },
    }));

    test('pick accepts a multi-line array literal', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"A":"bulk","B":"bulk","C":"bulk"}', format=json, pick=[
        #   A,
        #   C,
        # ])
        # ---
        A=schema
        B=schema
        C=schema
      `,
      expectValues: {
        A: 'bulk',
        B: 'schema',
        C: 'bulk',
      },
    }));

    test('omit (denylist) injects everything except listed keys', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"from-bulk","OTHER":"from-bulk"}', format=json, omit=[OTHER])
        # ---
        API_KEY=from-schema
        OTHER=from-schema
      `,
      expectValues: {
        API_KEY: 'from-bulk',
        OTHER: 'from-schema',
      },
    }));

    test('pick supports glob patterns', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"bulk","API_URL":"bulk","DB_HOST":"bulk"}', format=json, pick=[API_*])
        # ---
        API_KEY=schema
        API_URL=schema
        DB_HOST=schema
      `,
      expectValues: {
        API_KEY: 'bulk',
        API_URL: 'bulk',
        DB_HOST: 'schema',
      },
    }));

    test('omit supports glob patterns', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"bulk","DEBUG_A":"bulk","DEBUG_B":"bulk"}', format=json, omit=[DEBUG_*])
        # ---
        API_KEY=schema
        DEBUG_A=schema
        DEBUG_B=schema
      `,
      expectValues: {
        API_KEY: 'bulk',
        DEBUG_A: 'schema',
        DEBUG_B: 'schema',
      },
    }));

    test('pick combines with createMissing', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"A":"bulk","B":"bulk"}', format=json, createMissing=true, pick=[A])
        # ---
      `,
      expectValues: {
        A: 'bulk',
      },
      expectNotInSchema: ['B'],
    }));

    test('using both pick and omit is an error', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"A":"bulk"}', format=json, pick=[A], omit=[B])
        # ---
        A=schema
      `,
      expectError: true,
    }));

    test('empty pick list is an error', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"A":"bulk"}', format=json, pick=[])
        # ---
        A=schema
      `,
      expectError: true,
    }));

    test('non-array pick is an error', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"A":"bulk"}', format=json, pick=A)
        # ---
        A=schema
      `,
      expectError: true,
    }));
  });

  describe('error cases', () => {
    test('no arguments', envFilesTest({
      envFile: outdent`
        # @setValuesBulk()
        # ---
        API_KEY=
      `,
      expectError: true,
    }));

    test('invalid format option', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{}', format=yaml)
        # ---
        API_KEY=
      `,
      expectError: true,
    }));

    test('invalid auto-detect format', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('FOO: "bar"')
        # ---
      `,
      resolutionError: true,
    }));

    test('unknown option name', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{}', badOption=true)
        # ---
        API_KEY=
      `,
      expectError: true,
    }));
  });

  describe('enabled option', () => {
    test('enabled=true processes normally', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"from-bulk"}', format=json, enabled=true)
        # ---
        API_KEY=
      `,
      expectValues: {
        API_KEY: 'from-bulk',
      },
    }));

    test('enabled=false skips processing entirely', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"from-bulk"}', format=json, enabled=false)
        # ---
        API_KEY=from-schema
      `,
      expectValues: {
        API_KEY: 'from-schema',
      },
    }));

    test('enabled using dynamic expression', envFilesTest({
      envFile: outdent`
        # @setValuesBulk('{"API_KEY":"from-bulk1"}', format=json, enabled=eq($SOME_VAR, "enable"))
        # @setValuesBulk('{"API_KEY":"from-bulk2"}', format=json, enabled=eq($SOME_VAR, "disable"))
        # ---
        API_KEY=
        SOME_VAR=enable
      `,
      expectValues: {
        API_KEY: 'from-bulk1',
      },
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
