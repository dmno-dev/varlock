import {
  describe, test, expect, vi,
} from 'vitest';
import path from 'node:path';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';
import { EnvGraph, DotEnvFileDataSource, SchemaError } from '../index';
import { createEnvGraphDataType } from '../lib/data-types';

async function loadSchema(contents: string) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: contents }));
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

describe('@sensitive and @defaultSensitive tests', () => {
  test('no @defaultSensitive set - sensitive by default, can override', envFilesTest({
    envFile: outdent`
      TRUE=     # @sensitive=true
      FALSE=    # @sensitive=false
      UNDEF=    # @sensitive=undefined
      DEFAULT=
    `,
    expectSensitive: {
      TRUE: true, FALSE: false, UNDEF: true, DEFAULT: true,
    },
  }));

  test('static @defaultSensitive=true', envFilesTest({
    envFile: outdent`
      # @defaultSensitive=true
      # ---
      TRUE=     # @sensitive=true
      FALSE=    # @sensitive=false
      UNDEF=    # @sensitive=undefined
      DEFAULT=
    `,
    expectSensitive: {
      TRUE: true, FALSE: false, UNDEF: true, DEFAULT: true,
    },
  }));

  test('static @defaultSensitive=false', envFilesTest({
    envFile: outdent`
      # @defaultSensitive=false
      # ---
      TRUE=     # @sensitive=true
      FALSE=    # @sensitive=false
      UNDEF=    # @sensitive=undefined
      DEFAULT=
    `,
    expectSensitive: {
      TRUE: true, FALSE: false, UNDEF: false, DEFAULT: false,
    },
  }));

  test('@public and @sensitive mark items properly', envFilesTest({
    envFile: outdent`
      SENSITIVE=        # @sensitive
      SENSITIVE_TRUE=   # @sensitive=true
      SENSITIVE_FALSE=  # @sensitive=false
      SENSITIVE_UNDEF=  # @sensitive=undefined
      PUBLIC=           # @public
      PUBLIC_TRUE=      # @public=true
      PUBLIC_FALSE=     # @public=false
      PUBLIC_UNDEF=     # @public=undefined
    `,
    expectSensitive: {
      SENSITIVE: true,
      SENSITIVE_TRUE: true,
      SENSITIVE_FALSE: false,
      SENSITIVE_UNDEF: true, // stays as default
      PUBLIC: false,
      PUBLIC_TRUE: false,
      PUBLIC_FALSE: true,
      PUBLIC_UNDEF: true, // stays as default
    },
  }));

  test('@public and @sensitive can be overridden', envFilesTest({
    files: {
      '.env.schema': outdent`
        WAS_SENSITIVE= # @sensitive
        WAS_PUBLIC=    # @public
      `,
      '.env': outdent`
        WAS_SENSITIVE= # @public
        WAS_PUBLIC=    # @sensitive
      `,
    },
    expectSensitive: {
      WAS_SENSITIVE: false, WAS_PUBLIC: true,
    },
  }));

  describe('dynamic @sensitive', () => {
    test('dynamic @sensitive works', envFilesTest({
      envFile: outdent`
        TRUE=  # @sensitive=if(yes)
        FALSE= # @sensitive=if(0)
        UNDEF= # @sensitive=if(true, undefined) # uses default
      `,
      expectSensitive: {
        TRUE: true, FALSE: false, UNDEF: true,
      },
    }));

    test('dynamic @public works', envFilesTest({
      envFile: outdent`
        TRUE=  # @public=if(yes)
        FALSE= # @public=if(0)
        UNDEF= # @public=if(true, undefined) # uses default
      `,
      expectSensitive: {
        TRUE: false, FALSE: true, UNDEF: true,
      },
    }));
  });

  describe('inferFromPrefix() - use key prefix to infer sensitivity', () => {
    test('base case @defaultSensitive=inferFromPrefix', envFilesTest({
      envFile: outdent`
        # @defaultSensitive=inferFromPrefix(PUBLIC_)
        # ---
        PUBLIC_FOO=
        BAR=
      `,
      expectSensitive: { PUBLIC_FOO: false, BAR: true },
    }));

    test('key matches prefix is not sensitive (with explicit override)', envFilesTest({
      envFile: outdent`
        # @defaultSensitive=inferFromPrefix(PUBLIC_)
        # ---
        PUBLIC_FOO=
        # @sensitive=true
        SECRET_BAR=
      `,
      expectSensitive: { PUBLIC_FOO: false, SECRET_BAR: true },
    }));

    test('key does not match prefix is sensitive (with explicit override)', envFilesTest({
      envFile: outdent`
        # @defaultSensitive=inferFromPrefix(PUBLIC_)
        # ---
        # @sensitive=false
        FOO=
        PUBLIC_BAR=
      `,
      expectSensitive: { FOO: false, PUBLIC_BAR: false },
    }));

    test('explicit @sensitive overrides defaultSensitive', envFilesTest({
      envFile: outdent`
        # @defaultSensitive=inferFromPrefix(PUBLIC_)
        # ---
        # @sensitive=false
        SECRET_BAR=
        # @sensitive=true
        PUBLIC_FOO=
      `,
      expectSensitive: { SECRET_BAR: false, PUBLIC_FOO: true },
    }));
  });

  describe('explicit @sensitive overrides @defaultSensitive from other files', () => {
    test('@sensitive in schema wins over @defaultSensitive=false in local', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @sensitive
          ITEM_A=
        `,
        '.env.local': outdent`
          # @defaultSensitive=false
          # ---
          ITEM_A=secret
        `,
      },
      expectSensitive: { ITEM_A: true },
    }));

    test('@sensitive=false in schema wins over @defaultSensitive=true in local', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @sensitive=false
          ITEM_A=
        `,
        '.env.local': outdent`
          # @defaultSensitive=true
          # ---
          ITEM_A=value
        `,
      },
      expectSensitive: { ITEM_A: false },
    }));

    test('@public in schema wins over @defaultSensitive=true in local', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @public
          ITEM_A=
        `,
        '.env.local': outdent`
          # @defaultSensitive=true
          # ---
          ITEM_A=value
        `,
      },
      expectSensitive: { ITEM_A: false },
    }));

    test('@sensitive in local wins over @defaultSensitive=false in schema', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @defaultSensitive=false
          # ---
          ITEM_A=
        `,
        '.env.local': outdent`
          # @sensitive
          ITEM_A=secret
        `,
      },
      expectSensitive: { ITEM_A: true },
    }));

    test('@sensitive in schema wins over inferFromPrefix in local', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @sensitive
          PUBLIC_ITEM=
        `,
        '.env.local': outdent`
          # @defaultSensitive=inferFromPrefix(PUBLIC_)
          # ---
          PUBLIC_ITEM=value
        `,
      },
      expectSensitive: { PUBLIC_ITEM: true },
    }));

    test('items without explicit decorator still follow @defaultSensitive', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @sensitive
          EXPLICIT_SENSITIVE=
          NO_DECORATOR=
        `,
        '.env.local': outdent`
          # @defaultSensitive=false
          # ---
          EXPLICIT_SENSITIVE=secret
          NO_DECORATOR=value
        `,
      },
      expectSensitive: { EXPLICIT_SENSITIVE: true, NO_DECORATOR: false },
    }));
  });

  describe('data type with sensitive flag', () => {
    function dataTypeSensitiveTest(spec: {
      envFile: string;
      sensitiveDataType: boolean;
      expectSensitive: Record<string, boolean>;
    }) {
      return async () => {
        const currentDir = path.dirname(expect.getState().testPath!);
        vi.spyOn(process, 'cwd').mockReturnValue(currentDir);

        const g = new EnvGraph();
        g.registerDataType(createEnvGraphDataType({
          name: 'secret-token',
          sensitive: spec.sensitiveDataType,
        }));
        const source = new DotEnvFileDataSource('.env.schema', { overrideContents: spec.envFile });
        await g.setRootDataSource(source);
        await g.finishLoad();
        await g.resolveEnvValues();

        for (const [key, expected] of Object.entries(spec.expectSensitive)) {
          const item = g.configSchema[key];
          expect(item.isSensitive, `expected ${key} to be ${expected ? 'sensitive' : 'NOT sensitive'}`).toBe(expected);
        }
      };
    }

    test('data type sensitive=true makes items sensitive', dataTypeSensitiveTest({
      sensitiveDataType: true,
      envFile: outdent`
        TYPED=      # @type=secret-token
        UNTYPED=
      `,
      expectSensitive: { TYPED: true, UNTYPED: true },
    }));

    test('data type sensitive=false makes items not sensitive (overrides default)', dataTypeSensitiveTest({
      sensitiveDataType: false,
      envFile: outdent`
        TYPED=      # @type=secret-token
        UNTYPED=
      `,
      expectSensitive: { TYPED: false, UNTYPED: true },
    }));

    test('data type sensitive skips @defaultSensitive', dataTypeSensitiveTest({
      sensitiveDataType: true,
      envFile: outdent`
        # @defaultSensitive=false
        # ---
        TYPED=      # @type=secret-token
        UNTYPED=
      `,
      expectSensitive: { TYPED: true, UNTYPED: false },
    }));

    test('explicit @sensitive=false overrides data type sensitive=true', dataTypeSensitiveTest({
      sensitiveDataType: true,
      envFile: outdent`
        # @sensitive=false
        TYPED=      # @type=secret-token
        UNTYPED=
      `,
      expectSensitive: { TYPED: false, UNTYPED: true },
    }));

    test('explicit @public overrides data type sensitive=true', dataTypeSensitiveTest({
      sensitiveDataType: true,
      envFile: outdent`
        # @public
        TYPED=      # @type=secret-token
        UNTYPED=
      `,
      expectSensitive: { TYPED: false, UNTYPED: true },
    }));

    test('explicit @sensitive=true overrides data type sensitive=false', dataTypeSensitiveTest({
      sensitiveDataType: false,
      envFile: outdent`
        # @sensitive
        TYPED=      # @type=secret-token
        UNTYPED=
      `,
      expectSensitive: { TYPED: true, UNTYPED: true },
    }));
  });
});

// maybe not the right spot, but it is related to sensitivity and decorators
// we are checking redactLogs/preventLeaks are serialized correctly and can be disabled
describe('@redactLogs and @preventLeaks', () => {
  test('redactLogs and preventLeaks is on by default', envFilesTest({
    expectSerializedMatches: {
      settings: {
        redactLogs: true,
        preventLeaks: true,
      },
    },
  }));
  test('redactLogs and preventLeaks is on by default', envFilesTest({
    envFile: outdent`
      # @redactLogs=false
      # @preventLeaks=false
      # ---
    `,
    expectSerializedMatches: {
      settings: {
        redactLogs: false,
        preventLeaks: false,
      },
    },
  }));
});

describe('per-item @sensitive={preventLeaks=false}', () => {
  test('opts an item out of leak detection while keeping it sensitive', envFilesTest({
    envFile: outdent`
      LEAKY=val      # @sensitive={preventLeaks=false}
      NORMAL=val     # @sensitive
    `,
    expectSensitive: { LEAKY: true, NORMAL: true },
    expectSerializedMatches: {
      config: {
        // opted-out item carries the flag so the runtime scanner can skip it
        LEAKY: { isSensitive: true, preventLeaks: false },
      },
    },
  }));

  test('preventLeaks=true is the default and is not emitted in the serialized graph', envFilesTest({
    envFile: outdent`
      A=val   # @sensitive={preventLeaks=true}
      B=val   # @sensitive
    `,
    expectSensitive: { A: true, B: true },
    expectSerializedMatches: {
      config: {
        A: { isSensitive: true },
        B: { isSensitive: true },
      },
    },
  }));

  test('enabled=false toggles the item to not sensitive', envFilesTest({
    envFile: outdent`
      OFF=val   # @sensitive={enabled=false}
      ON=val    # @sensitive={enabled=true, preventLeaks=false}
    `,
    expectSensitive: { OFF: false, ON: true },
    expectSerializedMatches: {
      config: {
        ON: { isSensitive: true, preventLeaks: false },
      },
    },
  }));

  test('enabled can be a function for dynamic sensitivity (forEnv)', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=production
        SENSITIVE_IN_PROD=  # @sensitive={enabled=forEnv(production), preventLeaks=false}
        SENSITIVE_IN_DEV=   # @sensitive={enabled=forEnv(dev)}
      `,
    },
    expectSensitive: {
      SENSITIVE_IN_PROD: true,
      SENSITIVE_IN_DEV: false,
    },
  }));

  test('non-boolean enabled is rejected', envFilesTest({
    envFile: 'FOO=val   # @sensitive={enabled=nope}',
    expectValues: { FOO: SchemaError },
  }));

  test('@public does not accept options', envFilesTest({
    envFile: 'FOO=val   # @public={preventLeaks=false}',
    expectValues: { FOO: SchemaError },
  }));

  test('unknown options are rejected', envFilesTest({
    envFile: 'FOO=val   # @sensitive={redactLogs=false}',
    expectValues: { FOO: SchemaError },
  }));

  test('non-boolean preventLeaks is rejected', envFilesTest({
    envFile: 'FOO=val   # @sensitive={preventLeaks=nope}',
    expectValues: { FOO: SchemaError },
  }));

  test('an array literal is rejected (options must be an object)', envFilesTest({
    envFile: 'FOO=val   # @sensitive=[preventLeaks]',
    expectValues: { FOO: SchemaError },
  }));

  test('bare fn-call form @sensitive(...) is rejected (reserved for repeatable decorators)', envFilesTest({
    envFile: 'FOO=val   # @sensitive(preventLeaks=false)',
    expectValues: { FOO: SchemaError },
  }));

  test('the bare fn-call error points users to the object value form', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: 'FOO=val   # @sensitive(preventLeaks=false)',
    }));
    await g.finishLoad();
    await g.resolveEnvValues();
    const messages = g.configSchema.FOO.errors.map((e) => e.message);
    expect(messages.some((m) => m.includes('@sensitive={preventLeaks=false}'))).toBe(true);
  });

  test('a short sensitive value warns, and allowShortValue acknowledges it', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false
        # ---
        # @sensitive
        SLUG=acmeco

        # a one-time code is short by nature, so the warning has no remedy
        # (quoted so it stays a string - a numeric secret is rejected outright)
        # @sensitive={allowShortValue=true}
        OTP="123456"

        # @sensitive
        REAL_SECRET=sk-live-9f2b71c4a8de
      `,
    }));
    await g.finishLoad();
    await g.resolveEnvValues();

    const warnings = (key: string) => g.configSchema[key].errors.filter((e) => e.isWarning).map((e) => e.message);
    expect(warnings('SLUG')).toEqual([expect.stringContaining('Value is very short')]);
    expect(g.configSchema.SLUG.validationState).toBe('warn');
    // acknowledged: no warning, and still sensitive (redaction is unaffected)
    expect(warnings('OTP')).toEqual([]);
    expect(g.configSchema.OTP.isSensitive).toBe(true);
    expect(g.configSchema.OTP.validationState).toBe('valid');
    // long enough that a collision is implausible
    expect(warnings('REAL_SECRET')).toEqual([]);
  });

  test('allowShortValue must be a boolean', envFilesTest({
    envFile: 'FOO=val   # @sensitive={allowShortValue="yes"}',
    expectValues: { FOO: SchemaError },
  }));

  // the floor follows the same explicit/implicit split as everything else, so nothing
  // inherited from @defaultSensitive can fail a load - but it cannot be acknowledged
  // either way, since at this length the collision is a certainty rather than a risk
  test('a value too short to redact safely cannot be acknowledged', async () => {
    const g = await loadSchema(outdent`
      # @defaultRequired=false
      # ---
      # @sensitive
      TINY=ab

      # allowShortValue acknowledges a collision risk, and there is nothing to acknowledge
      # here - no output survives redacting two characters
      # @sensitive={allowShortValue=true}
      TINY_ACKED=ab

      # sensitive only via @defaultSensitive - warns rather than fails, like every other rule
      IMPLICIT_TINY=ab

      # @sensitive=false
      NOT_SENSITIVE=ab

      # at the floor: warns, and the ack does apply to the warning
      # @sensitive
      AT_FLOOR=abc
      # @sensitive={allowShortValue=true}
      AT_FLOOR_ACKED=abc
    `);
    expect(g.configSchema.TINY.validationState).toBe('error');
    expect(g.configSchema.TINY.errors.map((e) => e.message)).toEqual([expect.stringContaining('only 2 characters long')]);
    expect(g.configSchema.TINY_ACKED.validationState).toBe('error');
    expect(g.configSchema.IMPLICIT_TINY.validationState).toBe('warn');
    expect(g.configSchema.NOT_SENSITIVE.validationState).toBe('valid');

    expect(g.configSchema.AT_FLOOR.validationState).toBe('warn');
    expect(g.configSchema.AT_FLOOR_ACKED.validationState).toBe('valid');
  });

  test('composite values are measured per element, like redaction registers them', async () => {
    const g = await loadSchema(outdent`
      # @defaultRequired=false
      # ---
      # the joined form is long, but "x" registers for redaction on its own
      # @sensitive @type=array(string)
      ARR=averylongsecretvaluehere,x
    `);
    expect(g.configSchema.ARR.validationState).toBe('error');
    expect(g.configSchema.ARR.errors[0].message).toContain('only 1 character long');
  });

  test('a boolean carries no secret, so sensitivity is rejected or warned', async () => {
    const g = await loadSchema(outdent`
      # @defaultRequired=false
      # ---
      # @sensitive @type=boolean
      DECLARED=true

      # same when the type is only inferred from the value
      # @sensitive
      INFERRED=false

      # swept in by @defaultSensitive, so nothing was written to reject
      IMPLICIT=true
    `);
    expect(g.configSchema.DECLARED.errors.map((e) => e.message)).toEqual(['a boolean value cannot be sensitive']);
    expect(g.configSchema.INFERRED.validationState).toBe('error');

    expect(g.configSchema.IMPLICIT.validationState).toBe('warn');
    expect(g.configSchema.IMPLICIT.errors.map((e) => e.message)).toEqual(['sensitive, but a boolean carries no secret to protect']);
  });

  // demoting a boolean to non-sensitive would also make it @static, so a value read at
  // runtime would start being inlined into a build with nothing announcing the change.
  // Until that lands in a breaking release, sensitivity (and therefore dynamic) is untouched.
  test('rejecting a boolean does not quietly change its static/dynamic behavior', async () => {
    const g = await loadSchema(outdent`
      # @defaultRequired=false
      # ---
      IMPLICIT=true
    `);
    const item = g.configSchema.IMPLICIT;
    expect(item.isSensitive).toBe(true);
    expect(item.isDynamic).toBe(true);
    // type generation computes sensitivity separately, and must not diverge either
    const typeGenInfo = await item.getTypeGenInfo();
    expect(typeGenInfo.isSensitive).toBe(item.isSensitive);
    expect(typeGenInfo.isDynamic).toBe(item.isDynamic);
  });

  test('an explicitly sensitive number is an error, pointing at a string instead', async () => {
    const g = await loadSchema(outdent`
      # @defaultRequired=false
      # ---
      # @sensitive @type=number
      DECLARED=987654321

      # the type is inferred here, and the value is damaged the same way
      # @sensitive
      INFERRED=987654321

      # quoting keeps it a string, which is the fix the error points to
      # @sensitive
      QUOTED="00987654321987"
    `);
    expect(g.configSchema.DECLARED.errors.map((e) => e.message)).toEqual(['a number value cannot be sensitive']);
    expect(g.configSchema.INFERRED.validationState).toBe('error');
    expect(g.configSchema.QUOTED.validationState).toBe('valid');
  });

  // a hand-written schema defaults to sensitive, so every port and timeout in the file
  // lands here - failing those is a bad trade for a case that is usually not a secret
  test('a number swept in by @defaultSensitive warns instead of failing', async () => {
    const g = await loadSchema(outdent`
      # @defaultRequired=false
      # ---
      PORT=3000
    `);
    const item = g.configSchema.PORT;
    expect(item.validationState).toBe('warn');
    expect(item.errors.map((e) => e.message)).toEqual(['sensitive, but a number is never redacted']);
    // still sensitive, so still @dynamic - the value is never inlined into a build
    expect(item.isSensitive).toBe(true);
    expect(item.isDynamic).toBe(true);
    // and the length rules stay quiet, since they are about redaction that never happens
    expect(item.errors.length).toBe(1);
  });

  // a composite hides its leaves from the scalar type rules: array(number) has a composite
  // coercedType while every element is a number, and redaction only registers string leaves
  test('a sensitive composite with non-string elements is rejected', async () => {
    const g = await loadSchema(outdent`
      # @defaultRequired=false
      # ---
      # @sensitive @type=array(number)
      NUM_LIST=[111111,222222]

      # @sensitive @type=record(number)
      NUM_REC={low=111111}

      # @sensitive @type=array(string)
      STR_LIST=[averylongsecretvalue,anotherlongsecretval]

      # not explicitly sensitive, so it warns rather than failing
      IMPLICIT_NUMS=[111111,222222]
    `);
    expect(g.configSchema.NUM_LIST.errors.map((e) => e.message)).toEqual(['sensitive value has elements that are not strings, which are not redacted on their own']);
    expect(g.configSchema.NUM_REC.validationState).toBe('error');
    expect(g.configSchema.STR_LIST.validationState).toBe('valid');

    expect(g.configSchema.IMPLICIT_NUMS.validationState).toBe('warn');
    expect(g.configSchema.IMPLICIT_NUMS.errors.map((e) => e.message)).toEqual(['sensitive, but elements that are not strings are not redacted on their own']);
  });

  test('the @currentEnv item is rejected or warned, like the type rules', async () => {
    const explicit = await loadSchema(outdent`
      # @defaultRequired=false
      # @currentEnv=$APP_ENV
      # ---
      # @sensitive
      APP_ENV=development
    `);
    expect(explicit.configSchema.APP_ENV.errors.map((e) => e.message)).toEqual(['@sensitive cannot be used on the @currentEnv item']);

    // swept in by @defaultSensitive, which is what most schemas with a @currentEnv have -
    // failing those would be a bigger break than it is worth, but the env name really is
    // being redacted everywhere, so staying silent is not right either
    const implicit = await loadSchema(outdent`
      # @defaultRequired=false
      # @currentEnv=$APP_ENV
      # ---
      APP_ENV=development
    `);
    // exactly one message: the specific one replaces the generic short-value warning
    expect(implicit.configSchema.APP_ENV.errors.map((e) => e.message)).toEqual(['sensitive, but the @currentEnv item is not a secret']);
    expect(implicit.configSchema.APP_ENV.validationState).toBe('warn');

    const optedOut = await loadSchema(outdent`
      # @defaultRequired=false
      # @currentEnv=$APP_ENV
      # ---
      # @sensitive=false
      APP_ENV=development
    `);
    expect(optedOut.configSchema.APP_ENV.validationState).toBe('valid');
  });

  // a warning for now: this is the only rule that depends on how two resolved values
  // relate, so as a hard failure it could pass locally and fail in CI. Error in a
  // breaking release.
  test('a non-sensitive value containing a sensitive one warns', async () => {
    const g = await loadSchema(outdent`
      # @defaultRequired=false
      # ---
      # @sensitive
      DB_PASSWORD=sup3rs3cretp4ssw0rd

      # @public
      DATABASE_URL=postgres://user:sup3rs3cretp4ssw0rd@host/db

      # @public
      UNRELATED=https://example.com
    `);
    expect(g.configSchema.DATABASE_URL.errors.map((e) => e.message)).toEqual(['Value contains the sensitive value of DB_PASSWORD']);
    expect(g.configSchema.DATABASE_URL.validationState).toBe('warn');
    // the secret itself is fine, and unrelated public items are untouched
    expect(g.configSchema.DB_PASSWORD.validationState).toBe('valid');
    expect(g.configSchema.UNRELATED.validationState).toBe('valid');
  });

  // a short sensitive value inside a public one is more collision than leak, but that
  // collision is confirmed rather than hypothetical - redaction really will rewrite the
  // public value - so it warns even though `allowShortValue` silenced the generic warning
  // redaction only registers string leaves, so a sensitive number is not in the map and
  // cannot collide with anything - it carries its own diagnostic instead
  test('a sensitive number inside a public value is not reported as a collision', async () => {
    const g = await loadSchema(outdent`
      # @defaultRequired=false
      # ---
      SERVICE_PORT=3000

      # @public
      SERVICE_URL=https://api.example.com:3000/v1
    `);
    expect(g.configSchema.SERVICE_URL.validationState).toBe('valid');
    expect(g.configSchema.SERVICE_PORT.errors.map((e) => e.message)).toEqual(['sensitive, but a number is never redacted']);
  });

  // runtime registers a composite's serialized form as well as its string leaves, so an
  // array(number) with nothing redactable per element still rewrites its joined form
  test('the serialized form of a sensitive composite inside a public value is a collision', async () => {
    const g = await loadSchema(outdent`
      # @defaultRequired=false
      # ---
      # @type=array(number)
      PORTS=[3000,3001]

      # @public
      PORT_RANGE=3000,3001
    `);
    expect(g.configSchema.PORT_RANGE.errors.map((e) => e.message)).toEqual(['Value contains the sensitive value of PORTS']);
  });

  test('a short sensitive value inside a public one is flagged too', async () => {
    const g = await loadSchema(outdent`
      # @defaultRequired=false
      # ---
      # @sensitive={allowShortValue=true}
      DEPLOY_TIER=prod

      # @public
      API_URL=https://prod.example.com

      # @public
      UNRELATED=https://example.com
    `);
    expect(g.configSchema.API_URL.validationState).toBe('warn');
    expect(g.configSchema.API_URL.errors.map((e) => e.message)).toEqual(['Value contains the sensitive value of DEPLOY_TIER']);
    expect(g.configSchema.UNRELATED.validationState).toBe('valid');
  });
});
