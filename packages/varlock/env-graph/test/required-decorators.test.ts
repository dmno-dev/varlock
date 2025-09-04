import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph, SchemaError } from '../index';
import type { Constructor } from '@env-spec/utils/type-utils';

function requiredDecoratorTests(
  tests: Array<{
    label: string;
    envSchema?: string;
    envOverride?: string;
    overrideFileName?: string;
    expected: Record<string, boolean | Constructor<Error>>;
  }>,
) {
  return () => {
    tests.forEach(({
      label, envSchema, envOverride, expected,
    }) => {
      it(label, async () => {
        const g = new EnvGraph();
        if (envSchema) {
          const schemaSource = new DotEnvFileDataSource('.env.schema', { overrideContents: envSchema });
          g.addDataSource(schemaSource);
          await schemaSource.finishInit();
        }
        if (envOverride) {
          const overrideSource = new DotEnvFileDataSource('.env', { overrideContents: envOverride });
          g.addDataSource(overrideSource);
          await overrideSource.finishInit();
        }
        await g.finishLoad();
        for (const key of Object.keys(expected)) {
          const item = g.configSchema[key];
          if (expected[key] === SchemaError) {
            expect(item.schemaErrors.length).toBe(1);
            expect(item.schemaErrors[0]).toBeInstanceOf(expected[key]);
          } else {
            expect(item.isRequired, `expected ${key} to be ${expected[key] ? 'required' : 'NOT required'}`).toBe(expected[key]);
          }
        }
      });
    });
  };
}

describe('required decorators', requiredDecoratorTests([
  {
    label: '@required and @optional mark items properly',
    envSchema: outdent`
      REQUIRED=       # @required
      REQUIRED_TRUE=  # @required=true
      REQUIRED_FALSE= # @required=false
      OPTIONAL=       # @optional
      OPTIONAL_TRUE=  # @optional=true
      OPTIONAL_FALSE= # @optional=false
    `,
    expected: {
      REQUIRED: true,
      REQUIRED_TRUE: true,
      REQUIRED_FALSE: false,
      OPTIONAL: false,
      OPTIONAL_TRUE: false,
      OPTIONAL_FALSE: true,
    },
  },
  {
    label: '@required and @optional can be overridden',
    envSchema: outdent`
      WAS_REQUIRED= # @required
      WAS_OPTIONAL= # @optional
    `,
    envOverride: outdent`
      WAS_REQUIRED= # @optional
      WAS_OPTIONAL= # @required
    `,
    expected: {
      WAS_REQUIRED: false, WAS_OPTIONAL: true,
    },
  },
  {
    label: 'without any @defaultRequired, items are required by default',
    envSchema: outdent`
      WITH_VALUE=bar
      NO_VALUE=
      EXPLICIT_REQUIRED= # @required
      EXPLICIT_OPTIONAL= # @optional
    `,
    expected: {
      WITH_VALUE: true, NO_VALUE: true, EXPLICIT_REQUIRED: true, EXPLICIT_OPTIONAL: false,
    },
  },
  {
    label: '@defaultRequired=true makes all required by default',
    envSchema: outdent`
      # @defaultRequired=true
      # ---
      WITH_VALUE=bar
      NO_VALUE=
      EXPLICIT_REQUIRED= # @required
      EXPLICIT_OPTIONAL= # @optional
    `,
    expected: {
      WITH_VALUE: true, NO_VALUE: true, EXPLICIT_REQUIRED: true, EXPLICIT_OPTIONAL: false,
    },
  },
  {
    label: '@defaultRequired=false makes all optional by default',
    envSchema: outdent`
      # @defaultRequired=false
      # ---
      WITH_VALUE=bar
      NO_VALUE=
      EXPLICIT_REQUIRED= # @required
      EXPLICIT_OPTIONAL= # @optional
    `,
    expected: {
      WITH_VALUE: false, NO_VALUE: false, EXPLICIT_REQUIRED: true, EXPLICIT_OPTIONAL: false,
    },
  },
  {
    label: '@defaultRequired=infer will infer based on if a value is present',
    envSchema: outdent`
      # @defaultRequired=infer
      # ---
      EMPTY=
      UNDEFINED=undefined
      EMPTY_STRING=''
      STATIC_VALUE=foo
      FN_VALUE=fnCall()
      OVERRIDE_REQUIRED=    # @required
      OVERRIDE_OPTIONAL=foo # @optional
    `,
    expected: {
      EMPTY: false,
      UNDEFINED: false,
      EMPTY_STRING: false,
      STATIC_VALUE: true,
      FN_VALUE: true,
      OVERRIDE_REQUIRED: true,
      OVERRIDE_OPTIONAL: false,
    },
  },
  {
    label: '@defaultRequired=infer should only consider values set in .env.schema',
    envSchema: outdent`
      # @defaultRequired=infer
      # ---
      NOT_EMPTY_IN_SCHEMA=foo
      EMPTY_IN_SCHEMA=
    `,
    envOverride: outdent`
      NOT_EMPTY_IN_SCHEMA=
      EMPTY_IN_SCHEMA=bar
    `,
    expected: { NOT_EMPTY_IN_SCHEMA: true, EMPTY_IN_SCHEMA: false },
  },
  {
    label: '@defaultRequired=infer inferred items can be overridden in non schema files',
    envSchema: outdent`
      # @defaultRequired=infer
      # ---
      WAS_REQUIRED=foo
      WAS_OPTIONAL=
    `,
    envOverride: outdent`
      WAS_REQUIRED= # @optional
      WAS_OPTIONAL= # @required
    `,
    expected: { WAS_REQUIRED: false, WAS_OPTIONAL: true },
  },
  {
    label: '@defaultRequired=infer does not have any effect in non schema file',
    envOverride: outdent`
      # @defaultRequired=infer
      # ---
      FOO=
      BAR=
    `,
    expected: { FOO: true, BAR: true },
  },
  {
    label: 'cannot use @required and @optional together',
    envSchema: outdent`
      ERROR= # @required @optional
    `,
    expected: { ERROR: SchemaError },
  },
  {
    label: '@required and @optional only accept boolean static values',
    envSchema: outdent`
      ERROR1= # @required=123
      ERROR2= # @required="true"
      ERROR3= # @optional=123
      ERROR4= # @optional=undefined
    `,
    expected: {
      ERROR1: SchemaError,
      ERROR2: SchemaError,
      ERROR3: SchemaError,
      ERROR4: SchemaError,
    },
  },
  {
    label: '@required can use `forEnv()` helper to be set based on current envFlag',
    envSchema: outdent`
      # @envFlag=APP_ENV @defaultRequired=false
      # ---
      APP_ENV=staging
      REQ_FOR_DEV=      # @required=forEnv(dev)
      REQ_FOR_STAGING=  # @required=forEnv(staging)
      REQ_FOR_MULTIPLE= # @required=forEnv(staging, prod)
    `,
    expected: {
      REQ_FOR_DEV: false,
      REQ_FOR_STAGING: true,
      REQ_FOR_MULTIPLE: true,
    },
  },
  {
    label: '@optional can also use `forEnv()`',
    envSchema: outdent`
      # @envFlag=APP_ENV @defaultRequired=true
      # ---
      APP_ENV=staging
      OPT_FOR_DEV=      # @optional=forEnv(dev)
      OPT_FOR_STAGING=  # @optional=forEnv(staging)
      OPT_FOR_MULTIPLE= # @optional=forEnv(staging, prod)
    `,
    expected: {
      OPT_FOR_DEV: true,
      OPT_FOR_STAGING: false,
      OPT_FOR_MULTIPLE: false,
    },
  },
  {
    label: '`forEnv()` helper is not usable if no envFlag is set',
    envSchema: outdent`
      REQ_FOR_DEV=      # @required=forEnv(dev)
    `,
    expected: {
      REQ_FOR_DEV: SchemaError,
    },
  },
]));
