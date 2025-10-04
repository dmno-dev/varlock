import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import _ from '@env-spec/utils/my-dash';
import { ParsedEnvSpecFunctionCall, ParsedEnvSpecKeyValuePair, ParsedEnvSpecStaticValue } from '@env-spec/parser';

import { ConfigItem } from './config-item';
import { SimpleQueue } from './simple-queue';
import { ResolutionError, SchemaError } from './errors';

const execAsync = promisify(exec);

export type ResolvedValue = undefined
  | string | number | boolean
  | RegExp; // regex is only used internally as function args, not as a final resolved value
  // TODO: will probably want to re-enable object/array values
  // { [key: string]: ConfigValue } |
  // Array<ConfigValue>;

export class Resolver {
  static def: ResolverDef;

  constructor(
    readonly arrArgs?: Array<Resolver>,
    readonly objArgs?: Record<string, Resolver>,
  ) {}

  static get fnName() { return this.def.name; }

  get def() { return (this.constructor as typeof Resolver).def; }
  get label() { return this.def.label; }
  get icon() { return this.def.icon; }

  get isStatic() { return false; }
  get staticValue(): ResolvedValue { return undefined; }

  inferredType?: string;
  _schemaErrors: Array<SchemaError> = [];
  private _depsObj: Record<string, boolean> = {};

  get childResolvers(): Array<Resolver> {
    return [
      ...this.arrArgs ?? [],
      ...Object.values(this.objArgs ?? {}),
    ];
  }

  get schemaErrors(): Array<SchemaError> {
    return [
      ...this._schemaErrors,
      ...this.childResolvers.flatMap((r) => r.schemaErrors),
    ];
  }
  set schemaErrors(v: Array<SchemaError>) { throw new Error('set _schemaErrors instead'); }

  get depsObj(): Record<string, boolean> {
    const mergedDepsObj = { ...this._depsObj };
    this.childResolvers.forEach((r) => Object.assign(mergedDepsObj, r.depsObj));
    return mergedDepsObj;
  }
  get deps() {
    return Object.keys(this.depsObj);
  }

  private configItem?: ConfigItem;

  private meta: any;
  process(configItem: ConfigItem) {
    this.configItem = configItem;

    const { argsSchema } = this.def;
    if (argsSchema?.type === 'array' && this.objArgs !== undefined) {
      this._schemaErrors.push(new SchemaError('Resolver does not support key-value args'));
    } else if (argsSchema?.type === 'object' && this.arrArgs !== undefined) {
      this._schemaErrors.push(new SchemaError('Resolver expects only key-value args'));
    }

    if (argsSchema?.arrayExactLength !== undefined) {
      if (this.arrArgs?.length !== argsSchema.arrayExactLength) {
        this._schemaErrors.push(
          new SchemaError(
            `expects exactly ${argsSchema.arrayExactLength} argument${argsSchema.arrayExactLength > 1 ? 's' : ''}`,
          ),
        );
      }
    }
    if (argsSchema?.arrayMinLength !== undefined) {
      if ((this.arrArgs?.length ?? 0) < argsSchema.arrayMinLength) {
        this._schemaErrors.push(
          new SchemaError(
            `expects at least ${argsSchema.arrayMinLength} argument${argsSchema.arrayMinLength > 1 ? 's' : ''}`,
          ),
        );
      }
    }
    if (argsSchema?.arrayMaxLength !== undefined) {
      if ((this.arrArgs?.length ?? 0) > argsSchema.arrayMaxLength) {
        this._schemaErrors.push(
          new SchemaError(`expects at most ${argsSchema.arrayMaxLength} argument${argsSchema.arrayMaxLength > 1 ? 's' : ''}`),
        );
      }
    }

    if (argsSchema?.objKeyMinLength !== undefined) {
      const objKeyLengths = Object.keys(this.objArgs || {}).length;
      if (objKeyLengths < argsSchema.objKeyMinLength) {
        this._schemaErrors.push(
          new SchemaError(
            `expects at least ${argsSchema.objKeyMinLength} key value arg${argsSchema.objKeyMinLength > 1 ? 's' : ''}`,
          ),
        );
      }
    }

    // call specific resolve fn for the resolver
    if (this._schemaErrors.length === 0) {
      try {
        this.meta = this.def.process?.call(this);
      } catch (error) {
        if (error instanceof SchemaError) {
          this._schemaErrors.push(error);
        } else if (error instanceof Error) {
          this._schemaErrors.push(new SchemaError(error));
        } else {
          throw new Error(`Non-error thrown while processing resolver - ${error}`);
        }
      }
    }

    // adding fn name to resolver schema errors
    if (!this.def.name.startsWith('\0')) {
      for (const e of this._schemaErrors) {
        e.message = `${this.def.name}(): ${e.message}`;
      }
    }

    this.childResolvers.forEach((r) => {
      r.process(configItem);
    });
  }

  // meant to be used by subclass _process methods
  protected addDep(key: string) {
    this._depsObj[key] = true;
    if (!this.configItem) throw new Error('expected configItem to be set');
    if (!this.configItem.envGraph.configSchema[key]) {
      this._schemaErrors.push(new SchemaError(`Unknown referenced key: ${key}`));
    }
  }

  async resolve() {
    const resolvedValue = await this.def.resolve.call(this, this.meta);
    return resolvedValue;
  }

  // meant to be used by subclass _resolve methods
  protected getDepValue(key: string) {
    // NOTE - this should not be called if the dependency is invalid
    // because we only try to resolve the item if all deps are valid
    const depItem = this.configItem?.envGraph.configSchema[key];
    if (!depItem) throw new Error(`Expected to find item - ${key}`);
    return depItem.resolvedValue;
  }
}

// Built-in resolver fns ---------------------------------------------------------

export type ResolverDef<T = any> = {
  name: string;
  label: string;
  icon?: string;
  argsSchema?: {
    type: 'array' | 'object' | 'mixed';
    arrayExactLength?: number;
    arrayMinLength?: number;
    arrayMaxLength?: number;

    objKeyMinLength?: number;
  },
  process?: (this: Resolver) => T;
  resolve: (this: Resolver, state: T) => ResolvedValue | Promise<ResolvedValue>;
};

// special resolver class that just holds a static value - used internally only
export class StaticValueResolver extends Resolver {
  static def = {
    name: '\0static', // used internally, so we add the extra \0
    label: 'static',
    icon: 'bi:dash',
    async resolve(this: Resolver) {
      return (this as StaticValueResolver).staticValue;
    },
  };
  // helper so plugins dont need to import and use instanceof
  get isStatic() { return true; }
  get staticValue() { return this._staticValue; }
  constructor(readonly _staticValue: ResolvedValue) {
    super([]);
    if (_staticValue !== undefined) {
      this.inferredType = typeof _staticValue;
    }
  }
}

// special resolver class that represents an error when an unknown resolver is used - used internally only
export class ErrorResolver extends Resolver {
  static def: ResolverDef = {
    name: '\0error', // used internally, so we add the extra \0
    label: 'error',
    icon: 'bi:dash',
    async resolve() { return undefined; },
  };
  constructor(readonly err: SchemaError) {
    super([]);
    this._schemaErrors.push(err);
  }
}

export function createResolver<T>(def: ResolverDef<T>) {
  const ResolverClass = class extends Resolver {};
  ResolverClass.def = def;
  return ResolverClass as typeof Resolver;
}


export const ConcatResolver: typeof Resolver = createResolver({
  name: 'concat',
  label: 'concat',
  icon: 'material-symbols:join',
  argsSchema: {
    type: 'array',
    arrayMinLength: 2,
  },
  process() {
    this.inferredType = 'string';
  },
  async resolve(t) {
    const resolvedValues: Array<string> = [];
    for (const arg of this.arrArgs ?? []) {
      // TODO: handle child resolver failure?
      const resolvedChildValue = await arg.resolve();
      // do we need to worry about non-string-ish things here?
      resolvedValues.push(String(resolvedChildValue ?? ''));
    }
    return resolvedValues.join('');
  },
});

export const FallbackResolver: typeof Resolver = createResolver({
  name: 'fallback',
  label: 'fallback',
  icon: 'memory:table-top-stairs-up',
  argsSchema: {
    type: 'array',
    arrayMinLength: 2,
  },
  async resolve() {
    for (const arg of this.arrArgs ?? []) {
      // TODO: handle child resolver failure?
      const resolvedChildValue = await arg.resolve();
      if (resolvedChildValue !== undefined && resolvedChildValue !== '') {
        return resolvedChildValue;
      }
    }
  },
});

const execQueue = new SimpleQueue();
export const ExecResolver: typeof Resolver = createResolver({
  name: 'exec',
  label: 'exec',
  icon: 'iconoir:terminal',
  argsSchema: {
    type: 'array',
    arrayExactLength: 1,
  },
  async resolve() {
    const commandStr = await this.arrArgs?.[0].resolve();
    if (typeof commandStr !== 'string') {
      throw new ResolutionError('exec() expects a string arg');
    }

    try {
      // ? NOTE - putting these calls through a simple queue for now
      // this avoids multiple 1password auth popups, but it also makes multiple 1p calls very slow
      // we likely want to remove this once we have the specific 1Password plugin re-implemented
      const { stdout } = await execQueue.enqueue(() => execAsync(commandStr));
      // trim trailing newline by default
      // we could allow options here?
      return stdout.replace(/\n$/, '');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log('exec() failed', err);
      throw new ResolutionError(`exec() command failed: ${commandStr}`);
    }
  },
});

export const RefResolver: typeof Resolver = createResolver({
  name: 'ref',
  label: 'ref',
  icon: 'mdi-light:content-duplicate',
  argsSchema: {
    type: 'array',
    arrayExactLength: 1,
  },
  process() {
    // TODO: should this be handled by the argsSchema?
    if (!(this.arrArgs?.[0] instanceof StaticValueResolver)) {
      throw new SchemaError('expects a single static value passed in');
    }
    const refKey = this.arrArgs[0].staticValue;
    if (typeof refKey !== 'string') {
      throw new SchemaError('expects a string keyname passed in');
    }
    this.addDep(refKey);
    return refKey;
  },
  async resolve(refKey) {
    return this.getDepValue(refKey);
  },
});

// regex() is only used internally as function args to be used by other functions
// we will check final resoled values to make sure they are not regexes
export const RegexResolver: typeof Resolver = createResolver({
  name: 'regex',
  label: 'regex',
  icon: 'mdi:regex',
  argsSchema: {
    type: 'array',
    arrayExactLength: 1,
  },
  process() {
    if (!(this.arrArgs?.[0] instanceof StaticValueResolver)) {
      throw new SchemaError('expects a single static value passed in');
    }
    const regexStr = this.arrArgs[0].staticValue;
    if (typeof regexStr !== 'string') {
      throw new SchemaError('expects a string');
    }
    try {
      return new RegExp(regexStr);
    } catch (err) {
      throw new SchemaError((err as Error).message);
    }
  },
  async resolve(regex) {
    return regex;
  },
});

export const RemapResolver: typeof Resolver = createResolver({
  name: 'remap',
  label: 'remap',
  icon: 'codicon:replace',
  argsSchema: {
    type: 'mixed',
    arrayExactLength: 1,
    objKeyMinLength: 1,
  },
  process() {
    return this.objArgs!;
  },
  async resolve(remappings) {
    const originalValue = await this.arrArgs![0].resolve();
    for (const [remappedVal, matchValResolver] of Object.entries(remappings)) {
      const matchVal = await matchValResolver.resolve();
      if (matchVal instanceof RegExp && originalValue !== undefined) {
        if (matchVal.test(String(originalValue))) return remappedVal;
      } else {
        if (matchVal === originalValue) return remappedVal;
      }
    }
    return originalValue;
  },
});




export type ResolverChildClass<ChildClass extends Resolver = Resolver> = (
  { new (...args: Array<any>): ChildClass } & typeof Resolver
);

// these are the resolvers which are accessible to end-users as fn calls
export const BaseResolvers: Array<ResolverChildClass> = [
  ConcatResolver,
  FallbackResolver,
  RefResolver,
  ExecResolver,
  RemapResolver,
  RegexResolver,
];


/// /

export function convertParsedValueToResolvers(
  value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | undefined,
  registeredResolvers: Record<string, ResolverChildClass>,
): Resolver | undefined {
  if (value === undefined) {
    return undefined;
  } else if (value instanceof ParsedEnvSpecStaticValue) {
    return new StaticValueResolver(value.unescapedValue);
  } else if (value instanceof ParsedEnvSpecFunctionCall) {
    const ResolverFnClass = registeredResolvers[value.name];
    if (!ResolverFnClass) {
      return new ErrorResolver(new SchemaError(`Unknown resolver function: ${value.name}()`));
    }
    const argsFromParser = value.data.args.values;

    let arrArgsAsResolvers: Array<Resolver> | undefined;
    let objArgsAsResolvers: Record<string, Resolver> | undefined;
    for (const arg of argsFromParser) {
      if (arg instanceof ParsedEnvSpecKeyValuePair) {
        objArgsAsResolvers ??= {};
        const valResolver = convertParsedValueToResolvers(arg.value, registeredResolvers);
        if (!valResolver) throw new Error('Did not expect to find undefined resolver in key-value arg');
        objArgsAsResolvers[arg.key] = valResolver;
      } else {
        if (objArgsAsResolvers) {
          return new ErrorResolver(new SchemaError('After switching to key-value function args, cannot switch back'));
        }
        const argResolver = convertParsedValueToResolvers(arg, registeredResolvers);
        if (!argResolver) throw new Error('Did not expect to find undefined resolver in array arg');
        arrArgsAsResolvers ??= [];
        arrArgsAsResolvers.push(argResolver);
      }
    }
    return new ResolverFnClass(arrArgsAsResolvers, objArgsAsResolvers);
  } else {
    throw new Error('Unknown value type');
  }
}
