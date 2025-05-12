import fs from 'node:fs/promises';
import path from 'node:path';

import _ from '@env-spec/utils/my-dash';
import { tryCatch } from '@env-spec/utils/try-catch';
import { checkIsFileGitIgnored } from '@env-spec/utils/git-utils';
import {
  ParsedEnvSpecDecorator, ParsedEnvSpecFile, ParsedEnvSpecFunctionCall,
  ParsedEnvSpecKeyValuePair, ParsedEnvSpecStaticValue, parseEnvSpecDotEnvFile,
} from '@env-spec/parser';

import { ConfigItemDef } from './config-item';
import {
  ErrorResolver, ResolverInstance, StaticValueResolver,
} from './resolver';
import { EnvGraph } from './env-graph';

import { SchemaError } from './errors';

const ENV_FILE_EXTENSIONS = [
  'js',
  'mjs',
  'ts',
  'mts',
  'yaml',
  'yml',
  'toml',
  'json',
];

const DATA_SOURCE_TYPES = Object.freeze({
  schema: {
    fileSuffixes: ['schema'],
    precedence: 0,
  },
  example: {
    fileSuffixes: ['sample', 'example'],
    precedence: 1,
  },
  defaults: {
    fileSuffixes: ['default', 'defaults'],
    precedence: 2,
  },
  values: {
    fileSuffixes: [] as Array<string>,
    precedence: 3,
  },
  overrides: {
    fileSuffixes: ['local', 'override'],
    precedence: 4,
  },
});
type DataSourceType = keyof typeof DATA_SOURCE_TYPES;

export abstract class EnvGraphDataSource {
  static DATA_SOURCE_TYPES = DATA_SOURCE_TYPES;

  // reference back to the graph
  graph?: EnvGraph;

  type = 'values' as DataSourceType;
  applyForEnv?: string;
  disabled?: boolean = false;
  ignoreNewDefs = false;
  abstract get label(): string;

  /** an error encountered while loading/parsing the data source */
  loadingError?: Error;

  get isValid() {
    return !this.loadingError;
  }

  configItemDefs: Record<string, ConfigItemDef> = {};
  decorators: Record<string, ParsedEnvSpecDecorator> = {};

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



export class ProcessEnvDataSource extends EnvGraphDataSource {
  type = 'overrides' as const;
  label = 'Process Environment Variables';
  ignoreNewDefs = true;

  // ? do we want to set decorator values from env vars here? -- ex: _ENV_FLAG_KEY
  // depends if we want those to work only within process.env

  constructor() {
    super();

    for (const itemKey of Object.keys(process.env)) {
      this.configItemDefs[itemKey] = {
        resolver: new StaticValueResolver(process.env[itemKey]),
      };
    }
  }
}


export class EnvSourceParseError extends Error {
  constructor(
    message: string,
    public location: {
      path: string,
      lineNumber: number,
      colNumber: number,
      lineStr: string,
    },
  ) {
    super(message);
  }
}

export abstract class FileBasedDataSource extends EnvGraphDataSource {
  isGitIgnored?: boolean;
  fullPath: string;
  fileName: string;
  rawContents?: string;
  format?: string;

  get label() { return `File: ${this.fullPath}`; }

  static validFileExtensions: Array<string> = [];
  get validFileExtensions() {
    return (this.constructor as typeof FileBasedDataSource).validFileExtensions;
  }

  constructor(fullPath: string, opts?: {
    overrideContents?: string;
    overrideGitIgnored?: boolean;
  }) {
    super();

    this.fullPath = fullPath;
    this.fileName = path.basename(fullPath);

    // easy way to allow tests to override contents or other non-standard ways of loading content
    if (opts?.overrideContents) {
      this.rawContents = opts.overrideContents;
      this.isGitIgnored = opts.overrideGitIgnored;
    }

    // we will infer some properties from the file name
    // so we may want to provide a way to opt out of this to set them manually
    if (!this.fileName.startsWith('.env')) {
      throw new Error('file name must start with ".env"');
    }


    // we'll break up the filename into parts to detect some info
    // note that a file can have several parts - for example `.env.production.local`
    const fileNameParts = this.fileName.substring(1).split('.');
    const maybeExtension = fileNameParts[fileNameParts.length - 1];
    if (this.validFileExtensions.includes(maybeExtension)) {
      fileNameParts.pop(); // remove the extension
    }

    const maybeFileType = fileNameParts[fileNameParts.length - 1];
    for (const [possibleSourceType, possibleSourceSpec] of Object.entries(DATA_SOURCE_TYPES)) {
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

      // some tools use shorthands of dev/stage/prod
      // so we standardize those to normal env values just in case?
      // ? not sure about this - might want to leave it as the user wrote it?
      if (this.applyForEnv === 'dev') this.applyForEnv = 'development';
      if (this.applyForEnv === 'stage') this.applyForEnv = 'staging';
      if (this.applyForEnv === 'prod') this.applyForEnv = 'production';
    }
  }

  // no async constructors... :(
  async finishInit() {
    if (!this.rawContents) {
      // TODO: check perf on exec based check, possibly switch to `ignored` package
      this.isGitIgnored = await checkIsFileGitIgnored(this.fullPath);
      this.rawContents = await fs.readFile(this.fullPath, 'utf8');
    }
    await this._parseContents();
  }
  abstract _parseContents(): Promise<void>;
}

export class DotEnvFileDataSource extends FileBasedDataSource {
  static format = 'dotenv';
  static validFileExtensions = []; // no extension for dotenv files!


  parsedFile?: ParsedEnvSpecFile;

  private convertParserValueToResolvers(
    value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | undefined,
  ): ResolverInstance {
    if (!this.graph) throw new Error('expected graph to be set');

    if (value === undefined) {
      return new StaticValueResolver(undefined);
    } else if (value instanceof ParsedEnvSpecStaticValue) {
      return new StaticValueResolver(value.unescapedValue);
    } else if (value instanceof ParsedEnvSpecFunctionCall) {
      const ResolverFnClass = this.graph.registeredResolverFunctions[value.name];
      if (!ResolverFnClass) {
        return new ErrorResolver(new SchemaError(`Unknown resolver function: ${value.name}()`));
      }
      const argsFromParser = value.data.args.values;
      if (argsFromParser.length && argsFromParser.every((arg) => arg instanceof ParsedEnvSpecKeyValuePair)) {
        const argsAsResolversObj = {} as Record<string, ResolverInstance>;
        for (const arg of argsFromParser) {
          argsAsResolversObj[arg.key] = this.convertParserValueToResolvers(arg.value);
        }
        return new ResolverFnClass(argsAsResolversObj);
      } else {
        const argsAsResolversArray = argsFromParser.map((arg) => {
          if (arg instanceof ParsedEnvSpecKeyValuePair) throw new Error('KeyValuePair not supported as a function argument');
          return this.convertParserValueToResolvers(arg);
        });
        return new ResolverFnClass(argsAsResolversArray);
      }
    } else {
      throw new Error('Unknown value typexxx');
    }
  }

  async _parseContents() {
    const rawContents = this.rawContents!;

    this.parsedFile = await tryCatch(
      () => parseEnvSpecDotEnvFile(rawContents),
      (error) => {
        this.loadingError = new EnvSourceParseError(error.message, {
          path: this.fullPath,
          lineNumber: error.location.start.line,
          colNumber: error.location.start.column,
          lineStr: rawContents.split('\n')[error.location.start.line - 1],
        });
        this.loadingError.cause = error;
      },
    );

    if (this.loadingError) return;
    if (!this.parsedFile) throw new Error('Failed to parse .env file');

    // copying the object just in case
    this.decorators = this.parsedFile.decoratorsObject;

    if (!this.graph) throw new Error('expected graph to be set');

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
