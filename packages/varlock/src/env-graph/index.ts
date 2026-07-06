export { loadEnvGraph } from './lib/loader';

export { EnvGraph, type SerializedEnvGraph } from './lib/env-graph';
export {
  FileBasedDataSource, DotEnvFileDataSource, DirectoryDataSource, MultiplePathsContainerDataSource,
} from './lib/data-source';
export { Resolver, StaticValueResolver } from './lib/resolver';
export { ConfigItem, type TypeGenItemInfo } from './lib/config-item';
export {
  VarlockError,
  ConfigLoadError, LoadingError, ParseError, SchemaError, ValidationError, CoercionError, ResolutionError,
  type ErrorSeverity,
} from './lib/errors';
export {
  BUILTIN_VARS, isBuiltinVar,
} from './lib/builtin-vars';
export {
  builtInCodeGenerators,
  collectTypeGenItems,
  generateGoEnvSrc,
  generatePhpEnvSrc,
  generatePythonEnvSrc,
  generateRustEnvSrc,
  generateTsTypesSrc,
  resolveFieldType,
  resolveFieldTypes,
  type CodeGenContext,
  type CodeGeneratorDef,
  type CoercedType,
  type ResolvedFieldType,
} from './lib/type-generation';
