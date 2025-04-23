import { ConfigItem } from './config-item';
import { EnvGraphDataSource } from './data-source';
import _ from '../utils/my-dash';
import { ResolverDefinition } from './resolver';
import { BaseDataTypes, EnvGraphDataTypeFactory } from './data-types';

/** container of the overall graph and current resolution attempt / values */
export class EnvGraph {
  // TODO: not sure if this should be the graph of _everything_ in a workspace/project
  // or just the files that are relevant to the current resolution attempt
  // (which would mean it's always through the lens of the current directory/package)

  basePath?: string;

  /** array of data sources */
  dataSources: Array<EnvGraphDataSource> = [];

  /** config item key of env flag (toggles env-specific data sources enabled) */
  envFlagKey?: string;
  /** current value of the environment flag */
  envFlagValue?: string;

  configSchema: Record<string, ConfigItem> = {};

  addDataSource(dataSource: EnvGraphDataSource) {
    this.dataSources.push(dataSource);
  }

  get sortedDataSources() {
    return _.sortBy(this.dataSources, (f) => (
      (10 * EnvGraphDataSource.DATA_SOURCE_TYPES[f.type].precedence)
      + (f.applyForEnv ? 1 : 0) // boost if for specific env
    ));
  }

  registeredResolverFunctions: Record<string, ResolverDefinition> = {};
  registerResolver(name: string, definition: ResolverDefinition) {
    this.registeredResolverFunctions[name] = definition;
  }

  dataTypesRegistry: Record<string, EnvGraphDataTypeFactory> = {};
  registerDataType(factory: EnvGraphDataTypeFactory) {
    this.dataTypesRegistry[factory.dataTypeName] = factory;
  }

  constructor() {
    for (const dataType of _.values(BaseDataTypes)) {
      this.registerDataType(dataType);
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
        throw new Error(`Error loading ${source.label}: ${source.loadingError.message}`);
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
        // if this is the first env-specific file, we check and set the value of the env flag
        if (!this.envFlagValue) {
          if (!this.envFlagKey) {
            throw new Error('You must specify the @envFlag in your schema to load any env-specific files');
          }
          if (!this.configSchema[this.envFlagKey]) {
            throw new Error(`@envFlag key ${this.envFlagKey} not found in schema`);
          }
          // process.env takes precedence but files can also set the value
          if (process.env[this.envFlagKey]) {
            this.envFlagValue = process.env[this.envFlagKey];
          } else {
            const envFlagResolver = this.configSchema[this.envFlagKey].valueResolver;
            if (envFlagResolver?.type === 'static') {
              const staticEnvFlagValue = envFlagResolver.value;
              if (!_.isString(staticEnvFlagValue)) throw new Error('expected a static string value for envFlag');
              this.envFlagValue = staticEnvFlagValue;
            } else {
              throw new Error('envFlag value must be a static string');
            }
          }
        }

        // skip the file if the env doesn't match
        if (source.applyForEnv && this.envFlagValue !== source.applyForEnv) {
          source.disabled = true;
          continue;
        }
      }

      // create config items, or update their definitions if they already exist
      for (const itemKey in source.configItemDefs) {
        // if a source is marekd as `ignoreNewDefs` (like the process.env source)
        // then only items already existing in another source will take effect
        if (source.ignoreNewDefs && !this.configSchema[itemKey]) continue;

        const itemDef = source.configItemDefs[itemKey];
        this.configSchema[itemKey] ??= new ConfigItem(this, itemKey);
        this.configSchema[itemKey].addDef(itemDef, source);
        // TODO: we probably want to track the definition back to the source
      }

      // TODO: here we would probably want to check for `@import` statements, and load those sources as well
    }


    for (const itemKey in this.configSchema) {
      const item = this.configSchema[itemKey];
      await item.process();
      if (item.schemaErrors.length > 0) {
        console.log(itemKey, item.schemaErrors.map((e) => e.message).join('\n'));
      } else {
        // console.log(itemKey, item.dataType!.name);
      }
    }
  }

  async resolveEnvValues() {
    for (const itemKey in this.configSchema) {
      const item = this.configSchema[itemKey];
      await item.resolve();
    }
  }

  getResolvedEnvObject() {
    const envObject: Record<string, any> = {};
    for (const itemKey in this.configSchema) {
      const item = this.configSchema[itemKey];
      envObject[itemKey] = item.resolvedValue;
    }
    return envObject;
  }

  get isInvalid() {
    return _.some(_.values(this.configSchema), (i) => !i.isValid);
  }
}
