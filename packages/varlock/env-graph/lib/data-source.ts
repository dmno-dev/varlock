import fs from 'node:fs/promises';
import path from 'node:path';
import _ from '@env-spec/utils/my-dash';
import { tryCatch } from '@env-spec/utils/try-catch';
import { checkIsFileGitIgnored } from '@env-spec/utils/git-utils';
import {
  ParsedEnvSpecDecorator, ParsedEnvSpecFile, parseEnvSpecDotEnvFile,
} from '@env-spec/parser';

import { ConfigItem, type ConfigItemDef } from './config-item';
import { EnvGraph } from './env-graph';

import { SchemaError } from './errors';
import { pathExists } from '@env-spec/utils/fs-utils';
import { processPluginInstallDecorators } from './plugins';
import { RootDecoratorInstance } from './decorators';

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
  };
  get isImport(): boolean {
    return !!this.importMeta?.isImport || !!this.parent?.isImport;
  }
  get isPartialImport() {
    return (this.importMeta?.importKeys || []).length > 0;
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

  /** adds a child data source and sets up the correct references in both directions */
  async addChild(child: EnvGraphDataSource, importMeta?: EnvGraphDataSource['importMeta']) {
    if (!this.graph) throw new Error('expected graph to be set');
    this.children.unshift(child);
    child.parent = this;
    child.graph = this.graph;
    if (importMeta) child.importMeta = importMeta;
    await child.finishInit();
  }

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
      const disabledVal = await disabledDec.resolve();
      if (!_.isBoolean(disabledVal)) {
        this._loadingError = new Error('expected @disable to be boolean value');
        return;
      }
      this._disabled = disabledVal;
    }

    // this will also respect if the parent is disabled
    if (this.disabled) return;

    // create config items, or add additional definitions if they already exist
    for (const itemKey of this.importKeys || _.keys(this.configItemDefs)) {
      const itemDef = this.configItemDefs[itemKey];
      if (!itemDef) continue;
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
    if (currentEnvDec) {
      await currentEnvDec.process();
      if (!currentEnvDec.decValueResolver) {
        throw new Error('No resolver found for @currentEnv decorator');
      }
      if (currentEnvDec.decValueResolver.fnName !== 'ref') {
        throw new Error('Expected @currentEnv decorator to be set to direct reference - ie `$APP_ENV`');
      }
      const refArgValue = currentEnvDec.decValueResolver.arrArgs?.[0]?.staticValue;
      if (!refArgValue || !_.isString(refArgValue)) {
        throw new Error('@currentEnv ref must be set to a string');
      }
      envFlagItemKey = refArgValue;
    } else if (envFlagDec) {
      await envFlagDec.process();
      if (!envFlagDec.decValueResolver) throw new Error('@envFlag resolver not set');

      if (!envFlagDec.decValueResolver.staticValue) {
        throw new Error('Expected @envFlag decorator to be static value');
      }
      envFlagItemKey = String(envFlagDec.decValueResolver.staticValue);
    }

    if (envFlagItemKey) {
      if (!this.configItemDefs[envFlagItemKey]) {
        this._loadingError = new Error(`environment flag "${envFlagItemKey}" must be defined within this schema`);
        return;
      }
      this.setEnvFlag(envFlagItemKey);
    }

    // defaultSensitive and defaultRequired are needed to do any early resolution of items
    const defaultSensitiveDec = this.getRootDec('defaultSensitive');
    await defaultSensitiveDec?.process();
    const defaultRequiredDec = this.getRootDec('defaultRequired');
    await defaultRequiredDec?.process();

    await processPluginInstallDecorators(this);
    if (!this.isValid) return;

    // handle imports before we process config items
    // because the imported defs will be overridden by anything within this source
    const importDecs = this.getRootDecFns('import');
    if (importDecs.length) {
      for (const importDec of importDecs) {
        const importArgs = await importDec.resolve();
        const importPath = importArgs.arr[0];
        const importKeys = importArgs.arr.slice(1);
        if (!importKeys.every(_.isString)) {
          throw new Error('expected @import keys to all be strings');
        }

        if (importPath.startsWith('./') || importPath.startsWith('../')) {
          // eslint-disable-next-line no-use-before-define
          if (!(this instanceof FileBasedDataSource)) {
            throw new Error('@import of files can only be used from a file-based data source');
          }
          const fullImportPath = path.resolve(this.fullPath, '..', importPath);
          const fileName = path.basename(fullImportPath);

          // TODO: might be nice to move this logic somewhere else

          if (this.graph.virtualImports) {
            if (importPath.endsWith('/')) {
              if (!Object.keys(this.graph.virtualImports).some((p) => p.startsWith(fullImportPath))) {
                this._loadingError = new Error(`Virtual directory import ${fullImportPath} not found`);
                return;
              }
              // eslint-disable-next-line no-use-before-define
              await this.addChild(new DirectoryDataSource(fullImportPath), {
                isImport: true, importKeys,
              });
            } else {
              if (!this.graph.virtualImports[fullImportPath]) {
                this._loadingError = new Error(`Virtual import ${fullImportPath} not found`);
                return;
              }
              // eslint-disable-next-line no-use-before-define
              const source = new DotEnvFileDataSource(fullImportPath, {
                overrideContents: this.graph.virtualImports[fullImportPath],
              });
              await this.addChild(source, { isImport: true, importKeys });
            }
          } else {
            const fsStat = await tryCatch(async () => fs.stat(fullImportPath), (_err) => {
              // TODO: work through possible error types here
            });

            if (!fsStat) {
              this._loadingError = new Error(`Import path does not exist: ${fullImportPath}`);
              return;
            }

            // directory import -- must end with a "/" to make the intent clearer
            if (importPath.endsWith('/')) {
              if (fsStat.isDirectory()) {
                // eslint-disable-next-line no-use-before-define
                await this.addChild(new DirectoryDataSource(fullImportPath), {
                  isImport: true, importKeys,
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
              await this.addChild(new DotEnvFileDataSource(fullImportPath), { isImport: true, importKeys });
            }
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
    return this._loadingError;
    // || this.plugins?.find((p) => p.loadingError)?.loadingError;
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
    return !this.loadingError && !this.schemaErrors.length && !this.resolutionErrors.length;
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


export class EnvSourceParseError extends Error {
  location: {
    path: string,
    lineNumber: number,
    colNumber: number,
    lineStr: string,
  };

  constructor(
    message: string,
    _location: EnvSourceParseError['location'],
  ) {
    super(message);
    this.location = _location;
  }
}

export abstract class FileBasedDataSource extends EnvGraphDataSource {
  isGitIgnored?: boolean;
  fullPath: string;
  fileName: string;
  rawContents?: string;

  get typeLabel() {
    return (this.constructor as typeof FileBasedDataSource).format;
  }

  get label() { return this.fileName; }

  static format = 'unknown'; // no abstract static

  static validFileExtensions: Array<string> = [];
  get validFileExtensions() {
    return (this.constructor as typeof FileBasedDataSource).validFileExtensions;
  }

  constructor(
    fullPath: string,
    opts?: {
      overrideContents?: string;
      overrideGitIgnored?: boolean;
    },
  ) {
    super();

    this.fullPath = fullPath;
    this.fileName = path.basename(fullPath);

    // easy way to allow tests to override contents or other non-standard ways of loading content
    if (opts?.overrideContents) {
      this.rawContents = opts.overrideContents;
      this.isGitIgnored = opts.overrideGitIgnored;
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
      // TODO: check perf on exec based check, possibly switch to `ignored` package
      this.isGitIgnored = await checkIsFileGitIgnored(this.fullPath);
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
        this._loadingError = new EnvSourceParseError(error.message, {
          path: this.fullPath,
          lineNumber: error.location.start.line,
          colNumber: error.location.start.column,
          lineStr: rawContents.split('\n')[error.location.start.line - 1],
        });
        this._loadingError.cause = error;
      },
    );

    if (this.loadingError) return;
    if (!this.parsedFile) throw new Error('Failed to parse .env file');

    if (!this.graph) throw new Error('expected graph to be set');

    this.rootDecorators = this.parsedFile.decoratorsArray.map((d) => new RootDecoratorInstance(this, d));

    for (const item of this.parsedFile.configItems) {
      this.configItemDefs[item.key] = {
        description: item.description,
        parsedValue: item.value,
        parsedDecorators: item.decoratorsArray,
      };
    }
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

  private async addAutoLoadedFile(fileName: string) {
    if (!this.graph) throw new Error('expected graph to be set');
    const filePath = path.join(this.basePath, fileName);

    if (this.graph.virtualImports) {
      if (this.graph.virtualImports[filePath]) {
        const source = new DotEnvFileDataSource(filePath, { overrideContents: this.graph.virtualImports[filePath] });
        await this.addChild(source);
        return source;
      }
      return;
    }

    if (!await pathExists(filePath)) return;
    const source = new DotEnvFileDataSource(filePath);
    await this.addChild(source);
    return source;
  }

  async _finishInit() {
    if (!this.graph) throw new Error('expected graph to be set');

    await this.addAutoLoadedFile('.env.schema');
    await this.addAutoLoadedFile('.env');

    // .env.schema is usually the "schema data source" but this allows for a single .env file being the main source
    if (this.children.length) {
      this.schemaDataSource = this.children[this.children.length - 1] as DotEnvFileDataSource;
    }

    await this.addAutoLoadedFile('.env.local');

    // and finally load the env-specific files
    const currentEnv = await this.resolveCurrentEnv() || this.envFlagValue;
    if (currentEnv) {
      await this.addAutoLoadedFile(`.env.${currentEnv}`);
      await this.addAutoLoadedFile(`.env.${currentEnv}.local`);
    }
  }
}
