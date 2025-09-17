import { expect } from 'vitest';
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
  loadingError?: boolean;
  expectValues?: Record<string, string | undefined | Constructor<Error>>;
  expectNotInSchema?: Array<string>,
  expectRequired?: Record<string, boolean | Constructor<Error>>;
  expectSensitive?: Record<string, boolean | Constructor<Error>>;
}) {
  return async () => {
    const g = new EnvGraph();
    if (spec.overrideValues) g.overrideValues = spec.overrideValues;
    if (spec.fallbackEnv) g.envFlagFallback = spec.fallbackEnv;
    if (spec.files) {
      g.setVirtualImports('/test', spec.files);
      const source = new DirectoryDataSource('/test');
      await g.setRootDataSource(source);
    } else if (spec.envFile) {
      const source = new DotEnvFileDataSource('.env.schema', { overrideContents: spec.envFile });
      await g.setRootDataSource(source);
    }
    await g.finishLoad();

    if (spec.loadingError) {
      expect(g.sortedDataSources.some((s) => s.loadingError)).toBeTruthy();
    } else {
      await g.resolveEnvValues();

      if (spec.expectValues) {
        for (const key of Object.keys(spec.expectValues)) {
          const item = g.configSchema[key];
          if (spec.expectValues[key] === SchemaError) {
            expect(item.schemaErrors.length).toBe(1);
            expect(item.schemaErrors[0]).toBeInstanceOf(spec.expectValues[key]);
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
            expect(item.schemaErrors.length).toBe(1);
            expect(item.schemaErrors[0]).toBeInstanceOf(spec.expectRequired[key]);
          } else {
            expect(item.isRequired, `expected ${key} to be ${spec.expectRequired[key] ? 'required' : 'NOT required'}`).toBe(spec.expectRequired[key]);
          }
        }
      }
      if (spec.expectSensitive) {
        for (const key of Object.keys(spec.expectSensitive)) {
          const item = g.configSchema[key];
          expect(item.isSensitive, `expected ${key} to be ${spec.expectSensitive[key] ? 'sensitive' : 'NOT sensitive'}`).toBe(spec.expectSensitive[key]);
        }
      }
    }
  };
}
