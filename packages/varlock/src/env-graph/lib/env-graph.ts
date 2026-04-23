import _ from '@env-spec/utils/my-dash';
import path from 'node:path';
import { ConfigItem } from './config-item';
import { EnvGraphDataSource, FileBasedDataSource, ImportAliasSource } from './data-source';

import { BaseResolvers, createResolver, type ResolverChildClass } from './resolver';
import { VarlockResolver } from '../../lib/local-encrypt/builtin-resolver';
import { KeychainResolver } from '../../lib/local-encrypt/keychain-resolver';
import { BaseDataTypes, type EnvGraphDataTypeFactory } from './data-types';
import { findGraphCycles, getTransitiveDeps, type GraphAdjacencyList } from './graph-utils';
import { ResolutionError, SchemaError } from './errors';
import { generateTypes } from './type-generation';

import {
  builtInItemDecorators, builtInRootDecorators, RootDecoratorInstance, type ItemDecoratorDef, type RootDecoratorDef,
} from './decorators';
import { getErrorLocation } from './error-location';
import type { VarlockPlugin } from './plugins';
import { runWithResolutionContext, getResolutionContext } from './resolution-context';
import { getCiEnv, type CiEnvInfo } from '@varlock/ci-env-info';
import { BUILTIN_VARS, isBuiltinVar } from './builtin-vars';

const processExists = !!globalThis.process;
const originalProcessEnv = { ...processExists && process.env };

export type SerializedEnvGraphErrors = {
  /** Per-item validation errors, keyed by config item key */
  configItems?: Record<string, string>;
  /** Root-level errors not tied to a specific config item (loading errors, schema errors, plugin errors, etc.) */
  root?: Array<string>;
};

/** Entry in the sorted definition sources list — pairs a data source with the importKeys
 * filter that applies at that specific position in the precedence chain */
export type DefinitionSourceEntry = {
  source: EnvGraphDataSource;
  /** importKeys filter for this position (undefined = all keys visible) */
  importKeys?: Array<string>;
};

export type SerializedEnvGraph = {
  basePath?: string;
  sources: Array<{
    type: string;
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
  /** Present only when config has errors — consumers can check `if (data.errors)` */
  errors?: SerializedEnvGraphErrors;
};

/** container of the overall graph and current resolution attempt / values */
export class EnvGraph {
  // TODO: not sure if this should be the graph of _everything_ in a workspace/project
  // or just the files that are relevant to the current resolution attempt
  // (which would mean it's always through the lens of the current directory/package)

  basePath?: string;

  // -- Cache --
  /** @internal cache store instance, initialized during loading */
  _cacheStore?: import('../../lib/cache/cache-store').CacheStore;
  /** @internal --clear-cache flag: clear cache then resolve + rewrite */
  _clearCacheMode = false;
  /** @internal --skip-cache flag: skip cache entirely */
  _skipCacheMode = false;

  /** root data source (.env.schema) */
  rootDataSource?: EnvGraphDataSource;

  /** place to store process.env overrides */
  overrideValues: Record<string, string | undefined> = {};

  /** config item key of env flag (toggles env-specific data sources enabled) */
  envFlagKey?: string;
  /** graph-level fallback value for environment flag */
  envFlagFallback?: string;

  configSchema: Record<string, ConfigItem> = {};


  /**
   * Tracks directory/file paths that have already been loaded as imports.
   * Maps each import path to the data source that was created for it.
   * Used to prevent diamond-dependency re-imports (same schema imported via multiple paths),
   * which would otherwise cause plugin init decorators to run multiple times.
   */
  private _loadedImportPaths = new Map<string, EnvGraphDataSource>();

  /** Returns the existing source for a path if already loaded, or undefined */
  getLoadedImportSource(importPath: string): EnvGraphDataSource | undefined {
    return this._loadedImportPaths.get(importPath);
  }

  /** Records the data source that was created for an import path */
  recordLoadedImportPath(importPath: string, dataSource: EnvGraphDataSource) {
    this._loadedImportPaths.set(importPath, dataSource);
  }

  /**
   * Register ConfigItems for keys visible through an import
   * that may not have been registered during the original source's finishInit.
   */
  registerItemsForImport(
    source: EnvGraphDataSource,
    importSite: EnvGraphDataSource,
    importKeys?: Array<string>,
  ) {
    // Compute effective importKeys: intersection of import filter and importSite's parent chain
    const siteKeys = importSite.importKeys;
    let effectiveKeys: Array<string> | undefined;
    const hasFilter = importKeys && importKeys.length > 0;
    if (hasFilter && siteKeys?.length) {
      effectiveKeys = importKeys.filter((k) => siteKeys.includes(k));
    } else if (hasFilter) {
      effectiveKeys = importKeys;
    } else {
      effectiveKeys = siteKeys;
    }

    for (const s of this._getDescendants(source)) {
      const keys = effectiveKeys || _.keys(s.configItemDefs);
      for (const itemKey of keys) {
        if (!s.configItemDefs[itemKey]) continue;
        this.configSchema[itemKey] ??= new ConfigItem(this, itemKey);
      }
    }
  }

  /** Get a data source and all its descendants (DFS) */
  private _getDescendants(source: EnvGraphDataSource): Array<EnvGraphDataSource> {
    const result: Array<EnvGraphDataSource> = [source];
    for (const child of source.children) {
      result.push(...this._getDescendants(child));
    }
    return result;
  }

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

  /**
   * Precedence-ordered list of definition sources, used by ConfigItem.defs.
   *
   * Unlike `sortedDataSources` (which contains each real source exactly once),
   * this list can contain the same source multiple times at different positions
   * when it's imported from multiple locations (diamond dependency). Each entry
   * carries its own `importKeys` filter for that specific import context.
   *
   * Built from `sortedDataSources` by expanding `ImportAliasSource` nodes into
   * the original source's full subtree at the alias's precedence position.
   */
  get sortedDefinitionSources(): Array<DefinitionSourceEntry> {
    const result: Array<DefinitionSourceEntry> = [];

    for (const source of this.sortedDataSources) {
      if (source instanceof ImportAliasSource) {
        // Alias: expand to the original source's subtree at this position,
        // using the alias's importKeys (derived from its own parent chain)
        const importKeys = source.importKeys;
        for (const descendant of this._getDescendants(source.original)) {
          result.push({ source: descendant, importKeys });
        }
      } else {
        result.push({ source, importKeys: source.importKeys });
      }
    }

    return result;
  }

  registeredResolverFunctions: Record<string, ResolverChildClass> = {};
  registerResolver(resolverClass: ResolverChildClass) {
    // because its a class, we can't use `name`
    const fnName = resolverClass.fnName;
    if (fnName in this.registeredResolverFunctions) {
      throw new Error(`Resolver ${fnName} already registered`);
    }
    this.registeredResolverFunctions[fnName] = resolverClass;
  }

  dataTypesRegistry: Record<string, EnvGraphDataTypeFactory> = {};
  registerDataType(factory: EnvGraphDataTypeFactory) {
    const name = factory.dataTypeName;
    if (name in this.dataTypesRegistry) {
      throw new Error(`Data type "${name}" already registered`);
    }
    this.dataTypesRegistry[factory.dataTypeName] = factory;
  }

  itemDecoratorsRegistry: Record<string, ItemDecoratorDef> = {};
  registerItemDecorator(decoratorDef: ItemDecoratorDef) {
    const name = decoratorDef.name;
    if (name in this.itemDecoratorsRegistry) {
      throw new Error(`Item decorator "${name}" already registered`);
    }
    this.itemDecoratorsRegistry[decoratorDef.name] = decoratorDef;
  }

  rootDecoratorsRegistry: Record<string, RootDecoratorDef> = {};
  registerRootDecorator(decoratorDef: RootDecoratorDef) {
    const name = decoratorDef.name;
    if (name in this.itemDecoratorsRegistry) {
      throw new Error(`Root decorator "${name}" already registered`);
    }
    this.rootDecoratorsRegistry[decoratorDef.name] = decoratorDef;
  }

  constructor() {
    // register base data types (string, number, boolean, etc)
    for (const dataType of BaseDataTypes) {
      this.registerDataType(dataType);
    }
    // register base resolvers (concat, ref, exec, etc)
    for (const resolverClass of BaseResolvers) {
      this.registerResolver(resolverClass);
    }
    // register built-in varlock() resolver for local encryption
    this.registerResolver(VarlockResolver);
    // register built-in keychain() resolver for macOS Keychain access
    this.registerResolver(KeychainResolver);
    // base root decorators (envFlag, generateTypes, import, etc)
    for (const rootDec of builtInRootDecorators) {
      this.registerRootDecorator(rootDec);
    }
    // base item decorators (required, sensitive, docs, etc)
    for (const itemDec of builtInItemDecorators) {
      this.registerItemDecorator(itemDec);
    }

    this.overrideValues = originalProcessEnv;
  }

  /**
   * Override for process.env used by builtin var detection.
   * When set, builtin vars use this instead of the real process.env.
   * Primarily useful for testing.
   */
  processEnvOverride?: Record<string, string | undefined>;

  /** Cached CI env info, computed lazily from processEnvOverride or real process.env */
  private _cachedCiEnv?: CiEnvInfo;
  get ciEnvInfo(): CiEnvInfo {
    this._cachedCiEnv ??= getCiEnv(this.processEnvOverride ?? process.env);
    return this._cachedCiEnv;
  }

  /** The process env record used for builtin var detection */
  get processEnvForBuiltins(): Record<string, string | undefined> {
    return this.processEnvOverride ?? process.env;
  }

  /**
   * Register a builtin VARLOCK_* variable.
   * Attaches an internal def with the builtin resolver so it flows through the normal pipeline.
   * If the item already exists (user-defined), the internal def is added as a fallback.
   */
  registerBuiltinVar(key: string) {
    const builtinDef = BUILTIN_VARS[key];
    if (!builtinDef) throw new Error(`Unknown builtin var: ${key}`);

    let item = this.configSchema[key];

    // Already has builtin def attached — nothing to do
    if (item?._internalDefs.length) return;

    // Need to capture `this` (the graph) for the resolver closure
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const graph = this;

    // Create the resolver for this builtin var
    const BuiltinVarResolver = createResolver({
      name: `\0builtin:${key}`,
      description: builtinDef.description,
      inferredType: 'string',
      async resolve() {
        return builtinDef.resolver(graph.ciEnvInfo, graph.processEnvForBuiltins);
      },
    });

    if (!item) {
      // No user definition — create the item from scratch
      item = new ConfigItem(this, key);
      // Pre-set defaults — builtins are optional and public.
      // processRequired/processSensitive will not override these since the
      // internal def has no decorators and no source with root-level defaults.
      item._isRequired = false;
      item._isSensitive = false;
      // Set dataType directly since registerBuiltinVar is called synchronously
      // during resolver processing, and the item may not get a process() call
      // from the finishLoad loop (for...in doesn't reliably visit new keys).
      item.dataType = this.dataTypesRegistry.string();
      this.configSchema[key] = item;
    }

    item.isBuiltin = true;

    // Attach an internal def with description and resolver.
    // For user-defined items, this sits at lowest priority in defs —
    // the builtin resolver acts as a fallback when no explicit value is set.
    item._internalDefs.push({
      itemDef: {
        description: builtinDef.description,
        parsedValue: undefined,
        resolver: new BuiltinVarResolver([], undefined, undefined),
      },
    });
  }

  async setRootDataSource(source: EnvGraphDataSource) {
    if (this.rootDataSource) throw new Error('root data source already set');
    this.rootDataSource = source;
    source.graph = this;
    await source.finishInit();
    // Process imports on the root source itself.
    // For DirectoryDataSource this is a no-op (containers have no import decorators);
    // its children's imports are handled internally in _finishInit().
    // For standalone file sources, this processes their imports now.
    await source._processImports();
  }

  async finishLoad() {
    // bail early if we already have issues
    for (const source of this.sortedDataSources) {
      if (!source.isValid) return;
    }
    for (const plugin of this.plugins) {
      if (plugin.loadingError) return;
    }

    // check declared standardVars against the environment
    for (const plugin of this.plugins) {
      plugin._checkStandardVars(this);
    }

    // Attach builtin defs to any user-defined VARLOCK_* items
    // (they may have been defined directly without a $VARLOCK_* reference)
    for (const key in this.configSchema) {
      if (isBuiltinVar(key)) this.registerBuiltinVar(key);
    }

    // process root decorators
    let processingError = false;
    for (const source of this.sortedDataSources) {
      if (source.disabled) continue;
      for (const decInstance of source.rootDecorators) {
        await decInstance.process();
        if (decInstance.schemaErrors.some((e) => !e.isWarning)) processingError = true;
      }
    }

    // process config items
    // checks decorators, sets data type, checks resolver args, adds deps
    for (const itemKey in this.configSchema) {
      const item = this.configSchema[itemKey];
      await item.process();
      if (item.errors.some((e) => !e.isWarning)) processingError = true;
    }

    if (processingError) return;

    // check for cycles in resolver dependencies
    const cycles = findGraphCycles(this.graphAdjacencyList);
    for (const cycleItemKeys of cycles) {
      for (const itemKey of cycleItemKeys) {
        const item = this.configSchema[itemKey];
        item._schemaErrors.push(
          new SchemaError(
            cycleItemKeys.length === 1
              ? 'Item cannot have dependency on itself'
              : `Dependency cycle detected: (${cycleItemKeys.join(', ')})`,
          ),
        );
      }
    }

    // now execute all root decorators
    for (const source of this.sortedDataSources) {
      if (source.disabled) continue;
      for (const decInstance of source.rootDecorators) {
        if (!decInstance.decValueResolver) throw new Error('expected decorator value resolver');
        await this.resolveEnvValues(decInstance.decValueResolver.deps);
        try {
          await decInstance.execute();
        } catch (err) {
          // prefer the error's own location (e.g. from a nested resolver) over the decorator's
          const errLocation = (err as any).more?.location
            || getErrorLocation(source, decInstance.parsedDecorator);
          decInstance._executionError = new SchemaError(
            err as Error,
            {
              location: errLocation,
              ...((err as any).tip && { tip: (err as any).tip }),
            },
          );
        }
      }
    }

    // maybe should be part of a _resolve all root decorators_ step?
    await this.getRootDec('redactLogs')?.resolve();
    await this.getRootDec('preventLeaks')?.resolve();
  }

  get graphAdjacencyList() {
    const adjList: GraphAdjacencyList = {};
    for (const itemKey in this.configSchema) {
      const item = this.configSchema[itemKey];
      adjList[itemKey] = item.dependencyKeys;
    }
    return adjList;
  }

  async resolveEnvValues(keys?: Array<string>): Promise<void> {
    const keysToResolve = keys ?? _.keys(this.configSchema);
    if (!keysToResolve.length) return;

    const adjList = _.pick(this.graphAdjacencyList, keysToResolve);
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
    const itemsToResolveStatus = _.fromPairs(keysToResolve.map((key) => [key, false]));

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

        // if item has real errors (not just warnings), we are done - skip resolution
        if (item.errors.some((e) => !e.isWarning)) {
          markItemCompleted(itemKey);
          return;
        }

        for (const depKey of adjList[itemKey] || []) {
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
        await runWithResolutionContext({
          cacheStore: this._cacheStore,
          skipCache: this._skipCacheMode,
          clearCache: this._clearCacheMode,
          cacheHits: [],
          currentItem: item,
        }, async () => {
          await item.resolve();
          const ctx = getResolutionContext();
          if (ctx?.cacheHits.length) {
            item._cacheHits = ctx.cacheHits;
          }
        });
        markItemCompleted(itemKey);
      };

      for (const itemKey in this.configSchema) {
        resolveItem(itemKey);
      }
    });
    return deferred;
  }

  async resolveItemWithDeps(key: string): Promise<void> {
    // The graphAdjacencyList includes deps from both value resolvers and item decorator
    // resolvers (e.g. @required($APP_ENV == "prod")), so getTransitiveDeps captures
    // everything needed at value-resolution time.
    //
    // Note: currentEnv/envFlagKey and conditional @import(enabled=...) deps are already
    // resolved via earlyResolve() during loadEnvGraph(), so they have isResolved=true
    // by the time this method is called.  Items that were earlyResolve()d will simply
    // skip re-resolution in ConfigItem.resolve() (early-return when isResolved=true).
    const transitiveDeps = getTransitiveDeps(key, this.graphAdjacencyList);
    await this.resolveEnvValues([...transitiveDeps, key]);
  }

  /** config keys with builtin vars first, then user-defined in schema order */
  get sortedConfigKeys() {
    const builtinKeys: Array<string> = [];
    const userKeys: Array<string> = [];
    for (const key in this.configSchema) {
      if (this.configSchema[key].isBuiltin) builtinKeys.push(key);
      else userKeys.push(key);
    }
    return [...builtinKeys, ...userKeys];
  }

  getResolvedEnvObject() {
    const envObject: Record<string, any> = {};
    for (const itemKey of this.sortedConfigKeys) {
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
        type: source.type,
        label: source.label,
        enabled: !source.disabled,
        path: source instanceof FileBasedDataSource ? path.relative(this.basePath ?? '', source.fullPath) : undefined,
      });
    }
    for (const itemKey of this.sortedConfigKeys) {
      const item = this.configSchema[itemKey];
      serializedGraph.config[itemKey] = {
        value: item.resolvedValue,
        isSensitive: item.isSensitive,
      };
    }

    // expose a few root level settings
    serializedGraph.settings.redactLogs = this.getRootDec('redactLogs')?.resolvedValue ?? true;
    serializedGraph.settings.preventLeaks = this.getRootDec('preventLeaks')?.resolvedValue ?? true;

    // collect all errors into a single nested object
    const errors: SerializedEnvGraphErrors = {};

    // root-level errors (loading, schema, resolution errors from data sources)
    const rootErrors: Array<string> = [];
    for (const source of this.sortedDataSources) {
      if (source.loadingError) {
        rootErrors.push(`${source.label}: ${source.loadingError.message}`);
      }
      for (const err of source.schemaErrors) {
        rootErrors.push(`${source.label}: ${err.message}`);
      }
      for (const err of source.resolutionErrors) {
        rootErrors.push(`${source.label}: ${err.message}`);
      }
    }
    if (rootErrors.length > 0) {
      errors.root = rootErrors;
    }

    // per-item validation errors keyed by item key
    const configItemErrors: Record<string, string> = {};
    for (const itemKey of this.sortedConfigKeys) {
      const item = this.configSchema[itemKey];
      if (item.validationState === 'error') {
        configItemErrors[itemKey] = item.errors.map((e) => e.message).join('; ');
      }
    }
    if (Object.keys(configItemErrors).length > 0) {
      errors.configItems = configItemErrors;
    }

    // only include errors key if there are any
    if (errors.root || errors.configItems) {
      serializedGraph.errors = errors;
    }

    return serializedGraph;
  }

  get isInvalid() {
    return _.some(_.values(this.configSchema), (i) => !i.isValid);
  }

  async generateTypes(lang: string, outputPath: string) {
    await generateTypes(this, lang, outputPath);
  }

  /**
   * Resolve @generateTypes decorators and generate type files.
   * This should be called after finishLoad() but before resolveEnvValues().
   * The @generateTypes decorator args (lang, path) are static, so we can resolve them
   * without needing full env resolution. Type info is computed from non-env-specific
   * definitions only, so the output is deterministic regardless of environment.
   *
   * @param opts.ignoreAutoFalse - if true, generate types even if `auto=false` is set.
   *   Used by the `varlock typegen` command to force generation.
   */
  async generateTypesIfNeeded(opts?: { ignoreAutoFalse?: boolean }) {
    const generateTypesDecs = this.getRootDecFns('generateTypes');
    let generatedCount = 0;
    for (const generateTypesDec of generateTypesDecs) {
      const typeGenSettings = await generateTypesDec.resolve();

      // we skip generating types if `@generateTypes` was not in the main file
      // unless the `executeWhenImported` flag is set
      if (generateTypesDec.dataSource.isImport && !typeGenSettings.obj.executeWhenImported) continue;

      // skip if auto=false unless explicitly overridden (e.g., `varlock typegen`)
      if (typeGenSettings.obj.auto === false && !opts?.ignoreAutoFalse) continue;

      if (!typeGenSettings.obj.lang) throw new Error('@generateTypes - must set `lang` arg');
      if (typeGenSettings.obj.lang !== 'ts') throw new Error(`@generateTypes - unsupported language: ${typeGenSettings.obj.lang}`);
      if (!typeGenSettings.obj.path) throw new Error('@generateTypes - must set `path` arg');
      if (!_.isString(typeGenSettings.obj.path)) throw new Error('@generateTypes - `path` arg must be a string');

      const outputPath = generateTypesDec.dataSource instanceof FileBasedDataSource
        ? path.resolve(generateTypesDec.dataSource.fullPath, '..', typeGenSettings.obj.path)
        : typeGenSettings.obj.path;

      await this.generateTypes(typeGenSettings.obj.lang, outputPath);
      generatedCount++;
    }
    return generatedCount;
  }

  getRootDec(decoratorName: string) {
    // currently this is just used above, but may want to rework
    // to track values once as we process sources
    const sources = Array.from(this.sortedDataSources).reverse();
    for (const s of sources) {
      if (s.disabled) continue;
      const dec = s.getRootDec(decoratorName);
      if (dec) return dec;
    }
    return undefined;
  }
  getRootDecFns(decoratorName: string) {
    const allDecs: Array<RootDecoratorInstance> = [];
    const sources = Array.from(this.sortedDataSources).reverse();
    for (const source of sources) {
      if (source.disabled) continue;
      const decs = source.getRootDecFns(decoratorName);
      allDecs.push(...decs);
    }
    return allDecs;
  }


  /** plugins installed globally in the graph */
  plugins: Array<VarlockPlugin> = [];
}
