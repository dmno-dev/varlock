import _ from '@env-spec/utils/my-dash';
import {
  ParsedEnvSpecFunctionCall, ParsedEnvSpecStaticValue,
  parseEnvSpecDotEnvFile,
  type ParsedEnvSpecDecorator,
} from '@env-spec/parser';
import { EnvGraphDataSource } from './data-source';
import type { ConfigItem } from './config-item';
import { StaticValueResolver, type Resolver, convertParsedValueToResolvers } from './resolver';
import { SchemaError } from './errors';
import type { EnvGraph } from './env-graph';


export abstract class DecoratorInstance {
  get name() { return this.parsedDecorator.name; }
  get isFunctionCall() { return !!this.parsedDecorator.isBareFnCall; }

  // decorator value/args are translated into a resolver when we process the decorator
  _decValueResolver?: Resolver;
  get decValueResolver() {
    return this._decValueResolver;
  }

  abstract readonly isRootDecorator: boolean;
  abstract readonly dataSource: EnvGraphDataSource;
  abstract readonly parsedDecorator: ParsedEnvSpecDecorator;

  abstract graph: EnvGraph;

  _schemaErrors: Array<SchemaError> = [];
  get schemaErrors() {
    return [
      ...this._schemaErrors,
      ...this._decValueResolver?.schemaErrors || [],
    ];
  }

  // error encountered during `execute` function
  _executionError?: Error;

  private decoratorDef?: ItemDecoratorDef | RootDecoratorDef;
  get incompatibleWith() {
    return this.decoratorDef?.incompatibleWith;
  }

  private processed = false;
  private processedData: any;
  async process() {
    if (this.processed) return;
    this.processed = true;

    if (!this.graph) throw new Error('expected graph to be set');

    try {
      const decRegistry = this.isRootDecorator
        ? this.graph.rootDecoratorsRegistry
        : this.graph.itemDecoratorsRegistry;
      this.decoratorDef = decRegistry[this.name];
      if (!this.decoratorDef) {
        throw new Error(`Unknown decorator: @${this.name}`);
      }

      // this is so we can deal with @type, where each data type is not a real resolver
      // so instead we just make a new dummy resolver holding the args
      if (
        this.decoratorDef.useFnArgsResolver
        && this.parsedDecorator.value instanceof ParsedEnvSpecFunctionCall
      ) {
        this._decValueResolver = convertParsedValueToResolvers(
          this.parsedDecorator.value.data.args,
          this.dataSource,
          this.graph.registeredResolverFunctions,
        );
      } else {
        this._decValueResolver = convertParsedValueToResolvers(
          this.parsedDecorator.value,
          this.dataSource,
          this.graph.registeredResolverFunctions,
        );
      }

      if (this.decValueResolver) {
        // process value resolver
        await this.decValueResolver.process(this);

        // process decorator according to definition
        // which can return another function, to be called later
        this.processedData = await this.decoratorDef.process?.(this.decValueResolver);
      }
    } catch (e) {
      this._schemaErrors.push(e instanceof SchemaError ? e : new SchemaError(e as Error));
    }
  }
  async execute() {
    await this.decoratorDef!.execute?.(this.processedData);
  }

  resolvedValue?: any;
  isResolved = false;

  async resolve() {
    if (this.isResolved) return this.resolvedValue;

    await this.process();
    if (!this.decValueResolver) throw new Error('expected decorator to have a value resolver');
    try {
      this.resolvedValue = await this.decValueResolver.resolve();
    } catch (err) {
      this._schemaErrors.push(err as any);
      return;
    }

    this.isResolved = true;
    return this.resolvedValue;
  }
}

export class ItemDecoratorInstance extends DecoratorInstance {
  isRootDecorator = false;

  constructor(
    readonly configItem: ConfigItem,
    readonly dataSource: EnvGraphDataSource,
    readonly parsedDecorator: ParsedEnvSpecDecorator,
  ) {
    super();
  }
  get graph() { return this.dataSource.graph!; }
}

export class RootDecoratorInstance extends DecoratorInstance {
  isRootDecorator = true;
  constructor(
    readonly dataSource: EnvGraphDataSource,
    readonly parsedDecorator: ParsedEnvSpecDecorator,
  ) {
    super();
  }
  get graph() { return this.dataSource.graph!; }
}


// ~ Root decorators ----------------------------------------
export type RootDecoratorDef<Processed = any> = {
  name: string,
  description?: string;
  isFunction?: boolean;
  deprecated?: boolean | string;
  incompatibleWith?: Array<string>;
  process?: (decoratorValue: Resolver) => (Processed | Promise<Processed>);
  execute?: (executeInput: Processed) => void | Promise<void>;
  useFnArgsResolver?: boolean,
};

// root decorators
export const builtInRootDecorators: Array<RootDecoratorDef<any>> = [
  {
    name: 'envFlag',
    deprecated: 'use @currentEnv instead',
  },
  {
    name: 'currentEnv',
    incompatibleWith: ['envFlag'],
  },
  {
    name: 'defaultRequired',
    process: (decVal) => {
      if (
        !decVal.isStatic
        || ![true, false, 'infer'].includes(decVal.staticValue as any)
      ) {
        throw new Error('@defaultRequired decorator value must be set to a static value of true, false, or "infer"');
      }
    },
  },
  {
    name: 'defaultSensitive',
    process: (decVal) => {
      if (
        (decVal.isStatic && !_.isBoolean(decVal.staticValue))
        || (!decVal.isStatic && decVal.fnName && decVal.fnName !== 'inferFromPrefix')
      ) {
        throw new Error('only true, false, or `inferFromPrefix()` is allowed for @defaultSensitive decorator');
      }
    },
  },
  {
    name: 'disable',
  },
  {
    name: 'generateTypes',
    isFunction: true,
  },
  {
    name: 'import',
    isFunction: true,
    process: (decVal) => {
      if (!decVal.arrArgs || decVal.arrArgs.length === 0) {
        throw new Error('@import decorator must have at least one argument - the path to import');
      }
      if (decVal.arrArgs.some((a) => !a.isStatic)) {
        throw new Error('@import decorator cannot use any dynamic values - all args must be static');
      }
      // The 'enabled' named parameter is allowed and can be dynamic
    },
  },
  {
    name: 'plugin',
    isFunction: true,
  },
  {
    name: 'redactLogs',
  },
  {
    name: 'preventLeaks',
  },
  {
    name: 'setValuesBulk',
    isFunction: true,
    process(argsVal) {
      if (!argsVal.arrArgs || argsVal.arrArgs.length === 0) {
        throw new SchemaError('@setValuesBulk requires at least one argument - the data resolver');
      }
      if (argsVal.arrArgs.length > 1) {
        throw new SchemaError('@setValuesBulk expects only one positional argument - the data resolver');
      }
      if (argsVal.objArgs) {
        const validOptions = new Set(['format', 'createMissing']);
        for (const key of Object.keys(argsVal.objArgs)) {
          if (!validOptions.has(key)) {
            throw new SchemaError(`@setValuesBulk: unknown option "${key}". Valid options: format, createMissing`);
          }
        }
        // validate format option if static
        const formatResolver = argsVal.objArgs.format;
        if (formatResolver?.isStatic) {
          const formatVal = formatResolver.staticValue;
          if (formatVal !== 'json' && formatVal !== 'env') {
            throw new SchemaError('@setValuesBulk: format must be "json" or "env"');
          }
        }
        // validate createMissing option if static
        const createMissingResolver = argsVal.objArgs.createMissing;
        if (createMissingResolver?.isStatic) {
          const cmVal = createMissingResolver.staticValue;
          if (cmVal !== true && cmVal !== false) {
            throw new SchemaError('@setValuesBulk: createMissing must be true or false');
          }
        }
      }

      return {
        graph: argsVal.dataSource!.graph!,
        dataSource: argsVal.dataSource!,
        argsResolver: argsVal,
      };
    },
    async execute(processedData) {
      const { graph, dataSource, argsResolver } = processedData as {
        graph: EnvGraph;
        dataSource: EnvGraphDataSource;
        argsResolver: Resolver;
      };

      // resolve the args
      const resolved = await argsResolver.resolve() as { arr: Array<any>, obj: Record<string, any> };
      const dataString = resolved.arr[0];
      const format = resolved.obj?.format as string | undefined;
      const createMissing = resolved.obj?.createMissing ?? false;

      if (dataString === undefined || dataString === null || dataString === '') {
        return; // empty data is a no-op
      }

      if (typeof dataString !== 'string') {
        dataSource._loadingError = new SchemaError('@setValuesBulk: data resolver must return a string');
        return;
      }

      // detect or use explicit format
      const effectiveFormat = format || detectBulkFormat(dataString);

      // parse the data
      let entries: Record<string, { value: string | number | boolean, description?: string }>;
      try {
        if (effectiveFormat === 'json') {
          entries = parseJsonBulkValues(dataString);
        } else {
          entries = parseEnvBulkValues(dataString, graph.registeredResolverFunctions);
        }
      } catch (err) {
        // surface parse errors as loading errors on the data source
        dataSource._loadingError = err instanceof SchemaError ? err : new SchemaError(err as Error);
        return;
      }

      // dynamic import to avoid circular dependency
      const { ConfigItem } = await import('./config-item');

      for (const [key, entry] of Object.entries(entries)) {
        const existsInSchema = key in graph.configSchema;

        if (!existsInSchema && !createMissing) {
          continue; // skip unknown keys when createMissing is false
        }

        // update or create the configItemDef on this data source
        if (dataSource.configItemDefs[key]) {
          // update existing def's resolver
          dataSource.configItemDefs[key].resolver = new StaticValueResolver(entry.value);
        } else {
          // create a new configItemDef entry
          dataSource.configItemDefs[key] = {
            description: entry.description,
            parsedValue: undefined,
            resolver: new StaticValueResolver(entry.value),
          };
        }

        // if key doesn't exist in configSchema and createMissing is true, create a new ConfigItem
        if (!existsInSchema && createMissing) {
          const newItem = new ConfigItem(graph, key);
          graph.configSchema[key] = newItem;
          await newItem.process();
        }
      }
    },
  },
];



// ~ setValuesBulk helpers ----------------------------------------

function detectBulkFormat(data: string): 'json' | 'env' {
  return data.trimStart().startsWith('{') ? 'json' : 'env';
}

function parseJsonBulkValues(data: string): Record<string, { value: string | number | boolean }> {
  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    throw new SchemaError(`@setValuesBulk: invalid JSON data - ${(err as Error).message}`);
  }
  if (!_.isPlainObject(parsed)) {
    throw new SchemaError('@setValuesBulk: JSON data must be a flat object');
  }
  const result: Record<string, { value: string | number | boolean }> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (val === null || val === undefined) continue; // skip nulls
    if (_.isPlainObject(val) || _.isArray(val)) {
      throw new SchemaError(`@setValuesBulk: JSON value for "${key}" must be a scalar, not an object or array`);
    }
    result[key] = { value: val as string | number | boolean };
  }
  return result;
}

function parseEnvBulkValues(
  data: string,
  registeredResolvers: Record<string, any>,
): Record<string, { value: string, description?: string }> {
  let parsedFile;
  try {
    parsedFile = parseEnvSpecDotEnvFile(data);
  } catch (err) {
    throw new SchemaError(`@setValuesBulk: failed to parse env data - ${(err as Error).message}`);
  }
  const result: Record<string, { value: string, description?: string }> = {};
  for (const item of parsedFile.configItems) {
    if (item.value instanceof ParsedEnvSpecFunctionCall) {
      throw new SchemaError(
        `@setValuesBulk: env format does not support function calls for "${item.key}".`
        + ' Use single quotes for literal values or use format=json instead.',
      );
    }
    if (item.value instanceof ParsedEnvSpecStaticValue) {
      result[item.key] = {
        value: String(item.value.unescapedValue ?? ''),
        description: item.description || undefined,
      };
    } else {
      // undefined value (empty assignment like `KEY=`)
      result[item.key] = { value: '', description: item.description || undefined };
    }
  }
  return result;
}

// ~ Item decorators ----------------------------------------
export type ItemDecoratorDef<T = any> = {
  name: string,
  incompatibleWith?: Array<string>;
  isFunction?: boolean;
  deprecated?: boolean | string;
  process?: (decoratorValue: Resolver) => T | Promise<T>;
  execute?: (executeInput: T) => void | Promise<void>;
  useFnArgsResolver?: boolean,
};

export const builtInItemDecorators: Array<ItemDecoratorDef<any>> = [
  {
    name: 'required',
  },
  {
    name: 'optional',
    incompatibleWith: ['required'],
  },
  {
    name: 'sensitive',
  },
  {
    name: 'public',
    incompatibleWith: ['sensitive'],
  },
  {
    name: 'type',
    useFnArgsResolver: true,
  },
  {
    name: 'example',
  },
  {
    name: 'docsUrl',
    deprecated: 'use `docs()` instead',
  },
  {
    name: 'docs',
    isFunction: true,
  },
  {
    name: 'icon',
  },
];
