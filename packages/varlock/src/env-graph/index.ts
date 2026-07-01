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
  generateGoTypesSrc,
  generatePhpTypesSrc,
  generatePythonTypesSrc,
  generateRustTypesSrc,
  generateTsTypesSrc,
  getTsDefinitionForItem,
  isSupportedTypeGenLang,
  LANG_TO_DECORATOR,
  resolveCoercedType,
  resolveFieldType,
  resolveFieldTypes,
  resolveRawStringType,
  resolveTsGenOptions,
  SUPPORTED_TYPEGEN_LANGS,
  type CodeGenContext,
  type CodeGeneratorDef,
  type CoercedType,
  type RawStringType,
  type ResolvedFieldType,
  type TsEnvExposure,
  type TsGenOptions,
  type TsGlobalAugment,
  type TypeGenLang,
} from './lib/type-generation';
