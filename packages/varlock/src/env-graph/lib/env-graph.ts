import _ from '@env-spec/utils/my-dash';
import path from 'node:path';
import fs from 'node:fs';
import { ConfigItem, type TypeGenItemInfo } from './config-item';
import {
  EnvGraphDataSource, FileBasedDataSource, ImportAliasSource,
  keyPassesImportFilter,
} from './data-source';
import { type KeyFilter } from './key-filter';

import { BaseResolvers, createResolver, type ResolverChildClass } from './resolver';
import { BaseDataTypes, type EnvGraphDataTypeFactory } from './data-types';
import { findGraphCycles, getTransitiveDeps, type GraphAdjacencyList } from './graph-utils';
import { ResolutionError, SchemaError } from './errors';
import {
  builtInCodeGenerators, collectTypeGenItems, resolveFieldTypes,
  type CodeGeneratorDef, type ResolvedFieldType,
} from './type-generation';

import {
  builtInItemDecorators, builtInRootDecorators, RootDecoratorInstance, type ItemDecoratorDef, type RootDecoratorDef,
} from './decorators';
import { getErrorLocation } from './error-location';
import type { VarlockPlugin } from './plugins';
import { runWithResolutionContext, getResolutionContext } from './resolution-context';
import { getCiEnv, type CiEnvInfo } from '@varlock/ci-env-info';
import { BUILTIN_VARS, isBuiltinVar } from './builtin-vars';
import { isVarlockReservedKey } from './reserved-vars';
import { buildOverrideProvenanceMetadata, type OverrideProvenanceMetadata } from '../../lib/injected-env-provenance';

const processExists = !!globalThis.process;
const originalProcessEnv = { ...processExists && process.env };

export type SerializedEnvGraphErrors = {
  /** Per-item validation errors, keyed by config item key */
  configItems?: Record<string, string>;
  /** Root-level errors not tied to a specific config item (loading errors, schema errors, plugin errors, etc.) */
  root?: Array<string>;
};

/** Entry in the sorted definition sources list — pairs a data source with the node whose
 * import chain filters which keys are visible at that specific position in the precedence chain */
export type DefinitionSourceEntry = {
  source: EnvGraphDataSource;
  /** node whose import chain decides key visibility for this position (undefined = all keys visible) */
  filterNode?: EnvGraphDataSource;
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
    encryptInjectedEnv?: boolean;
    disableProcessEnvInjection?: boolean;
  },
  config: Record<string, {
    value: any;
    isSensitive: boolean;
    /** false = opted out of runtime leak detection (still redacted in logs). Omitted when true (the default). */
    preventLeaks?: boolean;
    /** true = used only by varlock, not injected into the app. Only present in inspection output (never in the blob). */
    isInternal?: boolean;
  }>;
  /** provenance metadata for process.env overrides across nested invocations */
  __varlockOverrideMeta?: OverrideProvenanceMetadata;
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
  _cacheStore?: import('../../lib/cache/cache-store').CacheStoreLike;
  /** @internal cache mode selected from CLI/loader auto policy */
  _cacheMode: 'auto' | 'memory' | 'disk' | 'disabled' = 'auto';
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
   * Stack of sources whose imports are currently being processed (an ancestor chain).
   * Used to detect circular imports: a path that re-enters while still on the stack is a cycle.
   * Unlike `_loadedImportPaths` (recorded only after a child fully loads, for diamond dedup),
   * this is recorded *before* descending, so a true cycle is caught before it recurses forever.
   */
  private _importProcessingStack: Array<string> = [];

  /**
   * Mark a source as being processed for imports.
   * Returns the cycle chain (including the repeated entry) if `key` is already on the stack,
   * otherwise pushes it and returns undefined.
   */
  beginImportProcessing(key: string): Array<string> | undefined {
    const existingIndex = this._importProcessingStack.indexOf(key);
    if (existingIndex !== -1) {
      return [...this._importProcessingStack.slice(existingIndex), key];
    }
    this._importProcessingStack.push(key);
    return undefined;
  }

  /** Pop a source off the import-processing stack once its imports are done. */
  endImportProcessing(key: string) {
    const index = this._importProcessingStack.lastIndexOf(key);
    if (index !== -1) this._importProcessingStack.splice(index, 1);
  }

  /**
   * Register ConfigItems for keys visible through an import
   * that may not have been registered during the original source's finishInit.
   */
  registerItemsForImport(
    source: EnvGraphDataSource,
    importSite: EnvGraphDataSource,
    importMeta?: { importKeys?: Array<string>, importFilter?: KeyFilter },
  ) {
    // A key is visible only if it passes both this import's own filter and the
    // importSite's full import chain (nested imports intersect).
    for (const s of this._getDescendants(source)) {
      for (const itemKey of _.keys(s.configItemDefs)) {
        if (importMeta && !keyPassesImportFilter(itemKey, importMeta.importKeys, importMeta.importFilter)) continue;
        if (!importSite.isKeyImported(itemKey)) continue;
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
        // Alias: expand to the original source's subtree at this position, applying the
        // alias node's import chain (its own filter + the importing context) for visibility.
        for (const descendant of this._getDescendants(source.original)) {
          result.push({ source: descendant, filterNode: source });
        }
      } else {
        result.push({ source, filterNode: source });
      }
    }

    return result;
  }

  registeredResolverFunctions: Record<string, ResolverChildClass> = {};
  registerResolver(resolverClass: ResolverChildClass) {
    // because its a class, we can't use `name`
    const fnName = resolverClass.fnName;
    if (fnName in this.registeredResolverFunctions) {
      throw new SchemaError(`Resolver ${fnName} already registered`);
    }
    this.registeredResolverFunctions[fnName] = resolverClass;
  }

  dataTypesRegistry: Record<string, EnvGraphDataTypeFactory> = {};
  registerDataType(factory: EnvGraphDataTypeFactory) {
    const name = factory.dataTypeName;
    if (name in this.dataTypesRegistry) {
      throw new SchemaError(`Data type "${name}" already registered`);
    }
    this.dataTypesRegistry[factory.dataTypeName] = factory;
  }

  itemDecoratorsRegistry: Record<string, ItemDecoratorDef> = {};
  registerItemDecorator(decoratorDef: ItemDecoratorDef) {
    const name = decoratorDef.name;
    if (name in this.itemDecoratorsRegistry) {
      throw new SchemaError(`Item decorator "${name}" already registered`);
    }
    this.itemDecoratorsRegistry[decoratorDef.name] = decoratorDef;
  }

  rootDecoratorsRegistry: Record<string, RootDecoratorDef> = {};
  registerRootDecorator(decoratorDef: RootDecoratorDef) {
    const name = decoratorDef.name;
    if (name in this.itemDecoratorsRegistry) {
      throw new SchemaError(`Root decorator "${name}" already registered`);
    }
    this.rootDecoratorsRegistry[decoratorDef.name] = decoratorDef;
  }

  /** Registered code generators, keyed by the root decorator name that triggers them. */
  codeGeneratorsRegistry: Record<string, CodeGeneratorDef> = {};
  registerCodeGenerator(generatorDef: CodeGeneratorDef) {
    const name = generatorDef.decoratorName;
    // ensure a root decorator exists for this generator (plugins get one for free)
    if (!(name in this.rootDecoratorsRegistry)) {
      this.registerRootDecorator({ name, isFunction: true });
    }
    this.codeGeneratorsRegistry[name] = generatorDef;
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
    // base root decorators (envFlag, generateTypes, import, etc)
    for (const rootDec of builtInRootDecorators) {
      this.registerRootDecorator(rootDec);
    }
    // base item decorators (required, sensitive, docs, etc)
    for (const itemDec of builtInItemDecorators) {
      this.registerItemDecorator(itemDec);
    }
    // base code generators (ts/py/rs/go/php + deprecated generateTypes alias)
    // registered via the same API plugins use
    for (const codeGen of builtInCodeGenerators) {
      this.registerCodeGenerator(codeGen);
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
    const builtinType = builtinDef.type || 'string';
    const BuiltinVarResolver = createResolver({
      name: `\0builtin:${key}`,
      description: builtinDef.description,
      // Advertise the builtin's declared type so that if the item gets a
      // process() call (e.g. when registered early via a root-decorator
      // reference), config-item type inference preserves it instead of
      // defaulting back to 'string' — which would stringify a boolean/number
      // builtin (e.g. VARLOCK_IS_CI false -> "false", breaking not()/if()).
      inferredType: builtinType,
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
      const dataTypeFactory = this.dataTypesRegistry[builtinType] ?? this.dataTypesRegistry.string;
      item.dataType = dataTypeFactory();
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

    // Attach builtin defs to any user-defined VARLOCK_* items
    // (they may have been defined directly without a $VARLOCK_* reference)
    for (const key in this.configSchema) {
      if (isBuiltinVar(key)) this.registerBuiltinVar(key);
    }

    // Warn about items defined with varlock's reserved _VARLOCK_ prefix. These keys are
    // excluded from the injected env blob and generated types, so a user-defined one is
    // almost certainly a mistake (or a typo'd internal var that won't behave as expected).
    for (const source of this.sortedDataSources) {
      if (source.disabled) continue;
      for (const itemKey of Object.keys(source.configItemDefs)) {
        if (isVarlockReservedKey(itemKey)) {
          source._errors.push(new SchemaError(
            `"${itemKey}" uses varlock's reserved _VARLOCK_ prefix`,
            {
              isWarning: true,
              tip: 'Keys starting with _VARLOCK_ are reserved for configuring varlock itself and are excluded from the injected env and generated types. Rename this item unless that exclusion is intended.',
            },
          ));
        }
      }
    }

    // process root decorators
    let hasErrors = false;
    for (const source of this.sortedDataSources) {
      if (source.disabled) continue;
      for (const decInstance of source.rootDecorators) {
        await decInstance.process();
        if (decInstance.schemaErrors.some((e) => !e.isWarning)) hasErrors = true;
      }
    }

    // apply global cache policy early so plugin modules see the final setting
    // when @plugin decorators execute below.
    const cacheDec = this.getRootDec('cache');
    if (cacheDec) {
      const cacheSetting = await cacheDec.resolve();
      let cacheMode: 'auto' | 'memory' | 'disk' | 'disabled' = 'auto';
      if (cacheSetting === 'auto' || cacheSetting === 'memory' || cacheSetting === 'disk' || cacheSetting === 'disabled') {
        cacheMode = cacheSetting;
      } else if (cacheSetting !== undefined) {
        // dynamic values are validated here (static ones already failed in process());
        // undefined (e.g. forEnv with no match) falls back to auto
        cacheDec._errors.push(new SchemaError(
          `@cache resolved to an invalid value (${JSON.stringify(cacheSetting)}) — must be one of: "auto", "memory", "disk", "disabled"`,
        ));
      }
      if (cacheMode === 'disabled') {
        this._cacheMode = 'disabled';
        this._skipCacheMode = true;
        this._cacheStore = undefined;
      } else if (!this._skipCacheMode) {
        const { CacheStore, InMemoryCacheStore } = await import('../../lib/cache');
        if (cacheMode === 'memory') {
          this._cacheMode = 'memory';
          this._cacheStore = new InMemoryCacheStore();
        } else if (cacheMode === 'disk') {
          // explicit disk mode overrides the auto policy's safety fallback — allowed, but warn
          const localEncrypt = await import('../../lib/local-encrypt');
          const { createEnvKeyCacheStore, getCacheEnvKey } = await import('../../lib/cache');
          const envKey = getCacheEnvKey(this.processEnvOverride ?? process.env);
          const backendIsFile = localEncrypt.getBackendInfo().type === 'file';

          let diskStore: import('../../lib/cache/cache-store').CacheStoreLike | undefined;
          if (backendIsFile && envKey) {
            // env-provided key beats the file fallback — the key never touches disk
            try {
              diskStore = createEnvKeyCacheStore(envKey);
            } catch (err) {
              cacheDec._errors.push(new SchemaError(
                `_VARLOCK_CACHE_KEY is set but invalid (${err instanceof Error ? err.message : err}) — falling back to file-based encryption`,
                { isWarning: true },
              ));
            }
          }
          if (!diskStore) {
            if (backendIsFile) {
              cacheDec._errors.push(new SchemaError(
                '@cache=disk with the file-based encryption fallback stores the decryption key on the same disk as the cache — encrypted values are only obfuscated',
                { isWarning: true },
              ));
            } else if (this.ciEnvInfo.isCI) {
              cacheDec._errors.push(new SchemaError(
                '@cache=disk in CI persists encrypted values on the runner disk — make sure the runner is ephemeral or this is intended',
                { isWarning: true },
              ));
            }
            diskStore = new CacheStore();
          }
          this._cacheMode = 'disk';
          this._cacheStore = diskStore;
        } else if (cacheMode === 'auto') {
          if (!this._cacheStore) {
            if (this._cacheMode === 'memory') this._cacheStore = new InMemoryCacheStore();
            else if (this._cacheMode === 'disk') this._cacheStore = new CacheStore();
          }
        }
      }
    } else if (this._skipCacheMode) {
      this._cacheStore = undefined;
    }

    // check declared standardVars against the environment
    // (runs after root decorator processing so decValueResolver.deps is available)
    for (const plugin of this.plugins) {
      plugin._checkStandardVars(this);
    }

    // process config items
    // checks decorators, sets data type, checks resolver args, adds deps
    for (const itemKey in this.configSchema) {
      const item = this.configSchema[itemKey];
      await item.process();
      if (item.errors.some((e) => !e.isWarning)) hasErrors = true;
    }

    if (hasErrors) return;

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
        if (!decInstance.decValueResolver) continue; // no resolver = errored during process()
        await this.resolveEnvValues(decInstance.decValueResolver.deps);
        try {
          await decInstance.execute();
        } catch (err) {
          // prefer the error's own location (e.g. from a nested resolver) over the decorator's
          const errLocation = (err as any).more?.location
            || getErrorLocation(source, decInstance.parsedDecorator);
          decInstance._errors.push(new ResolutionError(
            err as Error,
            {
              severity: 'fatal',
              location: errLocation,
              ...((err as any).tip && { tip: (err as any).tip }),
            },
          ));
        }
      }
    }

    // maybe should be part of a _resolve all root decorators_ step?
    await this.getRootDec('redactLogs')?.resolve();
    await this.getRootDec('preventLeaks')?.resolve();
    await this.getRootDec('encryptInjectedEnv')?.resolve();
    await this.getRootDec('disableProcessEnvInjection')?.resolve();
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

  /**
   * Keys that were excluded from generated types because they only exist in a plain `.env`
   * value file (not declared in `.env.schema` or imported into it). These are usually drift —
   * a stale or extra key, or one the user meant to declare in their schema. Type generation
   * deliberately ignores them so output stays deterministic, but surfacing them lets the
   * `typegen` command (or a future doctor check) nudge the user. Keys defined only in
   * env-specific files (`.env.local`, `.env.production`, ...) are intentionally excluded here.
   */
  getValueOnlyKeysExcludedFromTypes() {
    const keys: Array<string> = [];
    for (const itemKey of this.sortedConfigKeys) {
      if (isVarlockReservedKey(itemKey)) continue;
      const item = this.configSchema[itemKey];
      if (item.isBuiltin) continue;
      // still has a schema-defining def → it's included in types, nothing to flag
      if (item.defsForTypeGeneration.length) continue;
      // only flag keys that actually appear in a plain `.env` (vs. only env-specific files)
      if (item.defs.some((def) => def.source?.isAutoloadedValueSource)) keys.push(itemKey);
    }
    return keys;
  }

  getResolvedEnvObject(opts?: { includeInternal?: boolean }) {
    const envObject: Record<string, any> = {};
    for (const itemKey of this.sortedConfigKeys) {
      const item = this.configSchema[itemKey];
      // @internal items are used only by varlock (e.g. to resolve other items) and are
      // never injected into the application — exclude them from the resolved env output
      if (item.isInternal && !opts?.includeInternal) continue;
      envObject[itemKey] = item.resolvedValue;
    }
    return envObject;
  }

  getSerializedGraph(opts?: { includeInternal?: boolean }): SerializedEnvGraph {
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
      // _VARLOCK_* keys configure varlock's own behavior and must never land in the blob:
      // e.g. _VARLOCK_ENV_KEY encrypts the blob itself (the runtime already has it via
      // process.env) and _VARLOCK_CACHE_KEY encrypts the disk cache. Skip the whole
      // reserved prefix so any current/future infra var is excluded automatically.
      if (isVarlockReservedKey(itemKey)) continue;
      const item = this.configSchema[itemKey];
      // @internal items are never injected into the app, so the blob (delivered to the app
      // process via __VARLOCK_ENV) must exclude them entirely. Inspection callers
      // (e.g. `load --format json-full`) opt in via includeInternal to show them, flagged.
      if (item.isInternal && !opts?.includeInternal) continue;
      serializedGraph.config[itemKey] = {
        value: item.resolvedValue,
        isSensitive: item.isSensitive,
        ...item.isInternal ? { isInternal: true } : {},
        // only emit when opted out — keeps the common-case blob smaller
        ...item.isSensitive && !item.preventLeaks ? { preventLeaks: false } : {},
      };
    }
    // Only process.env keys that correspond to a config item can actually act as overrides.
    // overrideValues defaults to the entire process.env, so without this filter the provenance
    // list would mirror every env var (PATH, HOME, ...) — pure noise that also leaks the
    // caller's full env var name list into the blob. Reserved _VARLOCK_* keys configure
    // varlock itself and are never overrides, so exclude them even if defined in the schema.
    serializedGraph.__varlockOverrideMeta = buildOverrideProvenanceMetadata(
      Object.keys(this.overrideValues).filter(
        (k) => k in this.configSchema && !isVarlockReservedKey(k),
      ),
    );

    // expose a few root level settings
    serializedGraph.settings.redactLogs = this.getRootDec('redactLogs')?.resolvedValue ?? true;
    serializedGraph.settings.preventLeaks = this.getRootDec('preventLeaks')?.resolvedValue ?? true;
    serializedGraph.settings.encryptInjectedEnv = this.getRootDec('encryptInjectedEnv')?.resolvedValue ?? false;
    serializedGraph.settings.disableProcessEnvInjection = this.getRootDec('disableProcessEnvInjection')?.resolvedValue ?? false;

    // collect all errors into a single nested object
    const errors: SerializedEnvGraphErrors = {};

    // root-level errors (loading, schema, resolution errors from data sources)
    const rootErrors: Array<string> = [];
    for (const source of this.sortedDataSources) {
      for (const err of source.errors.filter((e) => !e.isWarning)) {
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

  /**
   * True when `@disableProcessEnvInjection` is set — resolved values are NOT mirrored into
   * `process.env`, so type generation should not type `process.env` as populated.
   * Resolved during finishLoad(), so this is available before code generation runs.
   */
  get isProcessEnvInjectionDisabled(): boolean {
    return this.getRootDec('disableProcessEnvInjection')?.resolvedValue ?? false;
  }

  /**
   * Resolve every registered code-generation decorator (@generateTsTypes, @generatePythonTypes,
   * plugin-contributed ones, and the deprecated @generateTypes) and write their output files.
   * This should be called after finishLoad() but before resolveEnvValues().
   * Decorator args (path, options) are static, so we can resolve them without full env resolution.
   * Type info is computed from non-env-specific definitions only, so output is deterministic
   * regardless of the active environment.
   *
   * @param opts.ignoreAutoFalse - if true, generate even if `auto=false` is set.
   *   Used by the `varlock typegen` command to force generation.
   */
  async runCodeGeneratorsIfNeeded(opts?: { ignoreAutoFalse?: boolean }) {
    let generatedCount = 0;

    // the item/field lists are the same across all generators — build them lazily, once,
    // and only if at least one generator actually runs
    let items: Array<TypeGenItemInfo> | undefined;
    let fields: Array<ResolvedFieldType> | undefined;

    for (const decoratorName of Object.keys(this.codeGeneratorsRegistry)) {
      const generator = this.codeGeneratorsRegistry[decoratorName];
      const decs = this.getRootDecFns(decoratorName);
      for (const dec of decs) {
        const settings = await dec.resolve();

        // skip if the decorator came from an imported file, unless `executeWhenImported` is set
        if (dec.dataSource.isImport && !settings.obj.executeWhenImported) continue;
        // skip if auto=false unless explicitly overridden (e.g. `varlock typegen`)
        if (settings.obj.auto === false && !opts?.ignoreAutoFalse) continue;

        if (!settings.obj.path) throw new Error(`@${decoratorName} - must set \`path\` arg`);
        if (!_.isString(settings.obj.path)) throw new Error(`@${decoratorName} - \`path\` arg must be a string`);

        const sourceDir = dec.dataSource instanceof FileBasedDataSource
          ? path.resolve(dec.dataSource.fullPath, '..')
          : process.cwd();
        const outputPath = dec.dataSource instanceof FileBasedDataSource
          ? path.resolve(sourceDir, settings.obj.path)
          : settings.obj.path;

        items ||= await collectTypeGenItems(this);
        fields ||= resolveFieldTypes(items);

        const src = await generator.generate({
          graph: this,
          fields,
          options: settings.obj,
          outputPath,
          sourceDir,
        });
        await fs.promises.writeFile(outputPath, src, 'utf-8');
        generatedCount++;
      }
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
