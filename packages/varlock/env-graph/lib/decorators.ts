import type { ParsedEnvSpecDecorator } from '@env-spec/parser';
import { EnvGraphDataSource } from './data-source';
import type { ConfigItem } from './config-item';
import { type Resolver, convertParsedValueToResolvers } from './resolver';

export class DecoratorInstance {
  readonly name: string;
  readonly isFunctionCall: boolean = false;
  readonly isRootDecorator: boolean = false;

  // decorator value/args are translated into a resolver when we process the decorator
  private decValueResolver?: Resolver;

  // TODO: can we get rid of the link back to graph?
  constructor(
    readonly parent: EnvGraphDataSource | ConfigItem,
    readonly parsedDecorator: ParsedEnvSpecDecorator,
  ) {
    this.name = parsedDecorator.name;
    this.isFunctionCall = !!parsedDecorator.isBareFnCall;
    this.isRootDecorator = parent instanceof EnvGraphDataSource;
  }
  get graph() {
    return this.parent instanceof EnvGraphDataSource ? this.parent.graph : this.parent.envGraph;
  }

  async process() {
    if (!this.graph) throw new Error('expected graph to be set');

    const decRegistry = this.isRootDecorator
      ? this.graph.rootDecoratorsRegistry
      : this.graph.itemDecoratorsRegistry;
    const decoratorDef = decRegistry[this.name];
    if (!decoratorDef) {
      throw new Error(`Unknown decorator: ${this.name}`);
    }

    await decoratorDef.process?.({
      dec: this.parsedDecorator,
    });
    this.decValueResolver = convertParsedValueToResolvers(
      this.parsedDecorator.value,
      this.graph.registeredResolverFunctions,
    );
  }

  resolvedValue?: any;
  isResolved = false;

  async resolve() {
    await this.process();
    if (!this.decValueResolver) return undefined;

    this.resolvedValue = await this.decValueResolver.resolve();
    this.isResolved = true;
    return this.resolvedValue;
  }
}


// ~ Root decorators ----------------------------------------
type RootDecoratorCtx = {
  dec: ParsedEnvSpecDecorator,
};

export type RootDecoratorDef = {
  name: string,
  isFunction?: boolean;
  deprecated?: boolean | string;
  process?: (ctx: RootDecoratorCtx) => void | Promise<void>;
};

export function createRootDecorator(def: RootDecoratorDef) {
  return def;
}

// root decorators
export const builtInRootDecorators: Array<RootDecoratorDef> = [
  {
    name: 'envFlag',
    deprecated: 'use @currentEnv instead',
  },
  {
    name: 'currentEnv',
  },
  {
    name: 'defaultRequired',
  },
  {
    name: 'defaultSensitive',
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
type ItemDecoratorCtx = {
};

export type ItemDecoratorDef = {
  name: string,
  isFunction?: boolean;
  deprecated?: boolean | string;
  process?: (ctx: ItemDecoratorCtx) => void | Promise<void>;
};

export function createItemDecorator(def: ItemDecoratorDef) {
  return def;
}

export const builtInItemDecorators: Array<ItemDecoratorDef> = [
  {
    name: 'required',
  },
  {
    name: 'optional',
  },
  {
    name: 'sensitive',
  },
  {
    name: 'type',
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
];
