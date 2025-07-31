import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import _ from '@env-spec/utils/my-dash';

import { ResolutionError, SchemaError } from './errors';
import { ConfigItem } from './config-item';
import { SimpleQueue } from './simple-queue';

const execAsync = promisify(exec);

export type ResolvedValue = undefined
  | string | number | boolean
  | RegExp; // regex is only used internally as function args, not as a final resolved value
  // TODO: will probably want to re-enable object/array values
  // { [key: string]: ConfigValue } |
  // Array<ConfigValue>;


type ResolverFunctionArgs = Array<Resolver | Record<string, Resolver>>;
export abstract class Resolver {
  static fnName?: string;

  constructor(readonly fnArgs: ResolverFunctionArgs) {}

  abstract label: string;
  abstract icon: string;
  inferredType?: string;
  _schemaErrors: Array<SchemaError> = [];
  private _depsObj: Record<string, boolean> = {};

  get childResolvers(): Array<Resolver> {
    return this.fnArgs.flatMap((r) => (_.isPlainObject(r) ? _.values(r) : r));
  }

  get schemaErrors(): Array<SchemaError> {
    return [
      ...this._schemaErrors,
      ...this.childResolvers.flatMap((r) => r.schemaErrors),
    ];
  }
  get depsObj(): Record<string, boolean> {
    const mergedDepsObj = { ...this._depsObj };
    this.childResolvers.forEach((r) => Object.assign(mergedDepsObj, r.depsObj));
    return mergedDepsObj;
  }
  get deps() {
    return Object.keys(this.depsObj);
  }

  protected abstract _process(ctx?: any): Promise<void | (() => void)>;
  private configItem?: ConfigItem;
  async process(configItem: ConfigItem) {
    this.configItem = configItem;
    try {
      await this._process(configItem);
    } catch (error) {
      if (error instanceof SchemaError) {
        this._schemaErrors.push(error);
      } else if (error instanceof Error) {
        this._schemaErrors.push(new SchemaError(error));
      } else {
        throw new Error(`Non-error thrown while processing resolver - ${error}`);
      }
    }
    this.childResolvers.forEach((r) => r.process(configItem));
  }

  // meant to be used by subclass _process methods
  protected addDep(key: string) {
    this._depsObj[key] = true;
    if (!this.configItem) throw new Error('expected configItem to be set');
    if (!this.configItem.envGraph.configSchema[key]) {
      this._schemaErrors.push(new SchemaError(`Unknown referenced key: ${key}`));
    }
  }

  protected abstract _resolve(): Promise<ResolvedValue>;
  async resolve() {
    const resolvedValue = await this._resolve();
    return resolvedValue;
  }

  // meant to be used by subclass _resolve methods
  protected getDepValue(key: string) {
    const depItem = this.configItem?.envGraph.configSchema[key];
    if (!depItem) throw new Error(`Expected to find item - ${key}`);
    return depItem.resolvedValue;
  }
}

// Built-in resolver fns ---------------------------------------------------------

// special resolver class that just holds a static value
// only used internally, not via `static(x)`
export class StaticValueResolver extends Resolver {
  constructor(readonly staticValue: ResolvedValue) {
    super([]);
    if (staticValue !== undefined) {
      this.inferredType = typeof staticValue;
    }
  }

  label = 'static';
  icon = 'bi:dash';

  protected async _resolve() { return this.staticValue; }
  protected async _process() {}
}

// special resolver class that represents an error when an unknown resolver is used
// only used internally, not via `error(x)`
export class ErrorResolver extends Resolver {
  constructor(err: SchemaError) {
    super([]);
    this._schemaErrors.push(err);
  }

  label = 'error';
  icon = 'bi:dash';

  protected async _resolve() { return undefined; }
  protected async _process() { }
}


export class ConcatResolver extends Resolver {
  static fnName = 'concat';
  label = 'concat';
  icon = 'material-symbols:join';
  inferredType = 'string';

  async _process() {
    if (this.fnArgs.some((arg) => _.isPlainObject(arg))) {
      throw new SchemaError('concat() does not support key-value arguments');
    }
    if (this.fnArgs.length < 2) {
      throw new SchemaError('concat() expects at least two arguments');
    }
  }

  protected async _resolve() {
    const resolvedValues = [];
    for (const arg of this.fnArgs) {
      // key value args come through as an object
      if (_.isPlainObject(arg)) {
        throw new Error('concat() does not support key-value arguments');
      }
      // TODO: handle child resolver failure?
      const resolvedChildValue = await arg.resolve();
      // do we need to worry about non-string-ish things here?
      resolvedValues.push(String(resolvedChildValue ?? ''));
    }
    return resolvedValues.join('');
  }
}

export class FallbackResolver extends Resolver {
  static fnName = 'fallback';
  label = 'fallback';
  icon = 'memory:table-top-stairs-up';

  async _process() {
    if (this.fnArgs.some((arg) => _.isPlainObject(arg))) {
      throw new SchemaError('fallback() does not support key-value arguments');
    }
    if (this.fnArgs.length < 2) {
      throw new SchemaError('fallback() expects at least two arguments');
    }
  }

  protected async _resolve() {
    for (const arg of this.fnArgs) {
      if (_.isPlainObject(arg)) throw new Error('fallback() does not support key-value arguments');
      // TODO: handle child resolver failure?
      const resolvedChildValue = await arg.resolve();
      if (resolvedChildValue !== undefined && resolvedChildValue !== '') {
        return resolvedChildValue;
      }
    }
  }
}
export class ExecResolver extends Resolver {
  static fnName = 'exec';
  label = 'exec';
  icon = 'iconoir:terminal';

  async _process() {
    if (this.fnArgs.length !== 1) {
      throw new SchemaError('exec() expects a single child arg');
    }
    if (this.fnArgs.some((arg) => _.isPlainObject(arg))) {
      throw new SchemaError('exec() does not support key-value arguments');
    }
  }

  static execQueue = new SimpleQueue();

  protected async _resolve() {
    if (_.isPlainObject(this.fnArgs[0])) throw new Error('exec() does not support key-value arguments');

    const commandStr = await this.fnArgs[0].resolve();
    if (typeof commandStr !== 'string') {
      throw new ResolutionError('exec() expects a string child arg');
    }

    try {
      // ? NOTE - putting these calls through a simple queue for now
      // this avoids multiple 1password auth popups, but it also makes multiple 1p calls very slow
      // we likely want to remove this once we have the specific 1Password plugin re-implemented
      const { stdout, stderr } = await ExecResolver.execQueue.enqueue(() => execAsync(commandStr));
      // trim trailing newline by default
      // we could allow options here?
      return stdout.replace(/\n$/, '');
    } catch (err) {
      console.log('exec() failed', err);
      throw new ResolutionError(`exec() command failed: ${commandStr}`);
    }
  }
}

export class RefResolver extends Resolver {
  static fnName = 'ref';
  label = 'ref';
  icon = 'mdi-light:content-duplicate';

  private refKey?: string;

  async _process() {
    if (this.fnArgs.length !== 1) {
      throw new SchemaError('ref() expects a single child arg');
    }
    if (!(this.fnArgs[0] instanceof StaticValueResolver)) {
      throw new SchemaError('ref() expects a single static value passed in');
    }
    const keyName = this.fnArgs[0].staticValue;
    if (typeof keyName !== 'string') {
      throw new SchemaError('ref() expects a string keyname passed in');
    }
    this.refKey = keyName;
    this.addDep(keyName);
  }

  protected async _resolve() {
    if (!this.refKey) throw new Error('expected refKey to be set');
    // TODO - need to handle resolution order
    return this.getDepValue(this.refKey);
  }
}

// regex() is only used internally as function args to be used by other functions
// we will check final resoled values to make sure they are not regexes
export class RegexResolver extends Resolver {
  static fnName = 'regex';
  label = 'regex';
  icon = 'mdi:regex';

  private regex?: RegExp;

  async _process() {
    if (this.fnArgs.length !== 1) {
      throw new SchemaError('regex() expects a single child arg');
    }
    if (!(this.fnArgs[0] instanceof StaticValueResolver)) {
      throw new SchemaError('regex() expects a single static value passed in');
    }
    const regexStr = this.fnArgs[0].staticValue;
    if (typeof regexStr !== 'string') {
      throw new SchemaError('regex() expects a string');
    }
    this.regex = new RegExp(regexStr);
  }

  protected async _resolve() {
    if (!this.regex) throw new Error('expected regex to be set');
    return this.regex;
  }
}

export class RemapResolver extends Resolver {
  static fnName = 'remap';
  label = 'remap';
  icon = 'codicon:replace';

  private remappings?: Record<string, Resolver>;

  async _process() {
    if (_.isPlainObject(this.fnArgs[0])) {
      throw new SchemaError('remap() expects the first arg to be the value to remap');
    }
    if (!_.isPlainObject(this.fnArgs[1])) {
      throw new SchemaError('remap() expects the all args after the first to be key-value pairs of remappings');
    }
    if (this.fnArgs.length !== 2) {
      throw new SchemaError('remap() should not have any additional non key-value args after remappings');
    }
    this.remappings = this.fnArgs[1];
  }

  protected async _resolve() {
    if (_.isPlainObject(this.fnArgs[0])) {
      throw new SchemaError('remap() expects the first arg to be the value to remap');
    }
    if (!_.isPlainObject(this.fnArgs[1])) {
      throw new SchemaError('remap() expects the all args after the first to be key-value pairs of remappings');
    }
    const originalValue = await this.fnArgs[0].resolve();

    if (!this.remappings) throw new Error('expected remappings to be set');
    for (const [remappedVal, matchValResolver] of Object.entries(this.remappings)) {
      const matchVal = await matchValResolver.resolve();
      if (matchVal instanceof RegExp && originalValue !== undefined) {
        if (matchVal.test(String(originalValue))) return remappedVal;
      } else {
        if (matchVal === originalValue) return remappedVal;
      }
    }
    return originalValue;
  }
}




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
