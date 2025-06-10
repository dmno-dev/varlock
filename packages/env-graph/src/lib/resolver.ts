import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import _ from '@env-spec/utils/my-dash';
import { Constructor } from '@env-spec/utils/type-utils';

import { ResolutionError, SchemaError } from './errors';
import { ConfigItem } from './config-item';
import { SimpleQueue } from './simple-queue';

const execAsync = promisify(exec);

export type ResolvedValue =
  undefined |
  string | number | boolean;
  // TODO: will probably want to re-enable object/array values
  // { [key: string]: ConfigValue } |
  // Array<ConfigValue>;

// eslint-disable-next-line no-use-before-define
type ResolverFunctionArgs = Array<ResolverInstance> | Record<string, ResolverInstance>;
export abstract class ResolverInstance {
  constructor(readonly fnArgs: ResolverFunctionArgs) {}

  abstract label: string;
  abstract icon: string;
  inferredType?: string;
  _schemaErrors: Array<SchemaError> = [];
  private _depsObj: Record<string, boolean> = {};

  get childResolvers() {
    return _.isArray(this.fnArgs) ? this.fnArgs : _.values(this.fnArgs);
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
export class StaticValueResolver extends ResolverInstance {
  constructor(readonly staticValue: ResolvedValue) {
    super([]);
    this.inferredType = typeof staticValue;
  }

  label = 'static';
  icon = 'bi:dash';

  protected async _resolve() { return this.staticValue; }
  protected async _process() {}
}

// special resolver class that represents an error when an unknown resolver is used
// only used internally, not via `error(x)`
export class ErrorResolver extends ResolverInstance {
  constructor(err: SchemaError) {
    super([]);
    this._schemaErrors.push(err);
  }

  label = 'error';
  icon = 'bi:dash';

  protected async _resolve() { return undefined; }
  protected async _process() { }
}


export class ConcatResolver extends ResolverInstance {
  label = 'concat';
  icon = 'material-symbols:join';
  inferredType = 'string';

  async _process() {
    if (!Array.isArray(this.fnArgs)) {
      throw new SchemaError('concat() expects an array of arguments, not a key-value object');
    }
    if (this.fnArgs.length < 2) {
      throw new SchemaError('concat() expects at least two arguments');
    }
  }

  protected async _resolve() {
    // TODO: generalize this so it becomes reusable for other resolvers
    // maybe a subclass that already handles the args-must-be-an-array case?
    // or could be an option on the base class? but need to figure out TS
    if (!Array.isArray(this.fnArgs)) {
      throw new Error('concat() expects an array of arguments, not a key-value object');
    }

    const resolvedValues = [];
    for (const arg of this.fnArgs) {
      // TODO: handle child resolver failure?
      const resolvedChildValue = await arg.resolve();
      // do we need to worry about non-string-ish things here?
      resolvedValues.push(String(resolvedChildValue ?? ''));
    }
    return resolvedValues.join('');
  }
}

export class FallbackResolver extends ResolverInstance {
  label = 'fallback';
  icon = 'memory:table-top-stairs-up';

  async _process() {
    if (!Array.isArray(this.fnArgs)) {
      throw new SchemaError('fallback() expects an array of arguments, not a key-value object');
    }
    if (this.fnArgs.length < 2) {
      throw new SchemaError('fallback() expects at least two arguments');
    }
  }

  protected async _resolve() {
    if (!Array.isArray(this.fnArgs)) {
      console.log(this.fnArgs);
      throw new Error('concat() expects an array of arguments, not a key-value object');
    }

    for (const arg of this.fnArgs) {
      // TODO: handle child resolver failure?
      const resolvedChildValue = await arg.resolve();
      if (resolvedChildValue !== undefined && resolvedChildValue !== '') {
        return resolvedChildValue;
      }
    }
  }
}

export class ExecResolver extends ResolverInstance {
  label = 'exec';
  icon = 'iconoir:terminal';

  async _process() {
    if (!Array.isArray(this.fnArgs)) {
      throw new SchemaError('exec() expects a single child arg, not a key-value object');
    }
    if (this.fnArgs.length !== 1) {
      throw new SchemaError('exec() expects a single child arg');
    }
  }

  static execQueue = new SimpleQueue();

  protected async _resolve() {
    if (!Array.isArray(this.fnArgs) || this.fnArgs.length !== 1) {
      throw new Error('exec() expects a single child arg');
    }

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

export class RefResolver extends ResolverInstance {
  label = 'ref';
  icon = 'mdi-light:content-duplicate';

  private refKey?: string;

  async _process() {
    if (!Array.isArray(this.fnArgs)) {
      throw new SchemaError('ref() expects a single child arg, not a key-value object');
    }
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

// these are the resolvers which are accessible to end-users as fn calls
export const BaseResolvers: Record<string, Constructor<ResolverInstance>> = {
  concat: ConcatResolver,
  fallback: FallbackResolver,
  ref: RefResolver,
  exec: ExecResolver,
};
