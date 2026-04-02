import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import _ from '@env-spec/utils/my-dash';
import { tryCatch } from '@env-spec/utils/try-catch';
import {
  ParsedEnvSpecDecorator, ParsedEnvSpecDecoratorComment, ParsedEnvSpecFile,
  ParsedEnvSpecFunctionCall, ParsedEnvSpecStaticValue, parseEnvSpecDotEnvFile,
} from '@env-spec/parser';

import { ConfigItem, type ConfigItemDef } from './config-item';
import { EnvGraph } from './env-graph';

import { ParseError, SchemaError } from './errors';
import { pathExists } from '@env-spec/utils/fs-utils';
import { processPluginInstallDecorators } from './plugins';
import { RootDecoratorInstance } from './decorators';
import { isBuiltinVar } from './builtin-vars';
import { fetchPublicSchema } from '../../lib/schema-cache';
import { resolvePluginSchema } from './plugin-schema';

const DATA_SOURCE_TYPES = Object.freeze({
  schema: {
    fileSuffixes: ['schema'],
  },
  example: {
    fileSuffixes: ['sample', 'example'],
  },
  defaults: {
    fileSuffixes: ['default', 'defaults'],
  },
  values: {
    fileSuffixes: [] as Array<string>,
  },
  overrides: {
    fileSuffixes: ['local', 'override'],
  },
  container: {
  },
});
type DataSourceType = keyof typeof DATA_SOURCE_TYPES;

export abstract class EnvGraphDataSource {
  static DATA_SOURCE_TYPES = DATA_SOURCE_TYPES;

  /** reference back to the graph */
  graph?: EnvGraph;
  /** parent data source - everything except the root will have a parent */
  parent?: EnvGraphDataSource;
  /** child data sources */
  children: Array<EnvGraphDataSource> = [];

  /**
   * tracks if this data source was imported, and additional settings about the import (restricting keys)
   * */
  importMeta?: {
    isImport?: boolean,
    importKeys?: Array<string>,
    /** true when the @import had a non-static `enabled` parameter (e.g. `enabled=forEnv("dev")`) */
    isConditionallyEnabled?: boolean,
    /** true when the source was imported from a remote protocol (public-schemas:, plugin-schema:) */
    isRemoteImport?: boolean,
  };
  get isImport(): boolean {
    return !!this.importMeta?.isImport || !!this.parent?.isImport;
  }
  /** true if this data source (or any ancestor) was imported from a remote protocol */
  get isRemoteImport(): boolean {
    return !!this.importMeta?.isRemoteImport || !!this.parent?.isRemoteImport;
  }
  get isPartialImport() {
    return (this.importKeys || []).length > 0;
  }
  get importKeys(): Array<string> | undefined {
    const importKeysArrays = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let currentSource: EnvGraphDataSource | undefined = this;
    while (currentSource) {
      if (currentSource.importMeta?.importKeys && currentSource.importMeta.importKeys.length) {
        importKeysArrays.push(currentSource.importMeta.importKeys);
      }
      currentSource = currentSource.parent;
    }

    // in most cases we import all keys, but if there have been specific keys imported we walk up the chain
    if (importKeysArrays.length) {
      const keysToImport = _.intersection(...importKeysArrays);
      return keysToImport;
    }
  }

  /** shared child-setup logic: wire up parent/graph refs, finishInit (but no import processing) */
  protected async _initChild(child: EnvGraphDataSource, importMeta?: EnvGraphDataSource['importMeta']) {
    if (!this.graph) throw new Error('expected graph to be set');
    this.children.unshift(child);
    child.parent = this;
    child.graph = this.graph;
    if (importMeta) child.importMeta = importMeta;
    await child.finishInit();
  }

  /** adds a child data source, running both finishInit and import processing */
  async addChild(child: EnvGraphDataSource, importMeta?: EnvGraphDataSource['importMeta']) {
    await this._initChild(child, importMeta);
    await child._processImports();
  }

  /**
   * Whether this data source is environment-specific.
   * A source is env-specific if:
   * - it was auto-loaded for a specific env (e.g., `.env.production` loaded by a DirectoryDataSource)
   * - it has a conditional `@disable` decorator (e.g., `@disable=forEnv(test)`)
   * - it was conditionally imported (e.g., `@import(..., enabled=forEnv("dev"))`)
   * - any of its ancestors are env-specific
   * Used by type generation to filter out env-dependent definitions.
   *
   * Note: `applyForEnv` from filename parsing is only relevant for auto-loaded files.
   * Explicitly imported files (via `@import`) are controlled by the import mechanism,
   * not the auto-load-by-env logic, so their `applyForEnv` is ignored here.
   */
  get isEnvSpecific(): boolean {
    if (this.applyForEnv && !this.isImport) return true;
    if (this.type === 'overrides') return true;
    if (this._hasConditionalDisable) return true;
    if (this.importMeta?.isConditionallyEnabled) return true;
    if (this.parent?.isEnvSpecific) return true;
    return false;
  }

  /** true when the source has a `@disable` decorator whose value is not static */
  _hasConditionalDisable?: boolean;

  /** environment flag key (as set by @envFlag decorator) - only if set within this source */
  _envFlagKey?: string;
  /** environment flag key getter that will follow up the parent chain */
  get envFlagKey(): string | undefined {
    return this._envFlagKey || this.parent?.envFlagKey;
  }

  /** helper to set the current envFlag key, also propogating upwards */
  setEnvFlag(key: string) {
    this._envFlagKey = key;
    if (this.parent && !this.isPartialImport && !this.parent._envFlagKey) {
      this.parent.setEnvFlag(key);
    }
  }


  /** environment flag config item getter (follows up the parent chain) */
  get envFlagConfigItem(): ConfigItem | undefined {
    const envFlagKey = this.envFlagKey;
    return envFlagKey ? this.graph?.configSchema[envFlagKey] : undefined;
  }
  /** environment flag value getter (follows up the parent chain), and checks the graph-level fallback */
  get envFlagValue() {
    const envFlagItem = this.envFlagConfigItem;
    if (envFlagItem) return envFlagItem.resolvedValue;
    return this.graph!.envFlagFallback;
  }
  /** helper to resolve the envFlag value */
  async resolveCurrentEnv() {
    const envFlagItem = this.envFlagConfigItem;
    if (envFlagItem) {
      if (envFlagItem.resolvedValue) return envFlagItem.resolvedValue;
      await envFlagItem.earlyResolve();
      return envFlagItem.resolvedValue;
    }
    // fallback to the graph-level env flag - which can be set using a CLI flag
    // this is currently only used by Next.js integration to match the default behaviour
    // of setting dev/prod based on the current command (next dev/next build)
    return this.graph!.envFlagFallback;
  }

  /** finish init process for this data source */
  async finishInit() {
    if (!this.graph) throw new Error('expected graph to be set');

    // each child class can redefine this method to handle additional init code
    await this._finishInit();

    // we dont necessarily always want any loading error to fail the entire load
    // but for example if the main schema is failing and we dont know the envFlag
    // we don't know which env-specific sources to enable
    if (this.loadingError) {
      return;
    }

    // first we check @disable because we'll bail early
    // note that when using `forEnv` it will rely on the what has been set so far, not anything from _this_ source
    const disabledDec = this.getRootDec('disable');
    if (disabledDec) {
      // early resolve any dependencies needed by @disable condition (e.g. $AUTH_MODE in `not(eq($AUTH_MODE, "azure"))`)
      await disabledDec.process();
      if (disabledDec.decValueResolver) {
        for (const depKey of disabledDec.decValueResolver.deps) {
          const depItem = this.graph.configSchema[depKey];
          if (depItem) await depItem.earlyResolve();
        }
      }

      const disabledVal = await disabledDec.resolve();
      if (!_.isBoolean(disabledVal)) {
        this._loadingError = new Error('expected @disable to be boolean value');
        return;
      }
      this._disabled = disabledVal;
      // track if @disable is conditional (non-static value like forEnv) for type generation
      if (disabledDec.decValueResolver && !disabledDec.decValueResolver.isStatic) {
        this._hasConditionalDisable = true;
      }
    }

    // this will also respect if the parent is disabled
    if (this.disabled) return;

    // create config items, or add additional definitions if they already exist
    for (const itemKey of this.importKeys || _.keys(this.configItemDefs)) {
      const itemDef = this.configItemDefs[itemKey];
      if (!itemDef) continue;

      // check if this item was already early-resolved (used by @currentEnv, @import enabled, or @disable)
      // a later file setting a conflicting value would silently contradict the decision already made
      const existingItem = this.graph.configSchema[itemKey];
      if (existingItem?.isResolved && itemDef.parsedValue !== undefined) {
        // no value (just decorators or empty assignment) is fine — it won't override
        // a static value matching the early-resolved value is also fine
        const isMatchingStatic = itemDef.parsedValue instanceof ParsedEnvSpecStaticValue
          && itemDef.parsedValue.unescapedValue === existingItem.resolvedValue;
        if (!isMatchingStatic) {
          this._schemaErrors.push(new SchemaError(
            `"${itemKey}" was already resolved during early initialization (used by @currentEnv, @import, or @disable) `
            + `and cannot be redefined by ${this.label}`,
          ));
          continue;
        }
      }

      // register the existence of the item in the graph
      this.graph.configSchema[itemKey] ??= new ConfigItem(this.graph, itemKey);
    }

    // process @currentEnv decorator if present in this source
    // this requires a bit of special handling compared to other decorators
    // (note we also support @envFlag for backwards compatibility)
    const currentEnvDec = this.getRootDec('currentEnv');
    const envFlagDec = this.getRootDec('envFlag');
    if (currentEnvDec && envFlagDec) {
      // TODO can we set this in the decorator definition?
      this._loadingError = new Error('Cannot use both @currentEnv and @envFlag decorators');
    }
    let envFlagItemKey: string | undefined;
    let skipCurrentEnvProcessing = false;
    if (currentEnvDec) {
      // Peek at the ref target before processing to check if it's in the import keys
      // This avoids a schema error when a file import has @currentEnv pointing to an un-imported key
      // (for directories, we still want to error - that's handled in DirectoryDataSource._finishInit)
      const parsedValue = currentEnvDec.parsedDecorator.value;
      if (parsedValue instanceof ParsedEnvSpecFunctionCall && parsedValue.name === 'ref') {
        const args = parsedValue.simplifiedArgs;
        if (Array.isArray(args) && args.length > 0 && typeof args[0] === 'string') {
          envFlagItemKey = args[0];
          // If this is a partial import and the ref target is not importable, skip processing
          // but still set the envFlagKey so directories can check it
          // For files, @currentEnv won't take effect and forEnv will fall back to parent's env setting
          if (this.isPartialImport && !this.importKeys?.includes(envFlagItemKey)) {
            skipCurrentEnvProcessing = true;
          }
        }
      }

      // Only process the decorator if we're actually using this currentEnv
      if (!skipCurrentEnvProcessing) {
        await currentEnvDec.process();
        if (!currentEnvDec.decValueResolver) {
          throw new Error('No resolver found for @currentEnv decorator');
        }
        if (currentEnvDec.decValueResolver.fnName !== 'ref') {
          throw new Error('Expected @currentEnv decorator to be set to direct reference - ie `$APP_ENV`');
        }
      }
    } else if (envFlagDec) {
      await envFlagDec.process();
      if (!envFlagDec.decValueResolver) throw new Error('@envFlag resolver not set');

      if (!envFlagDec.decValueResolver.staticValue) {
        throw new Error('Expected @envFlag decorator to be static value');
      }
      envFlagItemKey = String(envFlagDec.decValueResolver.staticValue);
    }

    if (envFlagItemKey) {
      if (!this.configItemDefs[envFlagItemKey] && !isBuiltinVar(envFlagItemKey)) {
        this._loadingError = new Error(`environment flag "${envFlagItemKey}" must be defined within this schema`);
        return;
      }

      // If it's a builtin var, register it now
      if (isBuiltinVar(envFlagItemKey)) {
        this.graph.registerBuiltinVar(envFlagItemKey);
      }

      // Always set the envFlagKey so parent directories can check it
      // (even if we're skipping processing for a file partial import)
      this.setEnvFlag(envFlagItemKey);
    }

    // defaultSensitive and defaultRequired are needed to do any early resolution of items
    const defaultSensitiveDec = this.getRootDec('defaultSensitive');
    await defaultSensitiveDec?.process();
    const defaultRequiredDec = this.getRootDec('defaultRequired');
    await defaultRequiredDec?.process();

    // Security: remotely imported files cannot install plugins
    if (this.isRemoteImport) {
      const pluginDecs = this.getRootDecFns('plugin');
      if (pluginDecs.length) {
        this._loadingError = new Error('Remotely imported schemas cannot install plugins (@plugin is not allowed)');
        return;
      }
    } else {
      await processPluginInstallDecorators(this);
    }
  }

  /**
   * Process @import decorators for this data source.
   * Separated from finishInit() so that DirectoryDataSource can load all
   * auto-loaded files first, then process imports once values from
   * .env, .env.local, etc. are available for import conditions.
   */
  async _processImports() {
    if (!this.graph) throw new Error('expected graph to be set');
    if (!this.isValid || this.disabled) return;

    const importDecs = this.getRootDecFns('import');
    if (importDecs.length) {
      for (const importDec of importDecs) {
        try {
          // Process the import decorator to identify dependencies
          await importDec.process();

          // Early resolve any dependencies in the enabled parameter
          if (importDec.decValueResolver?.objArgs?.enabled) {
            const enabledResolver = importDec.decValueResolver.objArgs.enabled;
            const enabledDeps = enabledResolver.deps;

            // Early resolve all dependencies
            for (const depKey of enabledDeps) {
              const depItem = this.graph.configSchema[depKey];
              if (!depItem) {
                throw new Error(`@import enabled parameter depends on non-existent item: ${depKey}`);
              }
              await depItem.earlyResolve();
            }
          }

          const importArgs = await importDec.resolve();
          const importPath = importArgs.arr[0];
          const importKeys = importArgs.arr.slice(1);
          if (!importKeys.every(_.isString)) {
            throw new Error('expected @import keys to all be strings');
          }

          // determine the full import path based on path type
          let fullImportPath: string | undefined;
          if (importPath.startsWith('./') || importPath.startsWith('../')) {
            // Security: remote imports cannot access local files
            if (this.isRemoteImport) {
              throw new Error('Remotely imported schemas cannot use local file imports');
            }
            // eslint-disable-next-line no-use-before-define
            if (!(this instanceof FileBasedDataSource)) {
              throw new Error('@import of files can only be used from a file-based data source');
            }
            fullImportPath = path.resolve(this.fullPath, '..', importPath);
          } else if (importPath.startsWith('~/') || importPath === '~') {
            // Security: remote imports cannot access local files
            if (this.isRemoteImport) {
              throw new Error('Remotely imported schemas cannot use local file imports');
            }
            // expand ~ to home directory (treat like absolute path)
            fullImportPath = path.join(os.homedir(), importPath.slice(1));
          } else if (importPath.startsWith('/')) {
            // Security: remote imports cannot access local files
            if (this.isRemoteImport) {
              throw new Error('Remotely imported schemas cannot use local file imports');
            }
            // absolute path
            fullImportPath = importPath;
          }

          // Check if the import is enabled/disabled using key-val option (defaults to true if not specified)
          const enabledValue = importArgs.obj.enabled ?? true;
          if (!_.isBoolean(enabledValue)) {
            throw new Error('expected @import enabled parameter to be a boolean');
          }

          // Skip this import if it's not enabled
          if (!enabledValue) continue;

          // Track if this import was conditionally enabled (non-static enabled resolver)
          // Used by type generation to identify env-dependent sources
          const enabledResolver = importDec.decValueResolver?.objArgs?.enabled;
          const isConditionallyEnabled = !!enabledResolver && !enabledResolver.isStatic;

          // Check if missing imports should be allowed (defaults to false if not specified)
          const allowMissing = importArgs.obj.allowMissing ?? false;
          if (!_.isBoolean(allowMissing)) {
            throw new Error('expected @import allowMissing parameter to be a boolean');
          }

          if (fullImportPath) {
            const fileName = path.basename(fullImportPath);

            // TODO: might be nice to move this logic somewhere else
            if (this.graph.virtualImports) {
              if (importPath.endsWith('/')) {
                const dirExists = Object.keys(this.graph.virtualImports).some((p) => p.startsWith(fullImportPath));
                if (!dirExists && allowMissing) continue;
                if (!dirExists) {
                  this._loadingError = new Error(`Virtual directory import ${fullImportPath} not found`);
                  return;
                }
                // eslint-disable-next-line no-use-before-define
                await this.addChild(new DirectoryDataSource(fullImportPath), {
                  isImport: true, importKeys, isConditionallyEnabled,
                });
              } else {
                const fileExists = this.graph.virtualImports[fullImportPath];
                if (!fileExists && allowMissing) continue;
                if (!fileExists) {
                  this._loadingError = new Error(`Virtual import ${fullImportPath} not found`);
                  return;
                }
                // eslint-disable-next-line no-use-before-define
                const source = new DotEnvFileDataSource(fullImportPath, {
                  overrideContents: this.graph.virtualImports[fullImportPath],
                });
                await this.addChild(source, { isImport: true, importKeys, isConditionallyEnabled });
              }
            } else {
              const fsStat = await tryCatch(async () => fs.stat(fullImportPath), (_err) => {
                // TODO: work through possible error types here
              });

              if (!fsStat && allowMissing) continue;
              if (!fsStat) {
                this._loadingError = new Error(`Import path does not exist: ${fullImportPath}`);
                return;
              }

              // directory import -- must end with a "/" to make the intent clearer
              if (importPath.endsWith('/')) {
                if (fsStat.isDirectory()) {
                  // eslint-disable-next-line no-use-before-define
                  await this.addChild(new DirectoryDataSource(fullImportPath), {
                    isImport: true, importKeys, isConditionallyEnabled,
                  });
                } else {
                  this._loadingError = new Error(`Imported path ending with "/" is not a directory: ${fullImportPath}`);
                  return;
                }
              // File import
              } else {
                if (fsStat.isDirectory()) {
                  this._loadingError = new Error('Imported path is a directory, add trailing "/" to import');
                  return;
                } else if (!fileName.startsWith('.env.')) {
                  this._loadingError = new Error('imported file must be a .env.* file');
                  return;
                }
                // TODO: once we have more file types, here we would detect the type and import it correctly
                // eslint-disable-next-line no-use-before-define
                await this.addChild(new DotEnvFileDataSource(fullImportPath), {
                  isImport: true, importKeys, isConditionallyEnabled,
                });
              }
            }
          } else if (importPath.startsWith('public-schemas:')) {
            // Remote import from official varlock public schemas
            const schemaPath = importPath.slice('public-schemas:'.length);
            if (!schemaPath || schemaPath.includes('..')) {
              this._loadingError = new Error(`Invalid public schema path: ${schemaPath}`);
              return;
            }
            try {
              const contents = await fetchPublicSchema(schemaPath);
              // Sanitize the schema path for use as a synthetic filename
              const safeName = schemaPath.replace(/[^a-zA-Z0-9_-]/g, '-');
              const syntheticPath = `.env.public-schema-${safeName}`;
              // eslint-disable-next-line no-use-before-define
              const source = new DotEnvFileDataSource(syntheticPath, { overrideContents: contents });
              await this.addChild(source, {
                isImport: true, importKeys, isConditionallyEnabled, isRemoteImport: true,
              });
            } catch (fetchErr) {
              if (allowMissing) continue;
              this._loadingError = new Error(`Failed to fetch public schema "${schemaPath}": ${(fetchErr as Error).message}`);
              return;
            }
          } else if (importPath.startsWith('plugin-schema:')) {
            // Import schema from an installed plugin package
            const pluginName = importPath.slice('plugin-schema:'.length);
            if (!pluginName) {
              this._loadingError = new Error('plugin-schema: import must specify a plugin name');
              return;
            }
            try {
              // eslint-disable-next-line no-use-before-define
              const fileSource = this instanceof FileBasedDataSource ? this : undefined;
              const schemaSource = await resolvePluginSchema(pluginName, fileSource);
              if (!schemaSource) {
                if (allowMissing) continue;
                this._loadingError = new Error(`Plugin "${pluginName}" does not expose a schema file`);
                return;
              }
              await this.addChild(schemaSource, {
                isImport: true, importKeys, isConditionallyEnabled, isRemoteImport: true,
              });
            } catch (pluginErr) {
              if (allowMissing) continue;
              this._loadingError = new Error(`Failed to resolve plugin schema "${pluginName}": ${(pluginErr as Error).message}`);
              return;
            }
          } else if (importPath.startsWith('http://') || importPath.startsWith('https://')) {
            this._loadingError = new Error('http imports not supported yet');
            return;
          } else if (importPath.startsWith('npm:')) {
            this._loadingError = new Error('npm imports not supported yet');
            return;
          } else {
            this._loadingError = new Error('unsupported import type');
            return;
          }
        } catch (err) {
          this._loadingError = err as Error;
          return;
        }
      }
    }
  }

  /**
   * called by the finishInit - meant to be overridden by subclasses
   * to add specific behaviour for that data source type
   * @internal
   * */
  async _finishInit() {
    // override me!
  }

  abstract typeLabel: string;
  abstract get label(): string;

  type = 'values' as DataSourceType;
  applyForEnv?: string;

  _disabled?: boolean = false;
  get disabled() {
    return this._disabled || this.parent?._disabled;
  }

  /** an error encountered while loading/parsing the data source */
  _loadingError?: Error;
  get loadingError() {
    if (this._loadingError) return this._loadingError;

    // Check if any plugins loaded by this data source have errors
    if (this.graph) {
      for (const plugin of this.graph.plugins) {
        if (plugin.loadingError) {
          // Check if this plugin was installed by this data source
          for (const installDecorator of plugin.installDecoratorInstances) {
            if (installDecorator.dataSource === this) {
              return plugin.loadingError;
            }
          }
        }
      }
    }

    return undefined;
  }
  _schemaErrors: Array<SchemaError> = [];
  get schemaErrors() {
    return _.compact([
      ...this._schemaErrors,
      ...this.rootDecorators.flatMap((d) => d.schemaErrors),
    ]);
  }

  get resolutionErrors() {
    return _.compact([...this.rootDecorators.flatMap((d) => d._executionError)]);
  }

  get isValid() {
    return !this.loadingError && !this.schemaErrors.some((e) => !e.isWarning) && !this.resolutionErrors.length;
  }

  configItemDefs: Record<string, ConfigItemDef> = {};
  decorators: Array<ParsedEnvSpecDecorator> = [];
  getRootDecorators(decName: string) {
    return this.decorators.filter((d) => d.name === decName);
  }
  getRootDecoratorSimpleValue(decName: string) {
    const decorators = this.getRootDecorators(decName);
    if (decorators.length === 0) return undefined;
    if (decorators.length > 1) throw new Error(`Multiple ${decName} decorators found`);
    return decorators[0].simplifiedValue;
  }


  rootDecorators: Array<RootDecoratorInstance> = [];
  getRootDec(decName: string) {
    return this.rootDecorators.find((d) => d.name === decName && !d.isFunctionCall);
  }
  getRootDecFns(decName: string) {
    return this.rootDecorators.filter((d) => d.name === decName && d.isFunctionCall);
  }
}

export abstract class FileBasedDataSource extends EnvGraphDataSource {
  fullPath: string;
  fileName: string;
  rawContents?: string;

  get typeLabel() {
    return (this.constructor as typeof FileBasedDataSource).format;
  }

  private relativePath: string;
  get label() { return this.relativePath; }

  static format = 'unknown'; // no abstract static

  static validFileExtensions: Array<string> = [];
  get validFileExtensions() {
    return (this.constructor as typeof FileBasedDataSource).validFileExtensions;
  }

  constructor(
    fullPath: string,
    opts?: {
      overrideContents?: string;
    },
  ) {
    super();

    this.fullPath = fullPath;
    this.fileName = path.basename(fullPath);
    this.relativePath = path.relative(process.cwd(), fullPath);

    // easy way to allow tests to override contents or other non-standard ways of loading content
    if (opts?.overrideContents) {
      this.rawContents = opts.overrideContents;
    }

    // may may infer some properties from the file name
    if (this.fileName.startsWith('.env')) {
      // we'll break up the filename into parts to detect some info
      // note that a file can have several parts - for example `.env.production.local`
      const fileNameParts = this.fileName.substring(1).split('.');
      const maybeExtension = fileNameParts[fileNameParts.length - 1];
      if (this.validFileExtensions.includes(maybeExtension)) {
        fileNameParts.pop(); // remove the extension
      }

      const maybeFileType = fileNameParts[fileNameParts.length - 1];
      for (const [possibleSourceType, possibleSourceSpec] of Object.entries(DATA_SOURCE_TYPES)) {
        if (!('fileSuffixes' in possibleSourceSpec)) continue;
        if (possibleSourceSpec.fileSuffixes.includes(maybeFileType)) {
          this.type = possibleSourceType as DataSourceType;
          break;
        }
      }
      // default is already set to 'values', so we pop the last part if sometihng different
      if (this.type !== 'values') fileNameParts.pop(); // remove the type suffix

      // check for a specific env (ex: .env[.production])
      // ? do we want to disallow env qualifier for certain file types?
      // ? ex: .env.production.defaults
      if (fileNameParts.length > 2) {
        throw Error(`Unsure how to interpret filename - ${this.fileName}`);
      } else if (fileNameParts.length === 2) {
        this.applyForEnv = fileNameParts[1];
      }
    }
  }

  // no async constructors... :(
  async _finishInit() {
    if (!this.rawContents) {
      if (!await pathExists(this.fullPath)) {
        this._loadingError = new Error(`File does not exist: ${this.fullPath}`);
        return;
      }
      this.rawContents = await fs.readFile(this.fullPath, 'utf8');
    }
    if (this.rawContents) await this._parseContents();
  }
  abstract _parseContents(): Promise<void>;
}

export class DotEnvFileDataSource extends FileBasedDataSource {
  static format = '.env';
  static validFileExtensions = []; // no extension for dotenv files!

  parsedFile?: ParsedEnvSpecFile;

  async _parseContents() {
    const rawContents = this.rawContents!;

    this.parsedFile = await tryCatch(
      () => parseEnvSpecDotEnvFile(rawContents),
      (error) => {
        this._loadingError = new ParseError(`Parse error: ${error.message}`, {
          location: {
            id: this.fullPath,
            lineNumber: error.location.start.line,
            colNumber: error.location.start.column,
            lineStr: rawContents.split('\n')[error.location.start.line - 1],
          },
        });
        // TODO: figure out cause vs passing in as `err` param
        this._loadingError.cause = error;
      },
    );

    if (this.loadingError) return;
    if (!this.parsedFile) throw new Error('Failed to parse .env file');

    if (!this.graph) throw new Error('expected graph to be set');

    this.rootDecorators = this.parsedFile.decoratorsArray.map((d) => new RootDecoratorInstance(this, d));

    // validate decorator placement
    this._validateDecoratorPlacement(this.parsedFile);

    for (const item of this.parsedFile.configItems) {
      this.configItemDefs[item.key] = {
        description: item.description,
        parsedValue: item.value,
        parsedDecorators: item.decoratorsArray,
      };
    }
  }

  private _validateDecoratorPlacement(parsedFile: ParsedEnvSpecFile) {
    // check for item decorators in the header, and duplicate non-fn root decorators
    const seenRootDecs = new Set<string>();
    for (const dec of parsedFile.decoratorsArray) {
      if (dec.name in this.graph!.itemDecoratorsRegistry) {
        this._schemaErrors.push(new SchemaError(
          `Item decorator @${dec.name} cannot be used in the file header - it must be attached to a config item`,
          { location: this._locationFromParsed(dec) },
        ));
      } else if (!dec.isBareFnCall) {
        if (seenRootDecs.has(dec.name)) {
          this._schemaErrors.push(new SchemaError(
            `Root decorator @${dec.name} cannot be used more than once in the same file`,
            { location: this._locationFromParsed(dec) },
          ));
        }
        seenRootDecs.add(dec.name);
      }
    }

    // NOTE: root decorators attached to config items are caught during
    // DecoratorInstance.process() which gives a clear error on the individual item

    // check for any decorators in orphan comment blocks (not header, not attached to items)
    for (const block of parsedFile.orphanCommentBlocks) {
      for (const comment of block.comments) {
        if (comment instanceof ParsedEnvSpecDecoratorComment) {
          for (const dec of comment.decorators) {
            this._schemaErrors.push(new SchemaError(
              `Decorator @${dec.name} is in a detached comment block - decorators must be in the file header or attached directly to a config item (no blank lines between the decorator and the item)`,
              { location: this._locationFromParsed(dec) },
            ));
          }
        }
      }
    }
  }

  private _locationFromParsed(dec: ParsedEnvSpecDecorator) {
    const loc = dec.data._location;
    if (!loc || !this.rawContents) return undefined;
    return {
      id: this.fullPath,
      lineNumber: loc.start.line,
      colNumber: loc.start.column,
      lineStr: this.rawContents.split('\n')[loc.start.line - 1] || '',
    };
  }
}

/**
 * Handles a directory as a source, automatically importing .env files from that directory
 * This is usually the root in most cases, but additional directories can also be imported
 *
 * This will load the following files (if they exist), in precedence order
 * - .env.schema
 * - .env
 * - .env.local
 * - .env.ENV
 * - .env.ENV.local
 *
 * where ENV represents the current value of the environment flag (e.g. development,staging,etc)
 */
export class DirectoryDataSource extends EnvGraphDataSource {
  type = 'container' as const;
  typeLabel = 'directory';
  get label() { return `directory - ${this.basePath}`; }

  schemaDataSource?: DotEnvFileDataSource;

  constructor(
    readonly basePath: string,
  ) {
    super();
  }

  /** load a file as a child, running finishInit but NOT processing imports yet */
  private async addAutoLoadedFile(fileName: string) {
    if (!this.graph) throw new Error('expected graph to be set');
    const filePath = path.join(this.basePath, fileName);

    if (this.graph.virtualImports) {
      if (this.graph.virtualImports[filePath]) {
        const source = new DotEnvFileDataSource(filePath, { overrideContents: this.graph.virtualImports[filePath] });
        await this._addChildWithoutImports(source);
        return source;
      }
      return;
    }

    if (!await pathExists(filePath)) return;
    const source = new DotEnvFileDataSource(filePath);
    await this._addChildWithoutImports(source);
    return source;
  }

  /** like addChild but skips import processing — used so all files can be loaded before imports run */
  private async _addChildWithoutImports(child: EnvGraphDataSource) {
    await this._initChild(child);
  }

  /** resolve currentEnv from schema's envFlagKey or parent chain */
  private async _resolveCurrentEnv(): Promise<string | undefined> {
    if (!this.graph) throw new Error('expected graph to be set');

    // First check if our schema has its own envFlagKey (for partial imports with their own currentEnv)
    // since for partial imports the schema's envFlag doesn't propagate to this directory
    if (this.schemaDataSource?._envFlagKey) {
      const envFlagKey = this.schemaDataSource._envFlagKey;
      // Check if this is a partial import that forgot to include the env flag key
      // (only for directories - files can fall back to parent's env setting for forEnv)
      if (this.isPartialImport && !this.importKeys?.includes(envFlagKey)) {
        this._loadingError = new Error(
          `Imported directory has @currentEnv set to $${envFlagKey}, `
          + `but "${envFlagKey}" is not included in the import list. `
          + `Add "${envFlagKey}" to the @import() arguments.`,
        );
        return undefined;
      }
      const envFlagItem = this.graph.configSchema[envFlagKey];
      if (envFlagItem) {
        if (!envFlagItem.resolvedValue) await envFlagItem.earlyResolve();
        return envFlagItem.resolvedValue?.toString();
      }
    }
    // Fall back to parent chain or fallback value
    return (await this.resolveCurrentEnv())?.toString() || this.envFlagValue?.toString();
  }

  /** load env-specific files (.env.ENV and .env.ENV.local) for the given environment */
  private async _loadEnvSpecificFiles(currentEnv: string) {
    const sources: Array<DotEnvFileDataSource> = [];
    const s1 = await this.addAutoLoadedFile(`.env.${currentEnv}`);
    if (s1) sources.push(s1);
    const s2 = await this.addAutoLoadedFile(`.env.${currentEnv}.local`);
    if (s2) sources.push(s2);
    return sources;
  }

  async _finishInit() {
    if (!this.graph) throw new Error('expected graph to be set');

    // Load all auto-loaded files WITHOUT processing imports yet.
    // This ensures values from .env, .env.local, etc. are registered before
    // import conditions (enabled=...) and imported file @disable are evaluated.
    await this.addAutoLoadedFile('.env.schema');
    await this.addAutoLoadedFile('.env');

    // .env.schema is usually the "schema data source" but this allows for a single .env file being the main source
    if (this.children.length) {
      this.schemaDataSource = this.children[this.children.length - 1] as DotEnvFileDataSource;
    }

    await this.addAutoLoadedFile('.env.local');

    // Resolve currentEnv from schema's own @currentEnv (set during finishInit, not during imports)
    let currentEnv = await this._resolveCurrentEnv();
    if (this._loadingError) return;

    if (currentEnv) {
      await this._loadEnvSpecificFiles(currentEnv);
    }

    // Now that all auto-loaded files are registered, process imports.
    // Reverse order = oldest child first (add order), so earlier files' imports run first.
    for (const child of [...this.children].reverse()) {
      await child._processImports();
    }

    // An import may have set @currentEnv (e.g. an imported file with @currentEnv=$VAR).
    // If we didn't load env-specific files above, check again now and process their imports too.
    if (!currentEnv) {
      currentEnv = await this._resolveCurrentEnv();
      if (this._loadingError) return;
      if (currentEnv) {
        const envSources = await this._loadEnvSpecificFiles(currentEnv);
        for (const source of envSources) {
          await source._processImports();
        }
      }
    }
  }
}
