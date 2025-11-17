import _ from '@env-spec/utils/my-dash';
import { ParsedEnvSpecFunctionCall, type ParsedEnvSpecDecorator } from '@env-spec/parser';
import { EnvGraphDataSource } from './data-source';
import type { ConfigItem } from './config-item';
import { type Resolver, convertParsedValueToResolvers } from './resolver';
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
];



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
