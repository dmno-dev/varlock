export { loadEnvGraph } from './lib/loader';

export { EnvGraph, type SerializedEnvGraph } from './lib/env-graph';
export {
  FileBasedDataSource, DotEnvFileDataSource, DirectoryDataSource, MultiplePathsContainerDataSource,
} from './lib/data-source';
export { Resolver, StaticValueResolver } from './lib/resolver';
export { ConfigItem, type TypeGenItemInfo } from './lib/config-item';
export {
  VarlockError,
  ConfigLoadError, SchemaError, ValidationError, CoercionError, ResolutionError,
} from './lib/errors';
export {
  BUILTIN_VARS, isBuiltinVar,
} from './lib/builtin-vars';
export { generateTsTypesSrc, getTsDefinitionForItem } from './lib/type-generation';
