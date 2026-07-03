import {
  describe, expect, test, vi,
} from 'vitest';
import outdent from 'outdent';
import path from 'node:path';

import {
  EnvGraph, DotEnvFileDataSource,
  collectTypeGenItems,
  generateTsTypesSrc,
  resolveFieldType,
  resolveFieldTypes,
  type TypeGenItemInfo,
} from '../index';
import { getTypeGenInfoMap, loadFixtureFields, loadGraph } from './type-generation/helpers';

describe('type generation', () => {
  describe('isEnvSpecific on data sources', () => {
    test('env-specific files (.env.production) are marked isEnvSpecific', async () => {
      const g = await loadGraph({
        overrideValues: { APP_ENV: 'production' },
        files: {
          '.env.schema': outdent`
            # @currentEnv=$APP_ENV
            # ---
            APP_ENV=dev
            ITEM1=schema-val
          `,
          '.env.production': outdent`
            ITEM1=prod-val
          `,
        },
      });

      const sources = g.sortedDataSources;
      const prodSource = sources.find((s) => s.label.includes('.env.production'));
      expect(prodSource).toBeDefined();
      expect(prodSource!.isEnvSpecific).toBe(true);

      const schemaSource = sources.find((s) => s.label.includes('.env.schema'));
      expect(schemaSource).toBeDefined();
      expect(schemaSource!.isEnvSpecific).toBe(false);
    });

    test('local files (.env.local) are marked isEnvSpecific', async () => {
      const g = await loadGraph({
        files: {
          '.env.schema': outdent`
            ITEM1=schema-val
          `,
          '.env.local': outdent`
            ITEM2=local-val
          `,
        },
      });

      const localSource = g.sortedDataSources.find((s) => s.label.includes('.env.local'));
      expect(localSource).toBeDefined();
      expect(localSource!.isEnvSpecific).toBe(true);

      const item2 = g.configSchema.ITEM2;
      expect(item2.defsForTypeGeneration.length).toBe(0);
    });

    test('sources with @disable=forEnv() are marked isEnvSpecific', async () => {
      const g = await loadGraph({
        overrideValues: { APP_ENV: 'dev' },
        files: {
          '.env.schema': outdent`
            # @currentEnv=$APP_ENV
            # @import(./.env.imported)
            # ---
            APP_ENV=dev
            ITEM1=schema-val
          `,
          '.env.imported': outdent`
            # @disable=forEnv(test)
            # ---
            ITEM1=imported-val
          `,
        },
      });

      const importedSource = g.sortedDataSources.find((s) => s.label.includes('.env.imported'));
      expect(importedSource).toBeDefined();
      expect(importedSource!.isEnvSpecific).toBe(true);
    });

    test('sources with static @disable are NOT marked isEnvSpecific', async () => {
      const g = await loadGraph({
        files: {
          '.env.schema': outdent`
            # @import(./.env.imported)
            # ---
            ITEM1=schema-val
          `,
          '.env.imported': outdent`
            # @disable=false
            # ---
            ITEM1=imported-val
          `,
        },
      });

      const importedSource = g.sortedDataSources.find((s) => s.label.includes('.env.imported'));
      expect(importedSource).toBeDefined();
      expect(importedSource!.isEnvSpecific).toBe(false);
    });

    test('conditionally imported sources are marked isEnvSpecific', async () => {
      const g = await loadGraph({
        overrideValues: { APP_ENV: 'dev' },
        files: {
          '.env.schema': outdent`
            # @currentEnv=$APP_ENV
            # @import(./.env.imported, enabled=forEnv("dev"))
            # ---
            APP_ENV=dev
            ITEM1=schema-val
          `,
          '.env.imported': outdent`
            EXTRA_ITEM=extra-val
          `,
        },
      });

      const extrasSource = g.sortedDataSources.find((s) => s.label.includes('.env.imported'));
      expect(extrasSource).toBeDefined();
      expect(extrasSource!.isEnvSpecific).toBe(true);
    });

    test('statically imported sources are NOT marked isEnvSpecific', async () => {
      const g = await loadGraph({
        files: {
          '.env.schema': outdent`
            # @import(./.env.imported)
            # ---
            ITEM1=schema-val
          `,
          '.env.imported': outdent`
            EXTRA_ITEM=extra-val
          `,
        },
      });

      const extrasSource = g.sortedDataSources.find((s) => s.label.includes('.env.imported'));
      expect(extrasSource).toBeDefined();
      expect(extrasSource!.isEnvSpecific).toBe(false);
    });

    test('import with static enabled=true is NOT isEnvSpecific', async () => {
      const g = await loadGraph({
        files: {
          '.env.schema': outdent`
            # @import(./.env.imported, enabled=true)
            # ---
            ITEM1=schema-val
          `,
          '.env.imported': outdent`
            EXTRA_ITEM=extra-val
          `,
        },
      });

      const extrasSource = g.sortedDataSources.find((s) => s.label.includes('.env.imported'));
      expect(extrasSource).toBeDefined();
      expect(extrasSource!.isEnvSpecific).toBe(false);
    });

    test('root entry file with env-like name (e.g. .env.infra.schema) is NOT isEnvSpecific', async () => {
      // Regression test for: @generateTypes doesn't create variables when using
      // a custom path with `varlock typegen --path .env.infra.schema`
      // The filename `.env.infra.schema` was being parsed such that applyForEnv='infra',
      // causing isEnvSpecific=true and all items being excluded from type generation.
      const g = new EnvGraph();
      await g.setRootDataSource(new DotEnvFileDataSource('.env.infra.schema', {
        overrideContents: outdent`
          # @defaultSensitive=false
          # ---
          TEST_A_B="1"
          TEST_A_C="1"
        `,
      }));
      await g.finishLoad();

      // The root source should NOT be marked as env-specific
      const rootSource = g.rootDataSource!;
      expect(rootSource.isEnvSpecific).toBe(false);

      // Items should be included in defsForTypeGeneration
      expect(g.configSchema.TEST_A_B).toBeDefined();
      expect(g.configSchema.TEST_A_B.defsForTypeGeneration.length).toBeGreaterThan(0);
      expect(g.configSchema.TEST_A_C).toBeDefined();
      expect(g.configSchema.TEST_A_C.defsForTypeGeneration.length).toBeGreaterThan(0);
    });
  });

  describe('getTypeGenInfo - basic schema properties', () => {
    test('basic items get correct type info', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # a public item
          PUBLIC_ITEM=value # @public
          # a sensitive required item
          SECRET_ITEM=      # @sensitive @required
          # an optional item
          # @type=number
          OPT_NUM=          # @optional
        `,
      });

      const infos = await getTypeGenInfoMap(g);

      expect(infos.PUBLIC_ITEM.isSensitive).toBe(false);
      expect(infos.PUBLIC_ITEM.isRequired).toBe(true);
      expect(infos.PUBLIC_ITEM.description).toBe('a public item');
      expect(infos.PUBLIC_ITEM.dataType?.name).toBe('string');

      expect(infos.SECRET_ITEM.isSensitive).toBe(true);
      expect(infos.SECRET_ITEM.isRequired).toBe(true);
      expect(infos.SECRET_ITEM.description).toBe('a sensitive required item');

      expect(infos.OPT_NUM.isRequired).toBe(false);
      expect(infos.OPT_NUM.dataType?.name).toBe('number');
    });

    test('enum type gets correct TypeGenInfo', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @type=enum(dev, staging, prod)
          APP_ENV=dev
        `,
      });

      const infos = await getTypeGenInfoMap(g);
      expect(infos.APP_ENV.dataType?.name).toBe('enum');
    });

    test('boolean type gets correct TypeGenInfo', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @type=boolean
          DEBUG=true # @public
        `,
      });

      const infos = await getTypeGenInfoMap(g);
      expect(infos.DEBUG.dataType?.name).toBe('boolean');
      expect(infos.DEBUG.isSensitive).toBe(false);
    });

    test('@defaultRequired=false affects type gen info', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @defaultRequired=false
          # ---
          ITEM1=val
          ITEM2=    # @required
        `,
      });

      const infos = await getTypeGenInfoMap(g);
      expect(infos.ITEM1.isRequired).toBe(false);
      expect(infos.ITEM2.isRequired).toBe(true);
    });

    test('@defaultRequired=infer affects type gen info', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @defaultRequired=infer
          # ---
          HAS_VALUE=foo
          NO_VALUE=
        `,
      });

      const infos = await getTypeGenInfoMap(g);
      expect(infos.HAS_VALUE.isRequired).toBe(true);
      expect(infos.NO_VALUE.isRequired).toBe(false);
    });

    test('@defaultSensitive=false affects type gen info', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @defaultSensitive=false
          # ---
          ITEM1=val
          ITEM2=    # @sensitive
        `,
      });

      const infos = await getTypeGenInfoMap(g);
      expect(infos.ITEM1.isSensitive).toBe(false);
      expect(infos.ITEM2.isSensitive).toBe(true);
    });

    test('@defaultSensitive=inferFromPrefix affects type gen info', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @defaultSensitive=inferFromPrefix(PUBLIC_)
          # ---
          PUBLIC_FOO=
          SECRET_BAR=
        `,
      });

      const infos = await getTypeGenInfoMap(g);
      expect(infos.PUBLIC_FOO.isSensitive).toBe(false);
      expect(infos.SECRET_BAR.isSensitive).toBe(true);
    });

    test('dynamic @required marks isRequiredDynamic', async () => {
      const g = await loadGraph({
        envFile: outdent`
          STATIC_REQ=     # @required
          DYNAMIC_REQ=    # @required=if(yes)
        `,
      });

      const infos = await getTypeGenInfoMap(g);
      expect(infos.STATIC_REQ.isRequired).toBe(true);
      expect(infos.STATIC_REQ.isRequiredDynamic).toBe(false);
      expect(infos.DYNAMIC_REQ.isRequired).toBe(true);
      expect(infos.DYNAMIC_REQ.isRequiredDynamic).toBe(true);
    });
  });

  describe('getTypeGenInfo - env-specific sources are excluded', () => {
    test('env-specific file overrides do not affect type gen info', async () => {
      const g = await loadGraph({
        overrideValues: { APP_ENV: 'production' },
        files: {
          '.env.schema': outdent`
            # @currentEnv=$APP_ENV @defaultRequired=false
            # ---
            APP_ENV=dev
            ITEM1=schema-val    # @public
          `,
          '.env.production': outdent`
            ITEM1=prod-val      # @sensitive @required
          `,
        },
      });

      const infos = await getTypeGenInfoMap(g);

      // type gen should reflect schema, not production overrides
      expect(infos.ITEM1.isSensitive).toBe(false);
      expect(infos.ITEM1.isRequired).toBe(false);
    });

    test('description from env-specific file is excluded from type gen', async () => {
      const g = await loadGraph({
        overrideValues: { APP_ENV: 'production' },
        files: {
          '.env.schema': outdent`
            # @currentEnv=$APP_ENV
            # ---
            APP_ENV=dev
            # description from schema
            ITEM1=schema-val
          `,
          '.env.production': outdent`
            # prod-only description
            ITEM1=prod-val
          `,
        },
      });

      const infos = await getTypeGenInfoMap(g);
      expect(infos.ITEM1.description).toBe('description from schema');
    });

    test('description only in env-specific file is not included in type gen', async () => {
      const g = await loadGraph({
        overrideValues: { APP_ENV: 'production' },
        files: {
          '.env.schema': outdent`
            # @currentEnv=$APP_ENV
            # ---
            APP_ENV=dev
            ITEM1=schema-val
          `,
          '.env.production': outdent`
            # prod-only description
            ITEM1=prod-val
          `,
        },
      });

      const infos = await getTypeGenInfoMap(g);
      // ITEM1 has no description in .env.schema, and the one in .env.production is env-specific
      expect(infos.ITEM1.description).toBeUndefined();
    });

    test('conditionally disabled source overrides are excluded from type gen', async () => {
      const g = await loadGraph({
        overrideValues: { APP_ENV: 'dev' },
        files: {
          '.env.schema': outdent`
            # @currentEnv=$APP_ENV @defaultSensitive=false
            # @import(./.env.imported)
            # ---
            APP_ENV=dev
            ITEM1=schema-val
          `,
          '.env.imported': outdent`
            # @disable=forEnv(test)
            # ---
            ITEM1=imported-val  # @sensitive
          `,
        },
      });

      const infos = await getTypeGenInfoMap(g);

      // .env.imported has conditional @disable, so it's env-specific
      // type gen should use schema values only
      expect(infos.ITEM1.isSensitive).toBe(false);
    });

    test('conditionally imported source overrides are excluded from type gen', async () => {
      const g = await loadGraph({
        overrideValues: { APP_ENV: 'dev' },
        files: {
          '.env.schema': outdent`
            # @currentEnv=$APP_ENV @defaultRequired=false
            # @import(./.env.imported, enabled=forEnv("dev"))
            # ---
            APP_ENV=dev
            ITEM1=schema-val
          `,
          '.env.imported': outdent`
            ITEM1=imported-val    # @required
          `,
        },
      });

      const infos = await getTypeGenInfoMap(g);

      // .env.imported was conditionally imported, so it's env-specific
      expect(infos.ITEM1.isRequired).toBe(false);
    });

    test('statically imported source overrides ARE included in type gen', async () => {
      const g = await loadGraph({
        files: {
          '.env.schema': outdent`
            # @import(./.env.imported)
            # ---
            ITEM1=schema-val    # @optional
          `,
          '.env.imported': outdent`
            ITEM1=imported-val  # @required
          `,
        },
      });

      const infos = await getTypeGenInfoMap(g);

      // .env.imported was statically imported, not env-specific
      // .env.schema overrides with @optional (higher precedence)
      expect(infos.ITEM1.isRequired).toBe(false);

      // now test the other direction: import overrides because schema has no per-item decorator
      const g2 = await loadGraph({
        files: {
          '.env.schema': outdent`
            # @import(./.env.imported)
            # ---
            ITEM1=schema-val
          `,
          '.env.imported': outdent`
            ITEM1=imported-val  # @optional
          `,
        },
      });

      const infos2 = await getTypeGenInfoMap(g2);

      // .env.schema has no @required/@optional, .env.imported has @optional
      // the imported file's @optional is included since it's not env-specific
      expect(infos2.ITEM1.isRequired).toBe(false);
    });

    test('plain .env (a value source) does not affect type gen, nor does .env.local', async () => {
      const g = await loadGraph({
        files: {
          '.env.schema': outdent`
            # @defaultSensitive=false
            # ---
            ITEM1=schema-val
            ITEM2=schema-val
          `,
          '.env': outdent`
            ITEM1=env-val   # @sensitive
          `,
          '.env.local': outdent`
            ITEM2=local-val # @sensitive
          `,
        },
      });

      const infos = await getTypeGenInfoMap(g);

      // neither .env nor .env.local should change the schema-derived types
      expect(infos.ITEM1.isSensitive).toBe(false);
      expect(infos.ITEM2.isSensitive).toBe(false);
    });

    test('keys defined only in a plain .env are excluded from type gen (issue #796)', async () => {
      const g = await loadGraph({
        files: {
          '.env.schema': outdent`
            # @defaultSensitive=false @defaultRequired=optional
            # ---
            SOME_DECLARED_KEY=
          `,
          '.env': outdent`
            SOME_DECLARED_KEY="value"
            STALE_BOGUS_KEY="leakcheck"
          `,
        },
      });

      // declared in the schema → still included
      expect(g.configSchema.SOME_DECLARED_KEY.defsForTypeGeneration.length).toBeGreaterThan(0);
      // only present in the plain .env → must not leak into types
      expect(g.configSchema.STALE_BOGUS_KEY).toBeDefined();
      expect(g.configSchema.STALE_BOGUS_KEY.defsForTypeGeneration.length).toBe(0);

      const items: Array<TypeGenItemInfo> = [];
      for (const key of g.sortedConfigKeys) {
        if (g.configSchema[key].defsForTypeGeneration.length) {
          items.push(await g.configSchema[key].getTypeGenInfo());
        }
      }
      const src = await generateTsTypesSrc(resolveFieldTypes(items));
      expect(src).toContain('SOME_DECLARED_KEY');
      expect(src).not.toContain('STALE_BOGUS_KEY');

      // the excluded key is surfaced so the typegen command can nudge the user
      expect(g.getValueOnlyKeysExcludedFromTypes()).toEqual(['STALE_BOGUS_KEY']);
    });

    test('getValueOnlyKeysExcludedFromTypes ignores keys only in env-specific files', async () => {
      const g = await loadGraph({
        overrideValues: { APP_ENV: 'production' },
        files: {
          '.env.schema': outdent`
            # @currentEnv=$APP_ENV
            # ---
            APP_ENV=dev
            DECLARED=val
          `,
          '.env': outdent`
            ENV_ONLY=from-dot-env
          `,
          '.env.local': outdent`
            LOCAL_ONLY=from-local
          `,
          '.env.production': outdent`
            PROD_ONLY=from-prod
          `,
        },
      });

      // only the plain `.env` key is flagged — .env.local / .env.production are
      // excluded by design and should not be reported as drift
      expect(g.getValueOnlyKeysExcludedFromTypes()).toEqual(['ENV_ONLY']);
    });

    test('a lone .env (no .env.schema) is still the schema source for type gen', async () => {
      const g = await loadGraph({
        files: {
          '.env': outdent`
            # @defaultSensitive=false
            # ---
            ITEM1=val   # @required
          `,
        },
      });

      // with no .env.schema, the .env IS the schema source, so its keys belong in types
      expect(g.configSchema.ITEM1.defsForTypeGeneration.length).toBeGreaterThan(0);
      const infos = await getTypeGenInfoMap(g);
      expect(infos.ITEM1.isRequired).toBe(true);
    });

    test('items only defined in env-specific sources are excluded from type gen', async () => {
      const g = await loadGraph({
        overrideValues: { APP_ENV: 'production' },
        files: {
          '.env.schema': outdent`
            # @currentEnv=$APP_ENV
            # ---
            APP_ENV=dev
            SHARED_ITEM=val
          `,
          '.env.production': outdent`
            PROD_ONLY=some-val  # @public @optional
          `,
        },
      });

      // PROD_ONLY exists in the graph but has no non-env-specific defs
      expect(g.configSchema.PROD_ONLY).toBeDefined();
      const prodItem = g.configSchema.PROD_ONLY;
      expect(prodItem.defsForTypeGeneration.length).toBe(0);

      // getTypeGenInfoMap still works (it processes all items)
      // but generateTypes would skip PROD_ONLY
      const infos = await getTypeGenInfoMap(g);
      expect(infos.PROD_ONLY).toBeDefined(); // getTypeGenInfo still returns info

      // verify that generateTsTypesSrc output excludes PROD_ONLY
      // when we only pass items with non-env-specific defs
      const items: Array<TypeGenItemInfo> = [];
      for (const key of g.sortedConfigKeys) {
        if (g.configSchema[key].defsForTypeGeneration.length) {
          items.push(await g.configSchema[key].getTypeGenInfo());
        }
      }
      const src = await generateTsTypesSrc(resolveFieldTypes(items));

      expect(src).toContain('APP_ENV');
      expect(src).toContain('SHARED_ITEM');
      expect(src).not.toContain('PROD_ONLY');
    });
  });

  describe('generateTsTypesSrc output', () => {
    test('generates valid TS source from TypeGenItemInfo', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @defaultSensitive=false
          # ---
          # the database host
          # @type=string
          DB_HOST=localhost     # @required @public
          # database port
          # @type=port
          DB_PORT=5432          # @optional @public
          # secret key
          DB_PASSWORD=          # @required @sensitive
          # @type=boolean
          DEBUG=false           # @optional @public
          # @type=enum(dev, staging, prod)
          APP_ENV=dev           # @required @public
        `,
      });

      const items: Array<TypeGenItemInfo> = [];
      for (const key of g.sortedConfigKeys) {
        items.push(await g.configSchema[key].getTypeGenInfo());
      }
      const src = await generateTsTypesSrc(resolveFieldTypes(items));

      // verify the source contains expected type declarations
      expect(src).toContain('export type CoercedEnvSchema');
      expect(src).toContain('DB_HOST: string;');
      expect(src).toContain('DB_PORT?: number;');
      expect(src).toContain('DB_PASSWORD: string;');
      expect(src).toContain('DEBUG?: boolean;');
      expect(src).toContain('APP_ENV: "dev" | "staging" | "prod";');

      // verify module declarations
      expect(src).toContain("declare module 'varlock/env'");
      expect(src).toContain('TypedEnvSchema');
      expect(src).toContain('PublicTypedEnvSchema');
      expect(src).toContain('EnvSchemaAsStrings');

      // verify sensitive items are excluded from public schema (uses unique alias, not bare CoercedEnvSchema)
      expect(src).toMatch(/Pick<_CoercedEnvSchema_[0-9a-f]+, 'DB_HOST' \| 'DB_PORT' \| 'DEBUG' \| 'APP_ENV'>/);
    });

    test('type gen output is the same regardless of current environment', async () => {
      const schemaFile = outdent`
        # @currentEnv=$APP_ENV @defaultRequired=false @defaultSensitive=false
        # ---
        # @type=enum(dev, staging, prod)
        APP_ENV=dev
        # a public item
        ITEM1=default-val     # @public
        ITEM2=                # @sensitive
      `;

      // load as dev
      const gDev = await loadGraph({
        overrideValues: { APP_ENV: 'dev' },
        files: {
          '.env.schema': schemaFile,
          '.env.dev': outdent`
            ITEM1=dev-val       # @required @sensitive
            DEV_ONLY=x          # @required
          `,
        },
      });

      // load as production
      const gProd = await loadGraph({
        overrideValues: { APP_ENV: 'prod' },
        files: {
          '.env.schema': schemaFile,
          '.env.prod': outdent`
            ITEM1=prod-val      # @optional @public
            PROD_ONLY=y         # @optional
          `,
        },
      });

      // get type gen items from the schema-level keys present in both
      const sharedKeys = ['APP_ENV', 'ITEM1', 'ITEM2'];
      const devInfos: Record<string, TypeGenItemInfo> = {};
      const prodInfos: Record<string, TypeGenItemInfo> = {};
      for (const key of sharedKeys) {
        devInfos[key] = await gDev.configSchema[key].getTypeGenInfo();
        prodInfos[key] = await gProd.configSchema[key].getTypeGenInfo();
      }

      // the type gen info for shared keys should be identical
      for (const key of sharedKeys) {
        expect(devInfos[key].isRequired, `${key} isRequired`).toBe(prodInfos[key].isRequired);
        expect(devInfos[key].isRequiredDynamic, `${key} isRequiredDynamic`).toBe(prodInfos[key].isRequiredDynamic);
        expect(devInfos[key].isSensitive, `${key} isSensitive`).toBe(prodInfos[key].isSensitive);
        expect(devInfos[key].description, `${key} description`).toBe(prodInfos[key].description);
        expect(devInfos[key].dataType?.name, `${key} dataType`).toBe(prodInfos[key].dataType?.name);
      }
    });
  });

  describe('generateTsTypesSrc options', () => {
    test('defaults preserve global augmentation (strict)', async () => {
      const { items } = await loadFixtureFields();
      const src = await generateTsTypesSrc(resolveFieldTypes(items));
      expect(src).toContain("declare module 'varlock/env'");
      expect(src).toContain('declare global {');
      // strict = extends the strings alias with no index signature
      expect(src).toMatch(/interface ProcessEnv extends _EnvSchemaAsStrings_[0-9a-f]+ \{\}/);
      expect(src).toMatch(/interface ImportMetaEnv extends _EnvSchemaAsStrings_[0-9a-f]+ \{\}/);
      expect(src).not.toContain('[key: string]: string | undefined;');
      expect(src).not.toContain('import { ENV as _ENV }');
    });

    test('env=none omits the varlock/env augmentation and ENV export', async () => {
      const { items } = await loadFixtureFields();
      const src = await generateTsTypesSrc(resolveFieldTypes(items), { env: 'none' });
      expect(src).not.toContain("declare module 'varlock/env'");
      expect(src).not.toContain('export const ENV');
      // types are still emitted
      expect(src).toContain('export type CoercedEnvSchema');
    });

    test('processEnv=none / importMetaEnv=none omit those global blocks', async () => {
      const { items } = await loadFixtureFields();
      expect(await generateTsTypesSrc(resolveFieldTypes(items), { processEnv: 'none' })).not.toContain('namespace NodeJS');
      expect(await generateTsTypesSrc(resolveFieldTypes(items), { importMetaEnv: 'none' })).not.toContain('ImportMetaEnv');
      // both off => no declare global block at all
      const src = await generateTsTypesSrc(resolveFieldTypes(items), { processEnv: 'none', importMetaEnv: 'none' });
      expect(src).not.toContain('declare global {');
    });

    test('loose adds an index signature for extra keys', async () => {
      const { items } = await loadFixtureFields();
      const src = await generateTsTypesSrc(resolveFieldTypes(items), { processEnv: 'loose', importMetaEnv: 'loose' });
      expect(src).toContain('[key: string]: string | undefined;');
    });

    test('env=module emits a package-local importable ENV, no global augmentation', async () => {
      const { items } = await loadFixtureFields();
      const src = await generateTsTypesSrc(resolveFieldTypes(items), { env: 'module' });
      expect(src).toContain("import { ENV as _ENV } from 'varlock/env';");
      expect(src).toContain('export const ENV = _ENV as unknown as Readonly<CoercedEnvSchema>;');
      expect(src).toContain('export type PublicCoercedEnvSchema');
      expect(src).not.toContain("declare module 'varlock/env'");
    });

    test('rejects invalid option values', async () => {
      const { items } = await loadFixtureFields();
      await expect(generateTsTypesSrc(resolveFieldTypes(items), { env: 'bogus' as any })).rejects.toThrow('invalid `env` value');
      await expect(generateTsTypesSrc(resolveFieldTypes(items), { processEnv: 'nope' as any })).rejects.toThrow('invalid `processEnv` value');
    });

    test('@generateTsTypes env=module requires a non-.d.ts path', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @generateTsTypes(path=env.d.ts, env=module)
          # ---
          ITEM=val
        `,
      });
      await expect(g.runCodeGeneratorsIfNeeded()).rejects.toThrow('needs a `.ts` (or `.js`) output path');
    });
  });

  describe('code generator registry', () => {
    test('excludes @internal items from generated output', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @defaultSensitive=false
          # ---
          PUBLIC_ITEM=val       # @public
          # @internal
          SECRET_INTERNAL=val
        `,
      });
      const items = await collectTypeGenItems(g);
      const keys = items.map((i) => i.key);
      expect(keys).toContain('PUBLIC_ITEM');
      expect(keys).not.toContain('SECRET_INTERNAL');
    });

    test('@disableProcessEnvInjection defaults the process.env augmentation off (TS)', async () => {
      const currentDir = path.dirname(expect.getState().testPath!);
      const relPath = '.tmp-disable-injection.d.ts';
      const outputPath = path.join(currentDir, relPath);

      const g = await loadGraph({
        envFile: outdent`
          # @disableProcessEnvInjection
          # @generateTsTypes(path=${relPath})
          # ---
          PUBLIC_ITEM=val   # @public
        `,
      });
      try {
        await g.runCodeGeneratorsIfNeeded();
        const fs = await import('node:fs');
        const src = await fs.promises.readFile(outputPath, 'utf-8');
        // process.env isn't populated, so it shouldn't be typed...
        expect(src).not.toContain('namespace NodeJS');
        // ...but import.meta.env and the varlock/env ENV augmentation are unaffected
        expect(src).toContain('interface ImportMetaEnv');
        expect(src).toContain("declare module 'varlock/env'");
      } finally {
        await import('node:fs').then((fs) => fs.promises.rm(outputPath, { force: true }));
      }
    });

    test('explicit processEnv= overrides the @disableProcessEnvInjection default', async () => {
      const currentDir = path.dirname(expect.getState().testPath!);
      const relPath = '.tmp-disable-injection-override.d.ts';
      const outputPath = path.join(currentDir, relPath);

      const g = await loadGraph({
        envFile: outdent`
          # @disableProcessEnvInjection
          # @generateTsTypes(path=${relPath}, processEnv=strict)
          # ---
          PUBLIC_ITEM=val   # @public
        `,
      });
      try {
        await g.runCodeGeneratorsIfNeeded();
        const fs = await import('node:fs');
        const src = await fs.promises.readFile(outputPath, 'utf-8');
        expect(src).toContain('namespace NodeJS');
      } finally {
        await import('node:fs').then((fs) => fs.promises.rm(outputPath, { force: true }));
      }
    });

    test('runs a plugin-registered code generator via the same API', async () => {
      const currentDir = path.dirname(expect.getState().testPath!);
      vi.spyOn(process, 'cwd').mockReturnValue(currentDir);
      const relPath = '.tmp-fake-codegen.txt';
      const outputPath = path.join(currentDir, relPath);

      const g = new EnvGraph();
      const generate = vi.fn(() => 'FAKE GENERATED OUTPUT');
      g.registerCodeGenerator({ decoratorName: 'generateFakeThing', generate });

      await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
        overrideContents: outdent`
          # @generateFakeThing(path=${relPath})
          # ---
          ITEM=val
        `,
      }));
      await g.finishLoad();

      try {
        const count = await g.runCodeGeneratorsIfNeeded();
        expect(count).toBe(1);
        expect(generate).toHaveBeenCalledTimes(1);
        const fs = await import('node:fs');
        expect(await fs.promises.readFile(outputPath, 'utf-8')).toBe('FAKE GENERATED OUTPUT');
      } finally {
        await import('node:fs').then((fs) => fs.promises.rm(outputPath, { force: true }));
      }
    });
  });

  describe('JSDoc comment safety', () => {
    test('description containing "*/" does not prematurely close JSDoc comment', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @defaultSensitive=false
          # ---
          # use a glob like foo/*/bar to match paths
          GLOB_ITEM=val   # @public @required
        `,
      });

      const items: Array<TypeGenItemInfo> = [];
      for (const key of g.sortedConfigKeys) {
        items.push(await g.configSchema[key].getTypeGenInfo());
      }
      const src = await generateTsTypesSrc(resolveFieldTypes(items));

      // The item declaration must still be present (comment not prematurely closed)
      expect(src).toContain('GLOB_ITEM: string;');
      // The "* /" (escaped) form must appear instead of the raw "*/"
      expect(src).toContain('foo/* /bar');
      expect(src).not.toContain('foo/*/bar');
    });
  });

  describe('runs before value resolution', () => {
    test('getTypeGenInfo works without resolving env values', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @defaultSensitive=false
          # ---
          DB_HOST=localhost     # @required @public
          DB_PORT=5432          # @optional
          SECRET=               # @sensitive
        `,
      });

      // no resolveEnvValues() call — type gen should still work
      const infos = await getTypeGenInfoMap(g);

      expect(infos.DB_HOST.isRequired).toBe(true);
      expect(infos.DB_HOST.isSensitive).toBe(false);
      expect(infos.DB_PORT.isRequired).toBe(false);
      expect(infos.SECRET.isSensitive).toBe(true);
    });
  });

  describe('shared field type mapping', () => {
    test('maps coerced and raw string types consistently', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @defaultSensitive=false
          # ---
          STR=hello                 # @type=string @public
          NUM=1                     # @type=number @public
          INT_NUM=1                 # @type=number(isInt=true) @public
          PORT=8080                 # @type=port @public
          DUR=1h                    # @type=duration @public
          FLAG=true                 # @type=boolean @public
          # @type=enum(dev, staging, prod)
          APP_ENV=dev               # @public
          # @type=simple-object
          CONFIG={}                 # @public
        `,
      });

      const strField = resolveFieldType(await g.configSchema.STR.getTypeGenInfo());
      const numField = resolveFieldType(await g.configSchema.NUM.getTypeGenInfo());
      const intNumField = resolveFieldType(await g.configSchema.INT_NUM.getTypeGenInfo());
      const portField = resolveFieldType(await g.configSchema.PORT.getTypeGenInfo());
      const durField = resolveFieldType(await g.configSchema.DUR.getTypeGenInfo());
      const flagField = resolveFieldType(await g.configSchema.FLAG.getTypeGenInfo());
      const configField = resolveFieldType(await g.configSchema.CONFIG.getTypeGenInfo());
      const appEnvField = resolveFieldType(await g.configSchema.APP_ENV.getTypeGenInfo());

      expect(strField.coerced).toBe('string');
      // plain number is a general (float) number; ports and integer-constrained numbers are ints;
      // duration can be fractional, so it stays a general number
      expect(numField.coerced).toBe('number');
      expect(intNumField.coerced).toBe('int');
      expect(portField.coerced).toBe('int');
      expect(durField.coerced).toBe('number');
      expect(flagField.coerced).toBe('boolean');
      expect(configField.coerced).toBe('object');
      expect(appEnvField.coerced).toEqual({ enum: ['dev', 'staging', 'prod'] });
      expect(appEnvField.rawString).toEqual({ enum: ['dev', 'staging', 'prod'] });
      expect(flagField.rawString).toEqual({ boolean: true });
      expect(numField.rawString).toBe('string');
    });
  });

  describe('per-language code-gen decorators', () => {
    test('@generateTypes rejects non-ts langs, pointing at the per-language decorator', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @generateTypes(lang=py, path=env_types.py)
          # ---
          ITEM=val
        `,
      });

      await expect(g.runCodeGeneratorsIfNeeded()).rejects.toThrow(
        'For `py`, use @generatePythonEnv(path=...)',
      );
    });

    test('@generateTypes rejects unknown langs with a ts-only error', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @generateTypes(lang=ruby, path=env_types.rb)
          # ---
          ITEM=val
        `,
      });

      await expect(g.runCodeGeneratorsIfNeeded()).rejects.toThrow(
        '@generateTypes only supports `lang=ts`',
      );
    });

    test.each([
      ['generatePythonEnv', 'py', 'class CoercedEnvSchema(TypedDict):', 'DEBUG: NotRequired[bool]'],
      ['generateRustEnv', 'rs', 'pub struct Env {', 'pub debug: Option<bool>,'],
      ['generateGoEnv', 'go', 'type Env struct {', 'Debug *bool'],
      ['generatePhpEnv', 'php', 'final class Env', 'public readonly ?bool $DEBUG = null,'],
    ] as const)('@%s writes a %s types file with non-string fields', async (decorator, lang, marker, nonStringMarker) => {
      const currentDir = path.dirname(expect.getState().testPath!);
      const relPath = `.tmp-env-types.${lang}`;
      const outputPath = path.join(currentDir, relPath);

      const g = await loadGraph({
        envFile: outdent`
          # @${decorator}(path=${relPath})
          # @defaultSensitive=false
          # ---
          # @type=boolean
          DEBUG=false           # @optional @public
          # @type=port
          DB_PORT=5432          # @optional @public
        `,
      });

      try {
        const count = await g.runCodeGeneratorsIfNeeded();
        expect(count).toBe(1);
        const fs = await import('node:fs');
        const src = await fs.promises.readFile(outputPath, 'utf-8');
        expect(src).toContain(marker);
        expect(src).toContain(nonStringMarker);
      } finally {
        await import('node:fs').then((fs) => fs.promises.rm(outputPath, { force: true }));
      }
    });
  });
});
