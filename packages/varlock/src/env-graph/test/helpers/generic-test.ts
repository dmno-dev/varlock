import { expect, vi } from 'vitest';
import path from 'node:path';
import {
  EnvGraph, SchemaError, DirectoryDataSource, DotEnvFileDataSource, MultiplePathsContainerDataSource,
  type VarlockError,
} from '../../index';
import type { Constructor } from '@env-spec/utils/type-utils';

/**
 * generic test helper to load files and check everything
 * ideally this can be used for 90% of tests
 */
export function envFilesTest(spec: {
  envFile?: string;
  files?: Record<string, string>;
  /**
   * When provided, overrides the default single-directory loading.
   * Can be a single relative path string or an array of relative paths.
   * Each path is resolved relative to the current test file's directory.
   * Use a trailing `/` (or `path.sep`) to indicate a directory.
   * The `files` map should contain entries whose keys start with the
   * corresponding path prefix (e.g. `'path1/.env.schema'`).
   */
  loadPaths?: string | Array<string>;
  fallbackEnv?: string,
  overrideValues?: Record<string, string>;
  /** Override process.env for builtin var detection (avoids modifying real process.env) */
  processEnv?: Record<string, string | undefined>;
  debug?: boolean;
  /**
   * Expect an error before resolution.
   * - `true` — any non-warning error on a data source or plugin
   * - A VarlockError subclass — additionally asserts the error is an instance of that class
   */
  expectError?: boolean | Constructor<VarlockError>;
  /**
   * Expect a root decorator execution error (happens during resolution).
   */
  resolutionError?: boolean;
  expectValues?: Record<string, string | number | boolean | undefined | Constructor<Error>>;
  expectNotInSchema?: Array<string>,
  expectRequired?: Record<string, boolean | Constructor<Error>>;
  expectRequiredIsDynamic?: Record<string, boolean>;
  expectSensitive?: Record<string, boolean | Constructor<Error>>;
  expectSerializedMatches?: any;
  /**
   * Simulate calling getTypeGenInfo() on all items before resolveEnvValues(),
   * which mirrors what the CLI does (generateTypesIfNeeded before resolveEnvValues).
   * This is used to reproduce bugs where early type-gen resolution corrupts cached state.
   */
  runTypeGeneration?: boolean;
}) {
  return async () => {
    // mock process.cwd to be the current test file
    const currentDir = path.dirname(expect.getState().testPath!);
    vi.spyOn(process, 'cwd').mockReturnValue(currentDir);

    const g = new EnvGraph();
    if (spec.overrideValues) g.overrideValues = spec.overrideValues;
    if (spec.fallbackEnv) g.envFlagFallback = spec.fallbackEnv;
    if (spec.processEnv) g.processEnvOverride = spec.processEnv;
    if (spec.files) {
      g.setVirtualImports(currentDir, spec.files);

      if (spec.loadPaths) {
        // Multi-path or explicit single-path loading
        const rawPaths = Array.isArray(spec.loadPaths) ? spec.loadPaths : [spec.loadPaths];
        // Preserve trailing slash (path.resolve strips it, but it's used to detect directories)
        const resolvedPaths = rawPaths.map((p) => {
          const hasTrailingSlash = p.endsWith('/') || p.endsWith(path.sep);
          const resolved = path.resolve(currentDir, p);
          return hasTrailingSlash ? `${resolved}${path.sep}` : resolved;
        });
        if (resolvedPaths.length === 1) {
          const rp = resolvedPaths[0];
          const isDir = rp.endsWith('/') || rp.endsWith(path.sep);
          const source = isDir ? new DirectoryDataSource(rp) : new DotEnvFileDataSource(rp);
          await g.setRootDataSource(source);
        } else {
          await g.setRootDataSource(new MultiplePathsContainerDataSource(resolvedPaths));
        }
      } else {
        const source = new DirectoryDataSource(currentDir);
        await g.setRootDataSource(source);
      }
    } else if (spec.envFile) {
      const source = new DotEnvFileDataSource('.env.schema', { overrideContents: spec.envFile });
      await g.setRootDataSource(source);
    }
    await g.finishLoad();

    if (spec.debug) {
      /* eslint-disable no-console */
      for (const ds of g.sortedDataSources) {
        console.log('Data Source:', ds.label);
        if (ds.loadingError) {
          console.log('  Loading Error:', ds.loadingError);
        }
        if (ds.schemaErrors.length) {
          console.log('  Schema Errors:');
          for (const err of ds.schemaErrors) {
            console.log('   -', err);
          }
        }
      }
    }

    if (spec.expectError) {
      const allErrors = [
        ...g.sortedDataSources.flatMap((s) => s.errors.filter((e) => !e.isWarning)),
        ...g.plugins.filter((p) => p.loadingError).map((p) => p.loadingError!),
      ];
      expect(allErrors.length, 'Expected an error, but didnt find one').toBeGreaterThan(0);
      if (typeof spec.expectError === 'function') {
        const ErrorClass = spec.expectError;
        expect(
          allErrors.some((e) => e instanceof ErrorClass),
          `Expected a ${ErrorClass.name}, but got: ${allErrors.map((e) => e.constructor.name).join(', ')}`,
        ).toBe(true);
      }
    }

    if (spec.expectError) {
      // don't proceed to resolution checks
    } else if (spec.resolutionError) {
      await g.resolveEnvValues();
      expect(
        g.sortedDataSources.some((s) => s.resolutionErrors.length > 0),
        'Expected a resolution error, but didnt find one',
      ).toBeTruthy();
    } else {
      // check for source-level errors (loading, schema on the source itself)
      // item-level schema errors are fine — they don't prevent resolution
      const firstSourceError = g.sortedDataSources.flatMap((s) => s._errors).find((e) => !e.isWarning);
      expect(
        firstSourceError,
        `Expected no errors, but got - ${firstSourceError?.message}`,
      ).toBeFalsy();

      // Simulate calling getTypeGenInfo() before resolveEnvValues(), as the CLI does
      if (spec.runTypeGeneration) {
        for (const key of Object.keys(g.configSchema)) {
          await g.configSchema[key].getTypeGenInfo();
        }
      }

      await g.resolveEnvValues();

      if (spec.expectValues) {
        for (const key of Object.keys(spec.expectValues)) {
          const item = g.configSchema[key];
          if (spec.expectValues[key] === SchemaError) {
            expect(item.errors.length).toBeGreaterThan(0);
            expect(item.errors[0]).toBeInstanceOf(spec.expectValues[key]);
          } else {
            expect(item.resolvedValue, `${key} value did not match`).toEqual(spec.expectValues[key]);
          }
        }
      }
      if (spec.expectNotInSchema) {
        for (const key of spec.expectNotInSchema) {
          expect(Object.keys(g.configSchema)).not.toContain(key);
        }
      }
      if (spec.expectRequired) {
        for (const key of Object.keys(spec.expectRequired)) {
          const item = g.configSchema[key];
          if (spec.expectRequired[key] === SchemaError) {
            expect(item.errors.length, 'Expected a schema error').toBeGreaterThan(0);
            expect(item.errors[0]).toBeInstanceOf(spec.expectRequired[key]);
          } else {
            expect(item.isRequired, `expected ${key} to be ${spec.expectRequired[key] ? 'required' : 'NOT required'}`).toBe(spec.expectRequired[key]);
          }
        }
      }
      if (spec.expectRequiredIsDynamic) {
        for (const key of Object.keys(spec.expectRequiredIsDynamic)) {
          const item = g.configSchema[key];
          expect(item.isRequiredDynamic, `expected ${key} to be ${spec.expectRequiredIsDynamic[key] ? 'dynamic' : 'NOT dynamic'}`).toBe(spec.expectRequiredIsDynamic[key]);
        }
      }
      if (spec.expectSensitive) {
        for (const key of Object.keys(spec.expectSensitive)) {
          const item = g.configSchema[key];
          expect(item.isSensitive, `expected ${key} to be ${spec.expectSensitive[key] ? 'sensitive' : 'NOT sensitive'}`).toBe(spec.expectSensitive[key]);
        }
      }
    }

    if (spec.expectSerializedMatches) {
      const serialized = g.getSerializedGraph();
      expect(serialized).toMatchObject(spec.expectSerializedMatches);
    }
  };
}
