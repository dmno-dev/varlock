import { expect, vi } from 'vitest';
import path from 'node:path';
import {
  EnvGraph, SchemaError, DirectoryDataSource, DotEnvFileDataSource,
} from '../../index';
import type { Constructor } from '@env-spec/utils/type-utils';

/**
 * generic test helper to load files and check everything
 * ideally this can be used for 90% of tests
 */
export function envFilesTest(spec: {
  envFile?: string;
  files?: Record<string, string>;
  fallbackEnv?: string,
  overrideValues?: Record<string, string>;
  debug?: boolean;
  earlyError?: boolean;
  loadingError?: boolean;
  expectValues?: Record<string, string | number | boolean | undefined | Constructor<Error>>;
  expectNotInSchema?: Array<string>,
  expectRequired?: Record<string, boolean | Constructor<Error>>;
  expectRequiredIsDynamic?: Record<string, boolean>;
  expectSensitive?: Record<string, boolean | Constructor<Error>>;
  expectSerializedMatches?: any;
}) {
  return async () => {
    // mock process.cwd to be the current test file
    const currentDir = path.dirname(expect.getState().testPath!);
    vi.spyOn(process, 'cwd').mockReturnValue(currentDir);

    const g = new EnvGraph();
    if (spec.overrideValues) g.overrideValues = spec.overrideValues;
    if (spec.fallbackEnv) g.envFlagFallback = spec.fallbackEnv;
    if (spec.files) {
      g.setVirtualImports(currentDir, spec.files);
      const source = new DirectoryDataSource(currentDir);
      await g.setRootDataSource(source);
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

    // TODO - improve terminology around errors
    // and how we distinguish between errors in different phases
    if (spec.earlyError) {
      expect(
        g.plugins.some((p) => p.loadingError)
        || g.sortedDataSources.some((s) => s.schemaErrors.length > 0 || s.loadingError),
        'Expected an early error, but didnt find one',
      ).toBeTruthy();
    }

    if (spec.loadingError) {
      expect(
        g.sortedDataSources.some((s) => s.loadingError),
        'Expected a loading error, but didnt find one',
      ).toBeTruthy();
    } else {
      const firstLoadingError = g.sortedDataSources.find((s) => s.loadingError)?.loadingError;
      expect(
        firstLoadingError,
        `Expected no loading errors, but got - ${firstLoadingError?.message}`,
      ).toBeFalsy();

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
