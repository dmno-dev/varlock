import { vi, expect } from 'vitest';
import outdent from 'outdent';
import path from 'node:path';

import {
  EnvGraph, DirectoryDataSource, DotEnvFileDataSource,
  resolveFieldTypes,
  type TypeGenItemInfo,
} from '../../index';
import type { EnvGraphDataTypeFactory } from '../../lib/data-types';

/** Schema fixture covering string, number, boolean, enum, and object types. */
export const NON_STRING_TYPE_FIXTURE = outdent`
  # @defaultSensitive=false
  # ---
  DB_HOST=localhost           # @type=string @required @public
  # @type=port
  DB_PORT=5432                # @optional @public
  # @type=boolean
  DEBUG=false                 # @optional @public
  # @type=enum(dev, staging, prod)
  APP_ENV=dev                 # @required @public
  # @type=simple-object
  CONFIG={}                   # @optional @public
  API_KEY=                    # @required @sensitive
`;

export async function loadGraph(spec: {
  envFile?: string;
  files?: Record<string, string>;
  overrideValues?: Record<string, string>;
  fallbackEnv?: string;
  /** extra data types to register, as a plugin's registerDataType would */
  dataTypes?: Array<EnvGraphDataTypeFactory>;
}) {
  const currentDir = path.dirname(expect.getState().testPath!);
  vi.spyOn(process, 'cwd').mockReturnValue(currentDir);

  const g = new EnvGraph();
  for (const dataType of spec.dataTypes ?? []) g.registerDataType(dataType);
  if (spec.overrideValues) g.overrideValues = spec.overrideValues;
  if (spec.fallbackEnv) g.envFlagFallback = spec.fallbackEnv;

  if (spec.files) {
    g.setVirtualImports(currentDir, spec.files);
    await g.setRootDataSource(new DirectoryDataSource(currentDir));
  } else if (spec.envFile) {
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: spec.envFile }));
  }
  await g.finishLoad();
  return g;
}

export async function getTypeGenInfoMap(g: EnvGraph) {
  const infos: Record<string, TypeGenItemInfo> = {};
  for (const key of g.sortedConfigKeys) {
    infos[key] = await g.configSchema[key].getTypeGenInfo();
  }
  return infos;
}

/** Schema fixture covering composite (array/object) types across required/optional. */
export const COMPOSITE_TYPE_FIXTURE = outdent`
  # @defaultSensitive=false @defaultRequired=false
  # ---
  # @type=array(string)
  HOSTS=[a.com, b.com]        # @required @public
  # @type=array(number)
  SCORES=[1, 2]
  # @type=array(enum(dev, prod))
  MODES=[dev]
  # @type=record(number)
  LIMITS={a=1}
`;

export async function loadFixtureFields(
  envFile = NON_STRING_TYPE_FIXTURE,
  opts?: { dataTypes?: Array<EnvGraphDataTypeFactory> },
) {
  const g = await loadGraph({ envFile, dataTypes: opts?.dataTypes });
  const items: Array<TypeGenItemInfo> = [];
  for (const key of g.sortedConfigKeys) {
    items.push(await g.configSchema[key].getTypeGenInfo());
  }
  return { g, items, fields: resolveFieldTypes(items) };
}
