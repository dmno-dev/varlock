import type { ParsedEnvSpecDecorator } from '@env-spec/parser';

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
