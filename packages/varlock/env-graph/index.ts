export { loadEnvGraph } from './lib/loader';

export { EnvGraph, type SerializedEnvGraph } from './lib/env-graph';
export {
  EnvSourceParseError, FileBasedDataSource, DotEnvFileDataSource,
  DirectoryDataSource,
} from './lib/data-source';
export { Resolver, StaticValueResolver } from './lib/resolver';
export { ConfigItem } from './lib/config-item';
export {
  VarlockError,
  ConfigLoadError, SchemaError, ValidationError, CoercionError, ResolutionError,
} from './lib/errors';
