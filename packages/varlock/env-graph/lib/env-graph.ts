import _ from '@env-spec/utils/my-dash';
import path from 'node:path';
import { ConfigItem } from './config-item';
import { EnvGraphDataSource, FileBasedDataSource } from './data-source';

import { BaseResolvers, type ResolverChildClass } from './resolver';
import { BaseDataTypes, type EnvGraphDataTypeFactory } from './data-types';
import { findGraphCycles, type GraphAdjacencyList } from './graph-utils';
import { ResolutionError, SchemaError } from './errors';
import { generateTypes } from './type-generation';
import type { ParsedEnvSpecDecorator } from '@env-spec/parser';

const processExists = !!globalThis.process;
const originalProcessEnv = { ...processExists && process.env };

export type SerializedEnvGraph = {
  basePath?: string;
  sources: Array<{
    label: string;
    enabled: boolean;
    path?: string;
  }>,
  settings: {
    redactLogs?: boolean;
    preventLeaks?: boolean;
  },
  config: Record<string, {
    value: any;
    isSensitive: boolean;
  }>;
};

/** container of the overall graph and current resolution attempt / values */
export class EnvGraph {
  // TODO: not sure if this should be the graph of _everything_ in a workspace/project
  // or just the files that are relevant to the current resolution attempt
  // (which would mean it's always through the lens of the current directory/package)

  basePath?: string;

  /** root data source (.env.schema) */
  rootDataSource?: EnvGraphDataSource;

  /** place to store process.env overrides */
  overrideValues: Record<string, string | undefined> = {};

  /** config item key of env flag (toggles env-specific data sources enabled) */
  envFlagKey?: string;
  /** graph-level fallback value for environment flag */
  envFlagFallback?: string;

  configSchema: Record<string, ConfigItem> = {};

  /** virtual imports for testing */
  virtualImports?: Record<string, string>;
  setVirtualImports(basePath: string, files: Record<string, string>) {
    this.virtualImports = {};
    for (const [fileName, fileContents] of Object.entries(files)) {
      this.virtualImports[path.join(basePath, fileName)] = fileContents;
    }
  }


  get sortedDataSources() {
    function getSourceAndChildren(s: EnvGraphDataSource): Array<EnvGraphDataSource> {
      return [s, ...s.children ? s.children.flatMap(getSourceAndChildren) : []];
    }
    return this.rootDataSource ? getSourceAndChildren(this.rootDataSource) : [];
  }

  registeredResolverFunctions: Record<string, ResolverChildClass> = {};
  registerResolver(resolverClass: ResolverChildClass) {
    // TODO: fix ts any
    const fnName = (resolverClass as any).fnName;
    if (fnName in this.registeredResolverFunctions) {
      // TODO: do we want to allow the user to override?
      throw new Error(`Resolver ${fnName} already registered`);
    }
    this.registeredResolverFunctions[fnName] = resolverClass;
  }

  dataTypesRegistry: Record<string, EnvGraphDataTypeFactory> = {};
  registerDataType(factory: EnvGraphDataTypeFactory) {
    this.dataTypesRegistry[factory.dataTypeName] = factory;
  }

  constructor() {
    // register base data types (string, number, boolean, etc)
    for (const dataType of _.values(BaseDataTypes)) {
      this.registerDataType(dataType);
    }
    // register base resolvers (concat, ref, etc)
    for (const resolverClass of BaseResolvers) {
      this.registerResolver(resolverClass);
    }
    this.overrideValues = originalProcessEnv;
  }

  async setRootDataSource(source: EnvGraphDataSource) {
    if (this.rootDataSource) throw new Error('root data source already set');
    this.rootDataSource = source;
    source.graph = this;
    await source.finishInit();
  }

  async finishLoad() {
    // process items - this adds dataTypes, checks resolver args, and dependencies
    for (const itemKey in this.configSchema) {
      const item = this.configSchema[itemKey];
      await item.process();
    }

    // check for cycles in resolver dependencies
    const cycles = findGraphCycles(this.graphAdjacencyList);
    for (const cycleItemKeys of cycles) {
      for (const itemKey of cycleItemKeys) {
        const item = this.configSchema[itemKey];
        item.schemaErrors.push(
          new SchemaError(
            cycleItemKeys.length === 1
              ? 'Item cannot have dependency on itself'
              : `Dependency cycle detected: (${cycleItemKeys.join(', ')})`,
          ),
        );
      }
    }
  }

  get graphAdjacencyList() {
    const adjList: GraphAdjacencyList = {};
    for (const itemKey in this.configSchema) {
      const item = this.configSchema[itemKey];
      adjList[itemKey] = item.valueResolver?.deps || [];
    }
    return adjList;
  }

  async resolveEnvValues(): Promise<void> {
    if (_.keys(this.configSchema).length === 0) return;

    const adjList = this.graphAdjacencyList;
    const reverseAdjList: Record<string, Array<string>> = {};
    for (const itemKey in adjList) {
      const itemDeps = adjList[itemKey];
      for (const dep of itemDeps) {
        reverseAdjList[dep] ??= [];
        reverseAdjList[dep].push(itemKey);
      }
    }

    // obj tracking items left to resolve and if we've started resolving them
    // - true = in progress
    // - false = not yet started
    // - items are removed when completed
    const itemsToResolveStatus = _.mapValues(this.configSchema, () => false);

    // code is a bit awkward here because we are resolving items in parallel
    // and need to continue resolving dependent items as each finishes

    const deferred = new Promise<void>((resolve, _reject) => {
      const markItemCompleted = (itemKey: string) => {
        delete itemsToResolveStatus[itemKey];
        if (reverseAdjList[itemKey]) {
          // eslint-disable-next-line no-use-before-define
          reverseAdjList[itemKey].forEach(resolveItem);
        }
        if (_.keys(itemsToResolveStatus).length === 0) resolve();
      };

      const resolveItem = async (itemKey: string) => {
        // due to cycles and how we attempt items when each of their deps finishes
        // we may arrive hit this multiple times for an item, so we need to bail in some cases

        // true means items is already in progress, not present means it has been resolved
        if (itemsToResolveStatus[itemKey] !== false) return;

        const item = this.configSchema[itemKey];

        // if item is already invalid, we are done
        if (item.errors.length) {
          markItemCompleted(itemKey);
          return;
        }

        for (const depKey of adjList[itemKey]) {
          const depItem = this.configSchema[depKey];
          // if a dependency is invalid, we mark the item as invalid too
          if (depItem.validationState === 'error') {
            item.resolutionError = new ResolutionError(`Dependency ${depKey} is invalid`);
            markItemCompleted(itemKey);
            return;
          // if any dependency is not yet resolved, we need to wait for it
          } else if (depKey in itemsToResolveStatus) {
            return;
          }
        }

        // mark item as beginning to actually resolve
        itemsToResolveStatus[itemKey] = true; // true means in progress
        await item.resolve();
        markItemCompleted(itemKey);
      };

      for (const itemKey in this.configSchema) {
        resolveItem(itemKey);
      }
    });
    return deferred;
  }

  getResolvedEnvObject() {
    const envObject: Record<string, any> = {};
    for (const itemKey in this.configSchema) {
      const item = this.configSchema[itemKey];
      envObject[itemKey] = item.resolvedValue;
    }
    return envObject;
  }

  getSerializedGraph(): SerializedEnvGraph {
    const serializedGraph: SerializedEnvGraph = {
      basePath: this.basePath,
      sources: [],
      config: {},
      settings: {},
    };
    for (const source of this.sortedDataSources) {
      serializedGraph.sources.push({
        label: source.label,
        enabled: !source.disabled,
        path: source instanceof FileBasedDataSource ? path.relative(this.basePath ?? '', source.fullPath) : undefined,
      });
    }
    for (const itemKey in this.configSchema) {
      const item = this.configSchema[itemKey];
      serializedGraph.config[itemKey] = {
        value: item.resolvedValue,
        isSensitive: item.isSensitive,
      };
    }

    // expose a few root level settings
    serializedGraph.settings.redactLogs = this.getRootDecoratorValue('redactLogs') ?? true;
    serializedGraph.settings.preventLeaks = this.getRootDecoratorValue('preventLeaks') ?? true;

    return serializedGraph;
  }

  get isInvalid() {
    return _.some(_.values(this.configSchema), (i) => !i.isValid);
  }

  async generateTypes(lang: string, outputPath: string) {
    await generateTypes(this, lang, outputPath);
  }

  getRootDecoratorValue(decoratorName: string) {
    // currently this is just used above, but may want to rework
    // to track values once as we process sources
    const sources = Array.from(this.sortedDataSources).reverse();
    for (const s of sources) {
      if (s.disabled) continue;
      // we skip root decorators if the file was being _partially_ imported
      if (s.importKeys) continue;
      const decs = s.getRootDecorators(decoratorName);
      if (decs.length) return decs[0].simplifiedValue;
    }
    return undefined;
  }
  getRootDecorators(decoratorName: string) {
    const sources = Array.from(this.sortedDataSources).reverse();
    const combinedDecsWithSources: Array<[EnvGraphDataSource, Array<ParsedEnvSpecDecorator>]> = [];
    for (const source of sources) {
      if (source.disabled) continue;
      // we skip root decorators if the file was being _partially_ imported
      if (source.importKeys) continue;
      const decs = source.getRootDecorators(decoratorName);
      combinedDecsWithSources.push([source, decs]);
    }
    return combinedDecsWithSources;
  }
}
