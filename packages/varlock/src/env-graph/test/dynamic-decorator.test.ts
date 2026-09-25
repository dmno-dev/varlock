import {
  describe, test, expect,
} from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';
import { computeFilteredKeys } from '../lib/item-filter';
import { SchemaError } from '../lib/errors';

describe('@dynamic, @static, and @defaultDynamic', () => {
  test('default behavior: dynamic follows sensitivity', envFilesTest({
    envFile: outdent`
      SECRET=        # @sensitive
      PUBLIC=        # @public
      SECRET_FALSE=  # @sensitive=false
      PUBLIC_FALSE=  # @public=false
    `,
    expectDynamic: {
      SECRET: true,
      PUBLIC: false,
      SECRET_FALSE: false,
      PUBLIC_FALSE: true,
    },
  }));

  test('@dynamic and @static override default behavior', envFilesTest({
    envFile: outdent`
      STATIC_SECRET= # @sensitive @static
      DYNAMIC_PUBLIC= # @public @dynamic
      STATIC_FALSE=  # @static=false
      DYNAMIC_FALSE= # @dynamic=false
    `,
    expectDynamic: {
      STATIC_SECRET: false,
      DYNAMIC_PUBLIC: true,
      STATIC_FALSE: true,
      DYNAMIC_FALSE: false,
    },
  }));

  test('dynamic @dynamic/@static values work', envFilesTest({
    envFile: outdent`
      DYNAMIC_TRUE=   # @dynamic=if(yes)
      DYNAMIC_FALSE=  # @dynamic=if(0)
      STATIC_TRUE=    # @static=if(yes)
      STATIC_FALSE=   # @static=if(0)
    `,
    expectDynamic: {
      DYNAMIC_TRUE: true,
      DYNAMIC_FALSE: false,
      STATIC_TRUE: false,
      STATIC_FALSE: true,
    },
  }));

  test('@defaultDynamic=true', envFilesTest({
    envFile: outdent`
      # @defaultDynamic=true
      # ---
      PUBLIC= # @public
      OTHER=
    `,
    expectDynamic: {
      PUBLIC: true,
      OTHER: true,
    },
  }));

  test('@defaultDynamic=false', envFilesTest({
    envFile: outdent`
      # @defaultDynamic=false
      # ---
      SECRET= # @sensitive
      OTHER=
    `,
    expectDynamic: {
      SECRET: false,
      OTHER: false,
    },
  }));

  test('@defaultDynamic=inferFromSensitive links dynamic to final sensitivity', envFilesTest({
    envFile: outdent`
      # @defaultSensitive=inferFromPrefix(PUBLIC_)
      # @defaultDynamic=inferFromSensitive
      # ---
      PUBLIC_FOO=
      SECRET_BAR=
    `,
    expectSensitive: {
      PUBLIC_FOO: false,
      SECRET_BAR: true,
    },
    expectDynamic: {
      PUBLIC_FOO: false,
      SECRET_BAR: true,
    },
  }));

  test('explicit @dynamic/@static beats @defaultDynamic', envFilesTest({
    envFile: outdent`
      # @defaultDynamic=inferFromSensitive
      # ---
      SECRET_STATIC= # @sensitive @static
      PUBLIC_DYNAMIC= # @public @dynamic
    `,
    expectDynamic: {
      SECRET_STATIC: false,
      PUBLIC_DYNAMIC: true,
    },
  }));

  // isDynamic is only serialized when it diverges from the sensitivity linkage,
  // so consumers read `isDynamic ?? isSensitive` and the common-case blob stays small
  test('serializes isDynamic in graph output only when it diverges from sensitivity', envFilesTest({
    envFile: outdent`
      PUBLIC=         # @public
      DYNAMIC_PUBLIC= # @public @dynamic
      SECRET=         # @sensitive
      STATIC_SECRET=  # @sensitive @static
    `,
    expectSerializedMatches: {
      config: {
        PUBLIC: { isSensitive: false },
        DYNAMIC_PUBLIC: { isSensitive: false, isDynamic: true },
        SECRET: { isSensitive: true },
        STATIC_SECRET: { isSensitive: true, isDynamic: false },
      },
    },
  }));

  test('@dynamic/@static work as --filter decorator selectors', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        PUBLIC_STATIC=a   # @public
        PUBLIC_DYNAMIC=b  # @public @dynamic
        SECRET=c          # @sensitive
        STATIC_SECRET=d   # @sensitive @static
      `,
    }));
    await g.finishLoad();
    await g.resolveEnvValues();
    const items = Object.values(g.configSchema);

    expect(computeFilteredKeys(items, '@dynamic', 'test filter'))
      .toEqual(new Set(['PUBLIC_DYNAMIC', 'SECRET']));
    // static = negated dynamic (no dedicated @static selector, matching @public/@optional)
    expect(computeFilteredKeys(items, '!@dynamic', 'test filter'))
      .toEqual(new Set(['PUBLIC_STATIC', 'STATIC_SECRET']));
    expect(computeFilteredKeys(items, '@dynamic,!@sensitive', 'test filter'))
      .toEqual(new Set(['PUBLIC_DYNAMIC']));
  });
});

// `@dynamic=boot`: bound at process start on each instance, so it can be fixed neither at
// build (like any dynamic item) nor at deploy (`varlock freeze` leaves it out of the pin)
describe('@dynamic=boot', () => {
  test('boot items are dynamic', envFilesTest({
    envFile: outdent`
      PORT=       # @dynamic=boot
      PUBLIC=     # @public
    `,
    expectDynamic: { PORT: true, PUBLIC: false },
  }));

  test('the boot level is knowable from the schema alone', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        PORT=3000         # @public @dynamic=boot
        SECRET=x          # @sensitive
        PUBLIC_DYNAMIC=y  # @public @dynamic
      `,
    }));
    await g.finishLoad();
    // before any resolution
    expect(g.configSchema.PORT.isBootDynamic).toBe(true);
    expect(g.configSchema.SECRET.isBootDynamic).toBe(false);
    expect(g.configSchema.PUBLIC_DYNAMIC.isBootDynamic).toBe(false);
    await g.resolveEnvValues();
    // a boot item is still selected by the @dynamic filter (it is a subset of dynamic)
    expect(computeFilteredKeys(Object.values(g.configSchema), '@dynamic', 'test filter'))
      .toEqual(new Set(['PORT', 'SECRET', 'PUBLIC_DYNAMIC']));
    // and the blob just says dynamic - the boot level only matters to `varlock freeze`
    expect(g.getSerializedGraph().config.PORT).toMatchObject({ isSensitive: false, isDynamic: true });
  });

  test('other string values are schema errors', envFilesTest({
    envFile: outdent`
      PORT= # @dynamic=runtime
    `,
    expectValues: { PORT: SchemaError },
  }));

  test('boot must be written literally, not computed', envFilesTest({
    envFile: outdent`
      PORT= # @dynamic=if(yes, boot, boot)
    `,
    expectValues: { PORT: SchemaError },
  }));

  test('@static has no boot form', envFilesTest({
    envFile: outdent`
      PORT= # @static=boot
    `,
    expectValues: { PORT: SchemaError },
  }));

  describe('nothing bound earlier may depend on a boot item', () => {
    test('a value reference is a schema error, transitively', envFilesTest({
      envFile: outdent`
        PORT=3000                       # @dynamic=boot
        PUBLIC_URL=http://localhost:\${PORT}
        HEALTH_URL=\${PUBLIC_URL}/health
        UNRELATED=fine
      `,
      expectValues: {
        PUBLIC_URL: SchemaError,
        HEALTH_URL: SchemaError,
        UNRELATED: 'fine',
      },
    }));

    test('a decorator function reference counts too', envFilesTest({
      envFile: outdent`
        PORT=3000   # @dynamic=boot
        TLS=        # @required=eq($PORT, 443)
      `,
      expectValues: { TLS: SchemaError },
    }));

    test('the error names the boot key and the fix', async () => {
      const g = new EnvGraph();
      await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
        overrideContents: outdent`
          PORT=3000   # @dynamic=boot
          PUBLIC_URL=http://localhost:\${PORT}
        `,
      }));
      await g.finishLoad();
      const err = g.configSchema.PUBLIC_URL.errors[0];
      expect(err).toBeInstanceOf(SchemaError);
      expect(err.message).toContain('PUBLIC_URL depends on PORT, which is @dynamic=boot');
      expect(err.more?.tip).toContain('Mark PUBLIC_URL @dynamic=boot too');
    });

    // the rule is one-directional - a boot item built from pinned values is the common case
    test('a boot item may depend on pinned items', envFilesTest({
      envFile: outdent`
        DB_HOST=db.internal                       # @public
        DB_URL=postgres://\${DB_HOST}:\${DB_PORT}   # @dynamic=boot
        DB_PORT=5432                              # @dynamic=boot
      `,
      expectValues: { DB_URL: 'postgres://db.internal:5432' },
      expectDynamic: { DB_URL: true, DB_HOST: false },
    }));

    test('the @currentEnv item selects env files, so it cannot be boot', envFilesTest({
      envFile: outdent`
        # @currentEnv=$APP_ENV
        # ---
        APP_ENV=production  # @dynamic=boot
      `,
      expectValues: { APP_ENV: SchemaError },
    }));

    // root decorators run before any value is available at boot, so under `varlock freeze`
    // they would resolve a boot item at deploy time and bake the result into the pin
    test('a root decorator cannot reference a boot item', async () => {
      const g = new EnvGraph();
      await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
        overrideContents: outdent`
          # @redactLogs=$BOOT
          # ---
          BOOT=false  # @dynamic=boot
        `,
      }));
      await g.finishLoad();
      const source = g.rootDataSource!;
      expect(source.isValid).toBe(false);
      expect(source.errors[0].message).toContain('@redactLogs depends on BOOT, which is @dynamic=boot');
      // refused before executing, so the boot item's resolver never ran
      expect(g.configSchema.BOOT.isResolved).toBe(false);
      expect(g.getRootDec('redactLogs')?.resolvedValue).toBeUndefined();
    });

    test('the decorators that resolve even earlier (@disable, @cache) are refused too', envFilesTest({
      files: {
        '.env.schema': outdent`
          # @cache=if($BOOT, "memory", "disabled")
          # @import(./.env.extra)
          # ---
          BOOT=true  # @dynamic=boot
        `,
        '.env.extra': outdent`
          # @disable=not($BOOT)
          # ---
          EXTRA=1
        `,
      },
      expectError: true,
    }));

    test('@disable names the rule rather than failing on an unresolved value', async () => {
      const g = new EnvGraph();
      g.setVirtualImports(process.cwd(), {
        '.env.extra': outdent`
          # @disable=not($BOOT)
          # ---
          EXTRA=1
        `,
      });
      await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
        overrideContents: outdent`
          # @import(./.env.extra)
          # ---
          BOOT=true  # @dynamic=boot
        `,
      }));
      await g.finishLoad();
      const messages = g.sortedDataSources.flatMap((s) => s.errors.map((e) => e.message));
      expect(messages.some((m) => m.includes('@disable depends on BOOT, which is @dynamic=boot'))).toBe(true);
      expect(g.configSchema.BOOT.isResolved).toBe(false);
    });

    test('an early-resolved boot item is never resolved', async () => {
      const g = new EnvGraph();
      await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
        overrideContents: outdent`
          # @cache=if($BOOT, "memory", "disabled")
          # ---
          BOOT=true  # @dynamic=boot
        `,
      }));
      await g.finishLoad();
      expect(g.configSchema.BOOT.isResolved).toBe(false);
      expect(g.configSchema.BOOT.errors[0].message).toContain('BOOT is @dynamic=boot, so it cannot be used by @currentEnv, @disable, @import, or @cache');
    });
  });
});
