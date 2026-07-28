import {
  describe, test, expect,
} from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';
import { computeFilteredKeys } from '../lib/item-filter';

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
