import fs from 'node:fs/promises';
import path from 'node:path';
import _ from '@env-spec/utils/my-dash';
import { tryCatch } from '@env-spec/utils/try-catch';
import { checkIsFileGitIgnored } from '@env-spec/utils/git-utils';
import {
  ParsedEnvSpecDecorator, ParsedEnvSpecFile, ParsedEnvSpecFunctionCall,
  ParsedEnvSpecKeyValuePair, ParsedEnvSpecStaticValue, parseEnvSpecDotEnvFile,
} from '@env-spec/parser';

import { ConfigItem, type ConfigItemDef } from './config-item';
import {
  ErrorResolver, Resolver, StaticValueResolver,
} from './resolver';
import { EnvGraph } from './env-graph';

import { SchemaError } from './errors';
import { pathExists } from '@env-spec/utils/fs-utils';

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
    this.children.push(child);
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
  /** environment flag config item getter (follows up the parent chain) */
  get envFlagConfigItem() {
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
      // TODO: do not re-resolve every time!!
      // instead we should probably only be resolving once
      // and then triggering an error if the value/definition changes
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

    const disableDecorator = this.getRootDecorators('disable')?.[0];
    if (disableDecorator) {
      if (disableDecorator.value instanceof ParsedEnvSpecFunctionCall) {
        if (disableDecorator.value.name === 'forEnv') {
          const disableForEnvs = disableDecorator.value.simplifiedArgs;
          if (!_.isArray(disableForEnvs)) {
            this._loadingError = new Error('expected disable decorator args to be array');
            return;
          }

          const currentEnv = await this.resolveCurrentEnv();
          if (disableForEnvs.includes(currentEnv)) {
            this._disabled = true;
          }
        } else {
          this._loadingError = new Error(`unknown disable decorator function: ${disableDecorator.name}`);
          return;
        }
      } else if (disableDecorator.simplifiedValue) {
        this._disabled = true;
      }
    }

    // this will also respect if the parent is disabled
    if (this.disabled) return;

    // process @envFlag decorator if present in this source
    const envFlagDecoratorValue = this.getRootDecoratorSimpleValue('envFlag');
    if (envFlagDecoratorValue) {
      if (!this.configItemDefs[envFlagDecoratorValue]) {
        this._loadingError = new Error(`@envFlag key ${envFlagDecoratorValue} must be an item within this schema`);
        return;
      }
      this._envFlagKey = envFlagDecoratorValue;
    }

    // handle imports before we process config items
    // because the imported defs will be overridden by anything within this source
    const importDecorators = this.getRootDecorators('import');
    if (importDecorators.length) {
      for (const importDecorator of importDecorators) {
        // TODO: eventually some of this logic can move to generic decorator processing
        const importArgs = importDecorator.bareFnArgs?.simplifiedValues;
        if (!_.isArray(importArgs)) {
          throw new Error('expected @import args to be array');
        }
        const importPath = importArgs[0];

        if (!importPath) throw new Error('@import decorator must have a value');
        if (!_.isString(importPath)) throw new Error('expected @import path to be string');

        const importKeys = importArgs.slice(1);
        if (!importKeys.every(_.isString)) {
          throw new Error('expected @import keys to all be strings');
        }

        if (importPath.startsWith('./') || importPath.startsWith('../')) {
          // eslint-disable-next-line no-use-before-define
          if (!(this instanceof FileBasedDataSource)) {
            throw new Error('@import of files can only be used from a file-based data source');
          }
          const fullImportPath = path.resolve(path.dirname(this.fullPath), importPath);
          const fileName = path.basename(fullImportPath);
          // TODO: once we have more file types, here we would detect the type and import it correctly
          if (!fileName.startsWith('.env.')) {
            this._loadingError = new Error('imported file must be a .env.* file');
            return;
          }

          // TODO: might be nice to move this logic somewhere else
          if (this.graph.virtualImports) {
            if (this.graph.virtualImports[fullImportPath]) {
              // eslint-disable-next-line no-use-before-define
              const source = new DotEnvFileDataSource(fullImportPath, {
                overrideContents: this.graph.virtualImports[fullImportPath],
              });
              await this.addChild(source, { isImport: true, importKeys });
            } else {
              this._loadingError = new Error(`Virtual import ${fullImportPath} not found`);
              return;
            }
          } else {
            // eslint-disable-next-line no-use-before-define
            await this.addChild(new DotEnvFileDataSource(fullImportPath), { isImport: true, importKeys });
          }
        } else if (importPath.startsWith('http://') || importPath.startsWith('https://')) {
          console.log('handle http import', importPath);
        } else {
          console.log('handle npm import?');
        }
      }
    }

    // create config items, or add additional definitions if they already exist
    for (const itemKey of this.importKeys || _.keys(this.configItemDefs)) {
      const itemDef = this.configItemDefs[itemKey];
      if (!itemDef) continue;
      this.graph.configSchema[itemKey] ??= new ConfigItem(this.graph, itemKey);
      this.graph.configSchema[itemKey].addDef(itemDef, this);
      // TODO: we probably want to track the definition back to the source
    }

    // if we did set the @envFlag in this source, now we'll do an early resolution of the value
    if (envFlagDecoratorValue) {
      // TODO: probably want to move this logic to the graph itself, as some kind "earlyResolve" helper?
      const envFlagItem = this.envFlagConfigItem!;
      await envFlagItem.earlyResolve();
      if (!envFlagItem.isValid) {
        const err = new Error('resolved @envFlag value is not valid');
        err.cause = envFlagItem.errors[0];
        throw err;
      }
      if (!_.isString(envFlagItem.resolvedValue)) {
        throw new Error('expected resolved @envFlag value to be a string');
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
  }

  get isValid() {
    return !this.loadingError;
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

  /**
   * helper to get static values only from the source
   * used during init flow to infer schema info from existing .env files
   * */
  getStaticValues() {
    const obj: Record<string, string> = {};
    for (const [key, def] of Object.entries(this.configItemDefs)) {
      if (def.resolver instanceof StaticValueResolver) {
        obj[key] = String(def.resolver.staticValue ?? '');
      }
    }
    return obj;
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

  private convertParserValueToResolvers(
    value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | undefined,
  ): Resolver | undefined {
    if (!this.graph) throw new Error('expected graph to be set');

    if (value === undefined) {
      return undefined;
    } else if (value instanceof ParsedEnvSpecStaticValue) {
      return new StaticValueResolver(value.unescapedValue);
    } else if (value instanceof ParsedEnvSpecFunctionCall) {
      // TODO: fix ts any
      const ResolverFnClass = this.graph.registeredResolverFunctions[value.name] as any;
      if (!ResolverFnClass) {
        return new ErrorResolver(new SchemaError(`Unknown resolver function: ${value.name}()`));
      }
      const argsFromParser = value.data.args.values;
      let keyValueArgs: Record<string, Resolver> | undefined;
      const argsAsResolversArray: Array<Resolver | Record<string, Resolver>> = [];
      for (const arg of argsFromParser) {
        if (arg instanceof ParsedEnvSpecKeyValuePair) {
          keyValueArgs ??= {};
          const valResolver = this.convertParserValueToResolvers(arg.value);
          if (!valResolver) throw new Error('Did not expect to find undefined resolver in key-value arg');
          keyValueArgs[arg.key] = valResolver;
        } else {
          if (keyValueArgs) {
            return new ErrorResolver(new SchemaError('After switching to key-value function args, cannot switch back'));
          }
          const argResolver = this.convertParserValueToResolvers(arg);
          if (!argResolver) throw new Error('Did not expect to find undefined resolver in array arg');
          argsAsResolversArray.push(argResolver);
        }
      }
      // add key/value args as object as last arg into array
      if (keyValueArgs) argsAsResolversArray.push(keyValueArgs);
      return new ResolverFnClass(argsAsResolversArray);
    } else {
      throw new Error('Unknown value type');
    }
  }

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

    this.decorators = this.parsedFile.decoratorsArray;

    // TODO: if the file is a .env.example file, we should interpret the values as examples
    for (const item of this.parsedFile.configItems) {
      // triggers $ expansion (eg: "${VAR}" => `ref(VAR)`)
      item.processExpansion();

      this.configItemDefs[item.key] = {
        resolver: this.convertParserValueToResolvers(item.expandedValue!),
        description: item.description,
        decorators: item.decoratorsObject,
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

  get loadingError() {
    return this._loadingError || this.schemaDataSource?.loadingError;
  }

  constructor(
    readonly basePath: string,
  ) {
    super();
  }

  get envFlagKey() {
    return this.schemaDataSource?._envFlagKey || this.parent?.envFlagKey;
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
      this.schemaDataSource = this.children[0] as DotEnvFileDataSource;
    }

    await this.addAutoLoadedFile('.env.local');

    // and finally load the env-specific files
    const currentEnv = await this.resolveCurrentEnv();
    if (currentEnv) {
      await this.addAutoLoadedFile(`.env.${currentEnv}`);
      await this.addAutoLoadedFile(`.env.${currentEnv}.local`);
    }
  }
}
