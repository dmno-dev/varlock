import _ from '@env-spec/utils/my-dash';
import { ConfigItem } from './config-item';
import { EnvGraphDataSource, ProcessEnvDataSource } from './data-source';

import {
  BaseResolvers, ResolverChildClass, StaticValueResolver,
} from './resolver';
import { BaseDataTypes, EnvGraphDataTypeFactory } from './data-types';
import { findGraphCycles, GraphAdjacencyList } from './graph-utils';
import { ResolutionError, SchemaError } from './errors';
import { generateTypes } from './type-generation';

export type SerializedEnvGraph = {
  sources: Array<{
    label: string;
    enabled: boolean;
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

  /** array of data sources */
  dataSources: Array<EnvGraphDataSource> = [];
  finalOverridesDataSource?: EnvGraphDataSource;

  /** config item key of env flag (toggles env-specific data sources enabled) */
  envFlagKey?: string;
  /** current value of the environment flag */
  envFlagValue?: string;

  configSchema: Record<string, ConfigItem> = {};

  addDataSource(dataSource: EnvGraphDataSource) {
    dataSource.graph = this;
    this.dataSources.push(dataSource);
  }

  get schemaDataSource() {
    const schemas = this.dataSources.filter((f) => f.type === 'schema');
    if (schemas.length > 1) throw new Error('Multiple schema data sources found');
    if (schemas.length === 0) return undefined;
    return schemas[0];
  }

  get sortedDataSources() {
    return _.sortBy(this.dataSources, (f) => (
      (10 * EnvGraphDataSource.DATA_SOURCE_TYPES[f.type].precedence)
      + (f.applyForEnv ? 1 : 0) // boost if for specific env
    ));
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
  }

  async finishLoad() {
    // first pass to figure out an envFlag and enable/disable env-specific sources
    const sortedDataSources = this.sortedDataSources;

    for (const source of sortedDataSources) {
      // TODO: not sure how we want to surface this exactly
      // we dont necessarily always want any loading error to fail the entire load
      // but for example if the main schema is failing and we dont know the envFlag
      // we don't know which env-specific sources to enable
      if (source.loadingError) {
        throw source.loadingError;
      }

      // check for @envFlag so we know which item should control loading env-specific files (eg: .env.production)
      if (source.decorators?.envFlag) {
        if (source.applyForEnv) {
          throw new Error(`@envFlag cannot be set from within an env-specific data source - ${source.label}`);
        } else if (this.envFlagKey) {
          throw new Error('only a single @envFlag setting is allowed');
        } else {
          const envFlagKey = source.decorators.envFlag.simplifiedValue;
          if (!_.isString(envFlagKey)) {
            throw new Error('@envFlag must be a string');
          } else {
            this.envFlagKey = envFlagKey;
          }
        }
      }

      // if this is an env-specific file, check if this file should be enabled or not
      // depending on the current value of the key specified by the `@envFlag` decorator
      if (source.applyForEnv) {
        // skip the file if the env doesn't match
        if (source.applyForEnv && this.envFlagValue !== source.applyForEnv) {
          source.disabled = true;
          continue;
        }
      }

      // check for @disable root decorator
      if (source.decorators?.disable && source.decorators.disable.simplifiedValue) {
        source.disabled = true;
        continue;
      }

      // TODO: here we'll probably want to allow registering more resolvers and data types via root decorators

      // create config items, or update their definitions if they already exist
      for (const itemKey in source.configItemDefs) {
        // if a source is marked as `ignoreNewDefs` (like the process.env source)
        // then only items already existing in another source will take effect
        if (source.ignoreNewDefs && !this.configSchema[itemKey]) continue;

        const itemDef = source.configItemDefs[itemKey];
        this.configSchema[itemKey] ??= new ConfigItem(this, itemKey);
        this.configSchema[itemKey].addDef(itemDef, source);
        // TODO: we probably want to track the definition back to the source
      }

      // deal with resolving the `@envFlag` if we are loading .env.schema
      if (source.type === 'schema' && this.envFlagKey) {
        // we'll throw some errors later if we were expecting an envFlag and one is not set
        // but in the case we are just loading the graph, but not resolving it (like `varlock init`)
        // then we want to allow this to proceed, and no files will be marked as disabled

        if (!this.configSchema[this.envFlagKey]) {
          throw new Error(`@envFlag key ${this.envFlagKey} not found in schema`);
        }

        // we do a limited early processing and resolution to get the env flag value
        // TODO: throw errors later if these already processed items are modified in subsequent env files
        const envFlagItem = this.configSchema[this.envFlagKey];
        await envFlagItem.process();
        // process and resolve any other items our env flag depends on
        for (const depKey of envFlagItem.valueResolver?.deps || []) {
          const depItem = this.configSchema[depKey];
          if (!depItem) {
            throw new Error(`envFlag resolver is using non-existant dependency: ${depKey}`);
          }
          await depItem.process();
          // we are not going to follow a chain of dependencies here
          if (depItem.valueResolver?.deps.length) {
            // TODO: probably should allow this, even though its not going to be common
            throw new Error('envFlag cannot follow a chain of dependencies');
          }
          await depItem.resolve();
        }
        await envFlagItem.resolve();
        if (!envFlagItem.isValid) {
          const err = new Error('resolved @envFlag value is not valid');
          err.cause = envFlagItem.errors[0];
          throw err;
        }

        if (envFlagItem.resolvedValue) {
          if (!_.isString(envFlagItem.resolvedValue)) {
            throw new Error('expected resolved @envFlag value to be a string');
          }
          this.envFlagValue = envFlagItem.resolvedValue;
        }
      }

      // TODO: here we would probably want to check for `@import` statements, and load those sources as well
    }

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

    const deferred = new Promise<void>((resolve, reject) => {
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
      sources: [],
      config: {},
      settings: {},
    };
    for (const source of this.sortedDataSources) {
      serializedGraph.sources.push({
        label: source.label,
        enabled: !source.disabled,
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
    const dec = this.schemaDataSource?.decorators?.[decoratorName];
    return dec?.simplifiedValue;
  }
}
