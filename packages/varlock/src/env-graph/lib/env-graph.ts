import _ from '@env-spec/utils/my-dash';
import path from 'node:path';
import { ConfigItem } from './config-item';
import {
  EnvGraphDataSource, FileBasedDataSource, ImportAliasSource,
  keyPassesImportFilter,
} from './data-source';
import { type KeyFilter } from './key-filter';

import { BaseResolvers, createResolver, type ResolverChildClass } from './resolver';
import { BaseDataTypes, type EnvGraphDataTypeFactory } from './data-types';
import { findGraphCycles, getTransitiveDeps, type GraphAdjacencyList } from './graph-utils';
import { ResolutionError, SchemaError } from './errors';
import { generateTypes } from './type-generation';

import {
  builtInItemDecorators, builtInRootDecorators,
  RootDecoratorInstance,
  type ItemDecoratorDef,
  type RootDecoratorDef,
} from './decorators';
import { getErrorLocation } from './error-location';
import type { VarlockPlugin } from './plugins';
import { runWithResolutionContext, getResolutionContext } from './resolution-context';
import { getCiEnv, type CiEnvInfo } from '@varlock/ci-env-info';
import { BUILTIN_VARS, isBuiltinVar } from './builtin-vars';
import { isVarlockReservedKey } from './reserved-vars';
import { buildOverrideProvenanceMetadata, type OverrideProvenanceMetadata } from '../../lib/injected-env-provenance';
import { generateProxyPlaceholderForItem } from '../../proxy/placeholder';
import {
  PROXY_APPROVAL_EACH_VALUES,
  type ProxyApprovalEach, type ProxyEgressMode, type ProxyManagedItem, type ProxyRule,
} from '../../proxy/types';
import { parseDuration } from '../../lib/duration';

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
    proxyEgress?: ProxyEgressMode;
    /** `@proxyConfig={reload=...}` posture; the proxy resolves `auto` at launch. */
    proxyReload?: 'off' | 'manual' | 'auto';
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

/**
 * Per-item directive applied during resolution inside a proxy-child context:
 * substitute a placeholder for the (sensitive) value, or omit it entirely.
 */
export type ProxyResolutionView = Record<
  string,
  { kind: 'placeholder'; value: string } | { kind: 'omit' }
>;

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

  /**
   * Proxy-child resolution view: when a graph is loaded inside a `varlock proxy`
   * session, each sensitive item is forced to a placeholder (or omitted) at
   * resolution time so re-resolving the schema can never surface the real value.
   * Set by `load-graph` from the active session's record. The real values were
   * already validated by the proxy daemon, so these short-circuit coerce/validate
   * and the required check. Empty/undefined outside a proxied context.
   */
  proxyResolutionView?: ProxyResolutionView;

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
    await this.getRootDec('proxyConfig')?.resolve();
    await Promise.all(this.getRootDecFns('proxy').map(async (d) => d.resolve()));
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
    const proxyConfig = this.getRootDec('proxyConfig')?.resolvedValue;
    serializedGraph.settings.proxyEgress = proxyConfig?.egress === 'strict' ? 'strict' : 'permissive';
    // Store the raw reload posture (off/manual/auto); the proxy command resolves `auto`
    // at launch from context. Absent = undefined, and the command defaults it to `auto`.
    if (proxyConfig?.reload) serializedGraph.settings.proxyReload = proxyConfig.reload;

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

  /**
   * Normalize a `@proxy` list option (`domain`, `method`, `keys`) into a string
   * array. Accepts a single string (`domain="api.x.com"`) or an array literal
   * (`domain=[a.com, b.com]`); trims and drops empties.
   */
  private static normalizeStringList(value: unknown): Array<string> {
    const raw = Array.isArray(value) ? value : [value];
    return raw
      .filter((v): v is string => _.isString(v))
      .map((v) => v.trim())
      .filter(Boolean);
  }

  /**
   * Validate a *resolved* `@proxy(...)` arg object — catches misconfigurations
   * that only surface after dynamic resolution (where the static load-time
   * validator can't see the value). Fail loud rather than silently dropping a
   * security-relevant option (a dropped `block`/`approval` is a permissive rule).
   */
  private static validateResolvedProxyObj(obj: any): void {
    // Reject unknown options at resolve time too (the static load-time validator
    // doesn't fire for header/root @proxy decorators), so a typo like `blok=true`
    // fails loudly instead of silently producing a permissive rule. Entries that
    // reach the recursive call have already been filtered to the per-entry set.
    const validOptions = ['domain', 'path', 'method', 'keys', 'block', 'approval', 'rules'];
    for (const key of Object.keys(obj ?? {})) {
      if (!validOptions.includes(key)) {
        throw new SchemaError(`@proxy: unknown option "${key}". Valid options: ${validOptions.join(', ')}`);
      }
    }
    if (obj?.block !== undefined && !_.isBoolean(obj.block)) {
      throw new SchemaError(`@proxy: block must resolve to a boolean, got ${JSON.stringify(obj.block)}`);
    }
    if (obj?.path !== undefined && !_.isString(obj.path)) {
      throw new SchemaError(`@proxy: path must resolve to a string, got ${JSON.stringify(obj.path)}`);
    }
    // `approval` resolves to either a boolean or an options object `{enabled?, each?, maxDuration?}`.
    const approval = obj?.approval;
    if (approval !== undefined && !_.isBoolean(approval)) {
      if (!_.isPlainObject(approval)) {
        throw new SchemaError(`@proxy: approval must resolve to a boolean or an options object, got ${JSON.stringify(approval)}`);
      }
      for (const key of Object.keys(approval)) {
        if (!['enabled', 'each', 'maxDuration'].includes(key)) {
          throw new SchemaError(`@proxy: unknown approval option "${key}". Valid options: enabled, each, maxDuration`);
        }
      }
      if (approval.enabled !== undefined && !_.isBoolean(approval.enabled)) {
        throw new SchemaError(`@proxy: approval.enabled must resolve to a boolean, got ${JSON.stringify(approval.enabled)}`);
      }
      const eachOk = _.isString(approval.each)
        && PROXY_APPROVAL_EACH_VALUES.includes(approval.each as ProxyApprovalEach);
      if (approval.each !== undefined && !eachOk) {
        throw new SchemaError(`@proxy: approval.each must be one of ${PROXY_APPROVAL_EACH_VALUES.join(', ')}`);
      }
      if (approval.maxDuration !== undefined) {
        try {
          parseDuration(approval.maxDuration as string | number);
        } catch {
          throw new SchemaError('@proxy: approval.maxDuration must be a duration like "15m" or 0 (always ask)');
        }
      }
    }

    // `rules=[{...}]`: each entry is a policy refinement for the parent's domain.
    if (obj?.rules !== undefined) {
      if (!Array.isArray(obj.rules)) {
        throw new SchemaError(`@proxy: rules must be an array of rule objects, got ${JSON.stringify(obj.rules)}`);
      }
      for (const entry of obj.rules) {
        if (!_.isPlainObject(entry)) {
          throw new SchemaError(`@proxy: each rules entry must be an object, got ${JSON.stringify(entry)}`);
        }
        for (const key of Object.keys(entry)) {
          if (!['path', 'method', 'block', 'approval'].includes(key)) {
            throw new SchemaError(`@proxy: unknown option "${key}" in a rules entry. Valid entry options: path, method, block, approval (domain and keys are set on the parent @proxy)`);
          }
        }
        // reuse the per-option type checks for the entry (path/method/block/approval)
        EnvGraph.validateResolvedProxyObj(entry);
      }
    }
  }

  /**
   * Approval fields for a rule, from a resolved `@proxy(...)` arg object.
   * `approval` is a boolean (`approval=true`) or an options object
   * (`approval={each=..., maxDuration=...}`); the object form implies required
   * unless `enabled=false`. Assumes the object passed `validateResolvedProxyObj`.
   */
  private static buildProxyApprovalFields(obj: any): Partial<ProxyRule> {
    const approval = obj?.approval;
    let required = false;
    let each: ProxyApprovalEach | undefined;
    let maxDurationMs: number | undefined;

    if (_.isBoolean(approval)) {
      required = approval;
    } else if (_.isPlainObject(approval)) {
      required = approval.enabled !== false; // object form implies required unless explicitly disabled
      each = _.isString(approval.each) ? (approval.each as ProxyApprovalEach) : undefined;
      maxDurationMs = approval.maxDuration !== undefined
        ? parseDuration(approval.maxDuration as string | number)
        : undefined;
    }

    if (!required) return {};
    return {
      approval: {
        ...(each ? { each } : {}),
        ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
      },
    };
  }

  /** Build one runtime ProxyRule from a resolved `@proxy(...)` arg object (or a `rules` entry). */
  private static buildProxyRuleFromObj(obj: any, domain: Array<string>, itemKeys: Array<string>): ProxyRule {
    const method = EnvGraph.normalizeStringList(obj?.method);
    return {
      domain,
      itemKeys,
      ...(_.isString(obj?.path) ? { path: obj.path } : {}),
      ...(method.length ? { method } : {}),
      ...(_.isBoolean(obj?.block) ? { block: obj.block } : {}),
      ...EnvGraph.buildProxyApprovalFields(obj),
    };
  }

  /**
   * Expand a resolved `@proxy(...)` arg object into one or more runtime rules: the
   * parent rule (which carries injection via `itemKeys` and the parent's own
   * path/method/block) plus one policy-only rule per `rules=[{...}]` entry. Each
   * entry inherits `domain`, injects nothing (empty `itemKeys`), and refines via
   * precedence (block > require-approval > allow), so the domain is written once.
   */
  private static expandProxyRules(obj: any, domain: Array<string>, itemKeys: Array<string>): Array<ProxyRule> {
    const out: Array<ProxyRule> = [EnvGraph.buildProxyRuleFromObj(obj, domain, itemKeys)];
    if (Array.isArray(obj?.rules)) {
      for (const entry of obj.rules) {
        out.push(EnvGraph.buildProxyRuleFromObj(entry, domain, []));
      }
    }
    return out;
  }

  async getProxyRules(): Promise<Array<ProxyRule>> {
    const rules: Array<ProxyRule> = [];

    // detached rules from root-level @proxy(...)
    for (const rootProxyDec of this.getRootDecFns('proxy')) {
      const resolved = await rootProxyDec.resolve();
      EnvGraph.validateResolvedProxyObj(resolved?.obj);
      const domain = EnvGraph.normalizeStringList(resolved?.obj?.domain);
      if (domain.length === 0) continue;
      const itemKeys = EnvGraph.normalizeStringList(resolved?.obj?.keys);
      rules.push(...EnvGraph.expandProxyRules(resolved?.obj, domain, itemKeys));
    }

    // attached rules from item-level @proxy(...)
    for (const itemKey of this.sortedConfigKeys) {
      const item = this.configSchema[itemKey];
      for (const itemProxyDec of item.getDecFns('proxy')) {
        const resolved = await itemProxyDec.resolve();
        EnvGraph.validateResolvedProxyObj(resolved?.obj);
        const domain = EnvGraph.normalizeStringList(resolved?.obj?.domain);
        if (domain.length === 0) continue;
        const extraKeys = EnvGraph.normalizeStringList(resolved?.obj?.keys);
        const itemKeys = _.uniq([itemKey, ...extraKeys]);
        rules.push(...EnvGraph.expandProxyRules(resolved?.obj, domain, itemKeys));
      }
    }

    return rules;
  }

  async getProxyManagedItems(): Promise<Array<ProxyManagedItem>> {
    const rules = await this.getProxyRules();
    const managedKeys = _.uniq(rules.flatMap((r) => r.itemKeys));
    const managedItems: Array<ProxyManagedItem> = [];

    const usedPlaceholders = new Set<string>();
    for (const key of managedKeys) {
      const item = this.configSchema[key];
      if (!item) {
        throw new SchemaError(`@proxy references unknown item "${key}"`);
      }
      if (!_.isString(item.resolvedValue) || item.resolvedValue.length === 0) continue;

      const { placeholder, isGenericFallback } = await generateProxyPlaceholderForItem(item, usedPlaceholders);
      managedItems.push({
        key,
        placeholder,
        realValue: item.resolvedValue,
        ...(isGenericFallback ? { placeholderIsGenericFallback: true } : {}),
      });
    }

    return managedItems;
  }
}
