import { expect, vi } from 'vitest';
import path from 'node:path';
import { EnvGraph, DotEnvFileDataSource } from '../env-graph/index';
import type { Constructor } from '@env-spec/utils/type-utils';

type ErrorClass = Constructor<Error>;

export type PluginTestSpec = {
  /** inline .env.schema contents */
  schema: string;
  /**
   * Values to inject (simulates process.env / override values).
   * These override any values in the schema for the matching keys.
   */
  injectValues?: Record<string, string>;
  /**
   * directory to resolve relative paths from (plugin path, fixture paths, etc.)
   * defaults to the directory of the calling test file
   */
  resolveDir?: string;
  /** expected resolved values */
  expectValues?: Record<string, string | number | boolean | undefined | ErrorClass>;
  /** expect specific items to be sensitive */
  expectSensitive?: Record<string, boolean>;
  /** expect an error during schema loading / plugin init (before resolution) */
  expectSchemaError?: boolean;
  /** print debug info on failure */
  debug?: boolean;
};

/**
 * Create a test function that loads an env schema with a plugin and verifies resolved values.
 *
 * The schema string should include the `@plugin(...)` and `@init*()` decorators.
 * Relative paths in the schema (plugin path, file paths) resolve relative to
 * `resolveDir` (defaults to the test file's directory).
 *
 * @example
 * ```ts
 * test('reads password from kdbx', pluginTest({
 *   schema: outdent`
 *     # @plugin(../../)
 *     # @initKeePass(dbPath="./fixtures/test.kdbx", password=$KP_PW)
 *     # ---
 *     KP_PW=test
 *     SECRET=kp("myEntry")
 *   `,
 *   expectValues: { SECRET: 'expected-password-value' },
 * }));
 * ```
 */
export function pluginTest(spec: PluginTestSpec) {
  return async () => {
    const resolveDir = spec.resolveDir || path.dirname(expect.getState().testPath!);
    vi.spyOn(process, 'cwd').mockReturnValue(resolveDir);

    const g = new EnvGraph();

    // inject override values (e.g., passwords needed by the plugin)
    if (spec.injectValues) {
      g.overrideValues = { ...g.overrideValues, ...spec.injectValues };
    }

    // create a data source with the schema contents
    // use a full path so plugin relative paths resolve correctly
    const schemaPath = path.join(resolveDir, '.env.schema');
    const source = new DotEnvFileDataSource(schemaPath, {
      overrideContents: spec.schema,
    });
    await g.setRootDataSource(source);
    await g.finishLoad();

    if (spec.debug) {
      /* eslint-disable no-console */
      for (const p of g.plugins) {
        if (p.loadingError) console.log('Plugin loading error:', p.loadingError);
      }
      for (const ds of g.sortedDataSources) {
        if (ds.loadingError) console.log('Data source loading error:', ds.loadingError);
        for (const err of ds.schemaErrors) {
          console.log('Schema error:', err);
        }
      }
      /* eslint-enable no-console */
    }

    if (spec.expectSchemaError) {
      const hasError = g.plugins.some((p) => p.loadingError)
        || g.sortedDataSources.some((s) => s.schemaErrors.length > 0 || s.loadingError);
      expect(hasError, 'Expected a schema error, but none found').toBeTruthy();
      return; // don't resolve if we expected schema errors
    }

    // verify no unexpected loading errors
    for (const p of g.plugins) {
      expect(p.loadingError, `Plugin loading error: ${p.loadingError?.message}`).toBeFalsy();
    }
    for (const ds of g.sortedDataSources) {
      expect(ds.loadingError, `Data source loading error: ${ds.loadingError?.message}`).toBeFalsy();
      expect(ds.schemaErrors.length, `Schema errors: ${ds.schemaErrors.map((e) => e.message).join(', ')}`).toBe(0);
    }

    await g.resolveEnvValues();

    if (spec.expectValues) {
      for (const [key, expected] of Object.entries(spec.expectValues)) {
        const item = g.configSchema[key];
        expect(item, `Expected item "${key}" to exist in schema`).toBeDefined();

        if (typeof expected === 'function' && (expected === Error || expected.prototype instanceof Error)) {
          expect(item.errors.length, `Expected errors on "${key}"`).toBeGreaterThan(0);
          if (expected !== Error) {
            expect(item.errors[0]).toBeInstanceOf(expected);
          }
        } else {
          if (item.errors.length > 0) {
            expect.fail(`Unexpected errors on "${key}": ${item.errors.map((e: Error) => e.message).join(', ')}`);
          }
          expect(item.resolvedValue, `Value of "${key}"`).toEqual(expected);
        }
      }
    }

    if (spec.expectSensitive) {
      for (const [key, expected] of Object.entries(spec.expectSensitive)) {
        const item = g.configSchema[key];
        expect(item, `Expected item "${key}" to exist in schema`).toBeDefined();
        expect(item.isSensitive, `Expected "${key}" sensitive=${expected}`).toBe(expected);
      }
    }

    return g;
  };
}
