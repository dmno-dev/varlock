import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID, randomInt as cryptoRandomInt } from 'node:crypto';

import _ from '@env-spec/utils/my-dash';
import {
  ParsedEnvSpecFunctionArgs, ParsedEnvSpecFunctionCall, ParsedEnvSpecKeyValuePair, ParsedEnvSpecStaticValue,
} from '@env-spec/parser';

import { ConfigItem } from './config-item';
import { SimpleQueue } from './simple-queue';
import { ResolutionError, SchemaError, VarlockError } from './errors';
import { parseTtl, TTL_FOREVER } from '../../lib/cache/ttl-parser';
import type { EnvGraphDataSource } from './data-source';
import { DecoratorInstance } from './decorators';
import { getErrorLocation } from './error-location';
import { isBuiltinVar } from './builtin-vars';

const execAsync = promisify(exec);

export type ResolvedValue = undefined
  | string | number | boolean
  | RegExp // regex is only used internally as function args, not as a final resolved value
  // TODO: will probably want to re-enable object/array values
  | { [key: string]: ResolvedValue }
  | Array<ResolvedValue>;
// Array<ConfigValue>;

export class Resolver {
  static def: ResolverDef;

  constructor(
    readonly arrArgs?: Array<Resolver>,
    readonly objArgs?: Record<string, Resolver>,
    readonly dataSource?: EnvGraphDataSource,
  ) {
    if (this.def.inferredType) this.inferredType = this.def.inferredType;
  }

  static get fnName() { return this.def.name; }

  get def() { return (this.constructor as typeof Resolver).def; }
  get fnName() { return this.def.name; }
  get label() { return this.def.label; }
  get icon() { return this.def.icon; }

  get isStatic() { return false; }
  get staticValue(): ResolvedValue { return undefined; }

  inferredType?: string;
  /** reference to the parsed node that created this resolver, used for error location tracking */
  _parsedNode?: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecFunctionArgs;
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

  private parent?: ConfigItem | DecoratorInstance;

  private meta: any;
  process(parent?: ConfigItem | DecoratorInstance) {
    this.parent = parent;

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
      r.process(parent);
    });
  }

  // meant to be used by subclass _process methods
  protected addDep(key: string) {
    if (!this.envGraph!.configSchema[key]) {
      throw new Error(`invalid dependency: ${key}`);
    }
    this._depsObj[key] = true;
  }

  protected async getCurrentEnv() {
    if (!this.dataSource) throw new Error('expected dataSource to be set');
    await this.dataSource.resolveCurrentEnv();
    return this.dataSource.envFlagValue ? String(this.dataSource.envFlagValue) : undefined;
  }

  async resolve() {
    try {
      const resolvedValue = await this.def.resolve.call(this, this.meta);
      return resolvedValue;
    } catch (err) {
      if (err instanceof VarlockError) {
        // prefix error message with resolver function name (matching schema error behavior)
        // only prefix if the error wasn't already prefixed by a child resolver
        if (!this.def.name.startsWith('\0') && !(err as any)._resolverPrefixed) {
          err.message = `${this.def.name}(): ${err.message}`;
          (err as any)._resolverPrefixed = true;
        }
        // enrich errors with location info from the parsed node if available
        if (!err.more?.location && this._parsedNode && this.dataSource) {
          const location = getErrorLocation(this.dataSource, this._parsedNode);
          if (location) {
            (err as any).more ??= {};
            (err as any).more.location = location;
          }
        }
      }
      throw err;
    }
  }

  get envGraph() {
    if (this.parent instanceof ConfigItem) {
      return this.parent.envGraph;
    } else if (this.parent instanceof DecoratorInstance) {
      return this.parent.graph;
    }
  }

  // meant to be used by subclass _resolve methods
  protected getDepValue(key: string) {
    // NOTE - this should not be called if the dependency is invalid
    // because we only try to resolve the item if all deps are valid
    const depItem = this.envGraph?.configSchema[key];
    if (!depItem) throw new Error(`Referenced item "${key}" not found`);
    if (!depItem.isValid) throw new Error(`Referenced item "${key}" is not valid`);
    return depItem.resolvedValue;
  }
}

// Built-in resolver fns ---------------------------------------------------------

export type ResolverDef<T = any> = {
  name: string;
  description?: string;
  label?: string;
  icon?: string;
  inferredType?: string;
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

// special resolver class for bare decorator function calls `@fn(arr1, arr2, k1=v1)`
// because the _decorator_ may need to resolve each arg individually to use them
// rather than there being a single resolver that resolves to a single value
export class FunctionArgsResolver extends Resolver {
  // we might want to just have a resolve function which resolves all children
  // but it might be useful to let the decorator do it individually
  // so that some can be skipped depending on the other args
  static def = {
    name: '\0fnArgs', // used internally, so we add the extra \0
    label: 'function args',
    icon: 'bi:dash',
    // not actualyl used
    resolve() { return undefined; },
  };
  // special helper to resolve all child args
  async resolve() {
    const resolvedArrayArgs = [] as Array<any>;
    const resolvedObjArgs = {} as Record<string, any>;
    for (const arg of this.arrArgs || []) {
      resolvedArrayArgs.push(await arg.resolve());
    }
    for (const key in this.objArgs) {
      resolvedObjArgs[key] = await this.objArgs[key].resolve();
    }
    return {
      arr: resolvedArrayArgs,
      obj: resolvedObjArgs,
    };
  }
}

// special resolver class that represents an error when an unknown resolver is used - used internally only
export class ErrorResolver extends Resolver {
  static def: ResolverDef = {
    name: '\0error', // used internally, so we add the extra \0
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
  icon: 'material-symbols:join',
  inferredType: 'string',
  argsSchema: {
    type: 'array',
    arrayMinLength: 2,
  },
  async resolve() {
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

    // Auto-register builtin vars when referenced
    if (isBuiltinVar(refKey) && !this.envGraph!.configSchema[refKey]) {
      this.envGraph!.registerBuiltinVar(refKey);
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
  icon: 'codicon:replace',
  argsSchema: {
    // supports both old key=value syntax and new positional syntax
    // old: remap($VAR, result1=match1, result2=match2)  -- arrArgs has 1 item, objArgs has the mappings
    // new: remap($VAR, match1, result1, match2, result2, default?)  -- arrArgs has 3+ items
    type: 'mixed',
  },
  process() {
    const isLegacyKeyValMode = this.objArgs !== undefined && Object.keys(this.objArgs).length > 0;
    if (isLegacyKeyValMode) {
      // legacy mode: 1 positional arg + key=value pairs
      if ((this.arrArgs?.length ?? 0) !== 1) {
        throw new SchemaError('expects exactly 1 positional argument followed by key=value remapping pairs');
      }
      if (Object.keys(this.objArgs!).length === 0) {
        throw new SchemaError('expects at least 1 key=value remapping pair');
      }
      // add a deprecation warning - will show in `varlock load` pretty output below the item
      this._schemaErrors.push(new SchemaError('key=value syntax is deprecated', {
        isWarning: true,
        tip: 'Use positional pairs instead: remap($VAR, match1, result1, match2, result2, ...)',
      }));
    } else {
      // new positional mode: 3+ args (value, match1, result1, ...)
      if ((this.arrArgs?.length ?? 0) < 3) {
        throw new SchemaError('expects at least 3 arguments: (value, match1, result1, ...)');
      }
    }
    return { isLegacyKeyValMode };
  },
  async resolve({ isLegacyKeyValMode }) {
    const originalValue = await this.arrArgs![0].resolve();

    if (isLegacyKeyValMode) {
      // legacy key=value mode: key is the result, value is what to match against
      for (const [remappedVal, matchValResolver] of Object.entries(this.objArgs!)) {
        const matchVal = await matchValResolver.resolve();
        if (matchVal instanceof RegExp && originalValue !== undefined) {
          if (matchVal.test(String(originalValue))) return remappedVal;
        } else {
          if (matchVal === originalValue) return remappedVal;
        }
      }
      return originalValue;
    }

    const remainingArgs = this.arrArgs!.slice(1);
    // iterate in pairs of (match, result); `i + 1 < length` ensures we
    // process only complete pairs, leaving a potential trailing default unprocessed
    for (let i = 0; i + 1 < remainingArgs.length; i += 2) {
      const matchVal = await remainingArgs[i].resolve();
      if (matchVal instanceof RegExp && originalValue !== undefined) {
        if (matchVal.test(String(originalValue))) return remainingArgs[i + 1].resolve();
      } else {
        if (matchVal === originalValue) return remainingArgs[i + 1].resolve();
      }
    }
    // if odd number of remaining args, the last arg is a default value
    if (remainingArgs.length % 2 === 1) {
      return remainingArgs[remainingArgs.length - 1].resolve();
    }
    // no match found, return original value
    return originalValue;
  },
});


export const ForEnvResolver: typeof Resolver = createResolver({
  name: 'forEnv',
  icon: 'tabler:flag-question',
  inferredType: 'boolean',
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
  },
  process() {
    // TODO: check if all options are static
    // TODO: check against envFlag enum options?
    const matchEnvs = this.arrArgs!.map((r) => String(r.staticValue));
    return matchEnvs;
  },
  async resolve(matchEnvs) {
    // this will trigger resolution of the current env if not already done
    const currentEnv = await this.getCurrentEnv();
    if (!currentEnv) throw new SchemaError('current environment is not set');
    return currentEnv && matchEnvs.includes(currentEnv || '');
  },
});

export const EqResolver: typeof Resolver = createResolver({
  name: 'eq',
  icon: 'material-symbols:equal',
  inferredType: 'boolean',
  argsSchema: {
    type: 'array',
    arrayExactLength: 2,
  },
  process() {
    return { left: this.arrArgs![0], right: this.arrArgs![1] };
  },
  async resolve({ left, right }) {
    const leftVal = await left.resolve();
    const rightVal = await right.resolve();
    return leftVal === rightVal;
  },
});

export const IfResolver: typeof Resolver = createResolver({
  name: 'if',
  icon: 'material-symbols:help-center', // question mark
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
  },
  process() {
    const condition = this.arrArgs![0];
    const trueVal = this.arrArgs![1];
    const falseVal = this.arrArgs![2];

    // no args mean we'll true or undefined
    if (!trueVal) {
      this.inferredType = 'boolean';
    // we can infer a type if both true and false cases have a matching inferred type
    } else if (!falseVal || trueVal.inferredType === falseVal.inferredType) {
      this.inferredType = trueVal.inferredType;
    }
    return { condition, trueVal, falseVal };
  },
  async resolve({ condition, trueVal, falseVal }) {
    const conditionVal = await condition.resolve();
    if (conditionVal) {
      // if no trueVal passed in, we return true
      return trueVal ? trueVal.resolve() : true;
    } else {
      if (falseVal) return falseVal.resolve();
      // if only trueVal passed in, we return trueval OR undefined
      if (trueVal) return undefined;
      // if no trueVal or falseVal passed in, we coerce to boolean
      return false;
    }
  },
});

export const IfsResolver: typeof Resolver = createResolver({
  name: 'ifs',
  icon: 'material-symbols:rule',
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
  },
  async resolve() {
    const args = this.arrArgs!;
    // iterate in pairs of (condition, value); `i + 1 < length` ensures we
    // process only complete pairs, leaving a potential trailing default unprocessed
    for (let i = 0; i + 1 < args.length; i += 2) {
      const condition = await args[i].resolve();
      if (condition) {
        return args[i + 1].resolve();
      }
    }
    // if odd total number of args, last is the default value
    if (args.length % 2 === 1) {
      return args[args.length - 1].resolve();
    }
    return undefined;
  },
});

export const NotResolver: typeof Resolver = createResolver({
  name: 'not',
  icon: 'material-symbols:not-equal',
  inferredType: 'boolean',
  argsSchema: {
    type: 'array',
    arrayExactLength: 1,
  },
  async resolve() {
    const value = await this.arrArgs![0].resolve();
    return !value;
  },
});

export const IsEmptyResolver: typeof Resolver = createResolver({
  name: 'isEmpty',
  icon: 'material-symbols:empty',
  inferredType: 'boolean',
  argsSchema: {
    type: 'array',
    arrayExactLength: 1,
  },
  async resolve() {
    const value = await this.arrArgs![0].resolve();
    return value === undefined || value === '';
  },
});


// ── Random value generators ────────────────────────────────────────────

export const RandomIntResolver: typeof Resolver = createResolver({
  name: 'randomInt',
  description: 'Generate a random integer between min and max (inclusive)',
  icon: 'mdi:dice-multiple',
  inferredType: 'number',
  argsSchema: {
    type: 'array',
    arrayMinLength: 0,
    arrayMaxLength: 2,
  },
  process() {
    const args = this.arrArgs ?? [];
    let min = 0;
    let max = 2_147_483_647; // int32 max
    if (args.length === 1) {
      if (!args[0].isStatic || typeof args[0].staticValue !== 'number') {
        throw new SchemaError('randomInt() max argument must be a static number');
      }
      max = args[0].staticValue as number;
    } else if (args.length === 2) {
      if (!args[0].isStatic || typeof args[0].staticValue !== 'number') {
        throw new SchemaError('randomInt() min argument must be a static number');
      }
      if (!args[1].isStatic || typeof args[1].staticValue !== 'number') {
        throw new SchemaError('randomInt() max argument must be a static number');
      }
      min = args[0].staticValue as number;
      max = args[1].staticValue as number;
    }
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new SchemaError('randomInt() arguments must be integers');
    }
    if (min > max) {
      throw new SchemaError(`randomInt() min (${min}) must be <= max (${max})`);
    }
    return { min, max };
  },
  async resolve({ min, max }) {
    // crypto.randomInt is exclusive on upper bound, so +1 for inclusive
    return cryptoRandomInt(min, max + 1);
  },
});

export const RandomFloatResolver: typeof Resolver = createResolver({
  name: 'randomFloat',
  description: 'Generate a random float between min and max',
  icon: 'mdi:dice-multiple',
  inferredType: 'number',
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 0,
    arrayMaxLength: 2,
  },
  process() {
    const args = this.arrArgs ?? [];
    let min = 0;
    let max = 1;
    if (args.length === 1) {
      if (!args[0].isStatic || typeof args[0].staticValue !== 'number') {
        throw new SchemaError('randomFloat() max argument must be a static number');
      }
      max = args[0].staticValue as number;
    } else if (args.length === 2) {
      if (!args[0].isStatic || typeof args[0].staticValue !== 'number') {
        throw new SchemaError('randomFloat() min argument must be a static number');
      }
      if (!args[1].isStatic || typeof args[1].staticValue !== 'number') {
        throw new SchemaError('randomFloat() max argument must be a static number');
      }
      min = args[0].staticValue as number;
      max = args[1].staticValue as number;
    }
    if (min > max) {
      throw new SchemaError(`randomFloat() min (${min}) must be <= max (${max})`);
    }
    const precisionResolver = this.objArgs?.precision;
    let precision = 2;
    if (precisionResolver) {
      if (!precisionResolver.isStatic || typeof precisionResolver.staticValue !== 'number') {
        throw new SchemaError('randomFloat() precision must be a static integer');
      }
      precision = precisionResolver.staticValue as number;
    }
    return { min, max, precision };
  },
  async resolve({ min, max, precision }) {
    const value = min + Math.random() * (max - min);
    return Number(value.toFixed(precision));
  },
});

export const RandomUuidResolver: typeof Resolver = createResolver({
  name: 'randomUuid',
  description: 'Generate a random UUID v4',
  icon: 'mdi:identifier',
  inferredType: 'string',
  async resolve() {
    return randomUUID();
  },
});

export const RandomHexResolver: typeof Resolver = createResolver({
  name: 'randomHex',
  description: 'Generate a random hex string of the given byte length',
  icon: 'mdi:dice-multiple',
  inferredType: 'string',
  argsSchema: {
    type: 'array',
    arrayMinLength: 0,
    arrayMaxLength: 1,
  },
  process() {
    const args = this.arrArgs ?? [];
    let bytes = 16; // default 32 hex chars
    if (args.length === 1) {
      if (!args[0].isStatic || typeof args[0].staticValue !== 'number') {
        throw new SchemaError('randomHex() length argument must be a static number');
      }
      bytes = args[0].staticValue as number;
      if (!Number.isInteger(bytes) || bytes < 1) {
        throw new SchemaError('randomHex() length must be a positive integer');
      }
    }
    return { bytes };
  },
  async resolve({ bytes }) {
    return randomBytes(bytes).toString('hex');
  },
});

export const RandomStringResolver: typeof Resolver = createResolver({
  name: 'randomString',
  description: 'Generate a random string of the given length',
  icon: 'mdi:dice-multiple',
  inferredType: 'string',
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 0,
    arrayMaxLength: 1,
  },
  process() {
    const args = this.arrArgs ?? [];
    let length = 16;
    if (args.length === 1) {
      if (!args[0].isStatic || typeof args[0].staticValue !== 'number') {
        throw new SchemaError('randomString() length argument must be a static number');
      }
      length = args[0].staticValue as number;
      if (!Number.isInteger(length) || length < 1) {
        throw new SchemaError('randomString() length must be a positive integer');
      }
    }
    const charsetResolver = this.objArgs?.charset;
    let charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    if (charsetResolver) {
      if (!charsetResolver.isStatic || typeof charsetResolver.staticValue !== 'string') {
        throw new SchemaError('randomString() charset must be a static string');
      }
      charset = charsetResolver.staticValue as string;
      if (charset.length === 0) {
        throw new SchemaError('randomString() charset must not be empty');
      }
    }
    return { length, charset };
  },
  async resolve({ length, charset }) {
    const bytes = randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += charset[bytes[i] % charset.length];
    }
    return result;
  },
});

// ── Cache resolver ─────────────────────────────────────────────────────

export const CacheResolver: typeof Resolver = createResolver({
  name: 'cache',
  description: 'Cache the result of a resolver',
  icon: 'mdi:cached',
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 1,
    arrayMaxLength: 1,
  },
  process() {
    // pass through child resolver's inferred type
    const childResolver = this.arrArgs?.[0];
    if (childResolver?.inferredType) {
      this.inferredType = childResolver.inferredType;
    }

    // warn if the child resolver is a static value — caching a literal is pointless
    if (childResolver instanceof StaticValueResolver) {
      this._schemaErrors.push(new SchemaError(
        'wraps a static value which never changes — caching has no effect',
        { isWarning: true },
      ));
    }

    // optional explicit cache key
    const keyResolver = this.objArgs?.key;
    let customKey: string | undefined;
    if (keyResolver) {
      if (!keyResolver.isStatic || typeof keyResolver.staticValue !== 'string') {
        throw new SchemaError('key must be a static string');
      }
      customKey = keyResolver.staticValue as string;
    }

    // optional TTL
    const ttlResolver = this.objArgs?.ttl;
    let ttl: string | number | undefined;
    if (ttlResolver) {
      if (!ttlResolver.isStatic) {
        throw new SchemaError('ttl must be a static value');
      }
      const ttlVal = ttlResolver.staticValue;
      if (typeof ttlVal !== 'string' && typeof ttlVal !== 'number') {
        throw new SchemaError('ttl must be a string like "1h" or a number (0 = forever)');
      }
      parseTtl(ttlVal);
      ttl = ttlVal;
    }

    return { ttl, customKey };
  },
  async resolve(state) {
    const { getResolutionContext } = await import('./resolution-context');
    const ctx = getResolutionContext();
    const cacheStore = ctx?.cacheStore;
    const item = ctx?.currentItem;

    const childResolver = this.arrArgs![0];

    // Use explicit key if provided, otherwise auto-generate from file/item/resolver text
    let cacheKey: string;
    if (state.customKey) {
      cacheKey = `resolver:custom:${state.customKey}`;
    } else {
      const resolverText = this._parsedNode?.toString() ?? childResolver._parsedNode?.toString() ?? 'unknown';
      const filePath = (this.dataSource as any)?.fullPath ?? this.dataSource?.label ?? 'unknown';
      cacheKey = `resolver:${filePath}:${item?.key ?? 'unknown'}:${resolverText}`;
    }

    if (cacheStore && !ctx?.skipCache) {
      // try cache read (unless clear-cache mode)
      if (!ctx?.clearCache) {
        const cached = await cacheStore.get(cacheKey);
        if (cached) {
          ctx?.cacheHits.push({ cacheKey, cachedAt: cached.cachedAt, expiresAt: cached.expiresAt });
          return cached.value;
        }
      }
    }

    // cache miss — resolve wrapped resolver
    const childValue = await childResolver.resolve();

    // write to cache (even in clear-cache mode — that's the "rewrite" part)
    if (cacheStore && !ctx?.skipCache && childValue !== undefined) {
      const ttlMs = state.ttl != null ? parseTtl(state.ttl) : TTL_FOREVER;
      await cacheStore.set(cacheKey, childValue, ttlMs);
    }

    return childValue;
  },
});

// Special function for `@defaultSensitive=inferFromPrefix(PUBLIC_)`
// we may want to formalize this pattern of a resolver function used in a root decorator
// but resolved within the context of a specific item
export const InferFromPrefixResolver: typeof Resolver = createResolver({
  name: 'inferFromPrefix',
  icon: 'material-symbols:help-center', // question mark
  argsSchema: {
    type: 'array',
    arrayExactLength: 1,
  },
  process() {
    // TODO: we should validate that this is only used within @defaultSensitive root decorator
    return this.arrArgs![0].staticValue;
  },
  async resolve(_prefix) {
    // this is not actually meant to be resolved to a value
    // instead our code will just use the args directly
    return undefined;
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
  RandomIntResolver,
  RandomFloatResolver,
  RandomUuidResolver,
  RandomHexResolver,
  RandomStringResolver,
  CacheResolver,
  RemapResolver,
  IfsResolver,
  ForEnvResolver,
  EqResolver,
  IfResolver,
  NotResolver,
  IsEmptyResolver,
  RegexResolver,
  InferFromPrefixResolver,
];

/// /

export function convertParsedValueToResolvers(
  value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecFunctionArgs | undefined,
  dataSource: EnvGraphDataSource | undefined,
  registeredResolvers: Record<string, ResolverChildClass>,
): Resolver | undefined {
  if (value === undefined) {
    return undefined;
  } else if (value instanceof ParsedEnvSpecStaticValue) {
    return new StaticValueResolver(value.unescapedValue);
  } else if (
    value instanceof ParsedEnvSpecFunctionCall
    // this is used only for bare decorator fn calls `@fn(arr1, arr2, k1=v1)`
    || value instanceof ParsedEnvSpecFunctionArgs
  ) {
    let ResolverFnClass: ResolverChildClass | undefined;
    let argsFromParser: Array<ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecKeyValuePair>;
    if (value instanceof ParsedEnvSpecFunctionCall) {
      // we look up the resolver by function name
      ResolverFnClass = registeredResolvers[value.name];
      if (!ResolverFnClass) {
        return new ErrorResolver(new SchemaError(`Unknown resolver function: ${value.name}()`));
      }
      argsFromParser = value.data.args.values;
    } else {
      // special no-op resolver which just holds all the args resolvers
      // our decorator functions can then access and resolve those children as necessary
      ResolverFnClass = FunctionArgsResolver;
      argsFromParser = value.values;
    }

    let arrArgsAsResolvers: Array<Resolver> | undefined;
    let objArgsAsResolvers: Record<string, Resolver> | undefined;
    for (const arg of argsFromParser) {
      if (arg instanceof ParsedEnvSpecKeyValuePair) {
        objArgsAsResolvers ??= {};
        const valResolver = convertParsedValueToResolvers(arg.value, dataSource, registeredResolvers);
        if (!valResolver) throw new Error('Did not expect to find undefined resolver in key-value arg');
        objArgsAsResolvers[arg.key] = valResolver;
      } else {
        if (objArgsAsResolvers) {
          return new ErrorResolver(new SchemaError('After switching to key-value function args, cannot switch back'));
        }
        const argResolver = convertParsedValueToResolvers(arg, dataSource, registeredResolvers);
        if (!argResolver) throw new Error('Did not expect to find undefined resolver in array arg');
        arrArgsAsResolvers ??= [];
        arrArgsAsResolvers.push(argResolver);
      }
    }
    const resolver = new ResolverFnClass(arrArgsAsResolvers, objArgsAsResolvers, dataSource);
    resolver._parsedNode = value;
    return resolver;
  } else {
    throw new Error('Unknown value type');
  }
}
