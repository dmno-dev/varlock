import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  createHash, randomBytes, randomUUID, randomInt as cryptoRandomInt,
} from 'node:crypto';

import _ from '@env-spec/utils/my-dash';
import {
  ParsedEnvSpecFunctionArgs, ParsedEnvSpecFunctionCall, ParsedEnvSpecKeyValuePair,
  ParsedEnvSpecStaticValue, ParsedEnvSpecObjectLiteral, ParsedEnvSpecArrayLiteral,
} from '@env-spec/parser';

import { ConfigItem } from './config-item';
import { SimpleQueue } from './simple-queue';
import { ResolutionError, SchemaError, VarlockError } from './errors';
import { parseTtl, TTL_FOREVER } from '../../lib/cache/ttl-parser';
import { parseDuration } from '../../lib/duration';
import {
  generateTotp, normalizeOtpAlgorithm, OTP_ALGORITHMS, OTP_SECRET_ENCODINGS,
  type GeneratedTotp, type OtpAlgorithm, type OtpSecretEncoding,
} from '../../lib/otp';
import { assertValidCacheKey, hasInvalidCacheKeyChars, MAX_CACHE_KEY_LENGTH } from '../../lib/cache/cache-store';
import type { EnvGraphDataSource } from './data-source';
import { DecoratorInstance } from './decorators';
import { getErrorLocation } from './error-location';
import { isBuiltinVar } from './builtin-vars';
import { REGEX_LIKE_STRING, parseRegexLikeString } from './regex-like-string';

type ExecChildOptions = {
  shell: boolean;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
};
type ExecChildFailure = {
  code?: number | string | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  stderr?: string;
};

/**
 * Run a child for `exec()`. The string form passes the whole command as `file`
 * with `shell: true` (same as `child_process.exec`); the argv form passes the
 * program and its arguments with no shell. Unlike the promisified helpers this
 * exposes the child so a value can be written to its stdin.
 */
function runExecChild(file: string, args: Array<string>, opts: ExecChildOptions): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      shell: opts.shell,
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      timeout: opts.timeoutMs,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stderr }));
      } else {
        resolve({ stdout });
      }
    });
    if (child.stdin) {
      // a stdin write can fail if the child exits before reading it (EPIPE); the
      // exit error is the one that matters, so this one is swallowed
      child.stdin.on('error', () => undefined);
      if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

/** Resolve a `key=value` option of `exec()` and check its type. */
async function resolveExecOption(
  objArgs: Record<string, Resolver> | undefined,
  key: string,
): Promise<ResolvedValue> {
  const resolver = objArgs?.[key];
  return resolver ? await resolver.resolve() : undefined;
}

const EXEC_OPTION_KEYS = ['cwd', 'env', 'timeout', 'stdin'];

export { parseRegexLikeString };
/** Whether a string has the `/pattern/flags` shape that consumers read as a regex. */
export function isRegexLikeString(str: unknown): str is string {
  return typeof str === 'string' && REGEX_LIKE_STRING.test(str);
}
/** quote a pattern for an env-spec example - only `"` needs escaping inside a double-quoted value */
const quoteForExample = (str: string) => `"${str.replaceAll('"', '\\"')}"`;

/**
 * Passing a pattern as a STRING - a `/pattern/flags` string anywhere a regex is read, or a
 * plain string on a `matches` option - is deprecated in favour of `regex()`, and goes away
 * in a future major. Emitted wherever such a string is still interpreted, so every schema
 * that relies on it hears about it before the behavior changes. The tip shows the exact
 * `regex()` call for the string it found.
 */
export function deprecatedRegexStringWarning(str: string, context?: string) {
  const literal = str.match(REGEX_LIKE_STRING);
  const replacement = literal
    ? `regex(${quoteForExample(literal[1])}${literal[2] ? `, ${quoteForExample(literal[2])}` : ''})`
    : `regex(${quoteForExample(str)})`;
  return new SchemaError(
    `${context ? `${context} - ` : ''}string patterns are deprecated, use regex() instead`,
    {
      isWarning: true,
      tip: [
        `write it as ${replacement}`,
        'this still works for now, but a future major version will stop reading a string as a regex',
      ],
    },
  );
}

/**
 * `regex()` takes the pattern SOURCE, so a `/.../`-wrapped argument is almost always a JS
 * literal pasted in whole - and it would quietly compile to a pattern matching the slashes
 * themselves. Flags have their own argument here, so there is no reason to carry them
 * inside the string either.
 *
 * Rejected rather than stripped on purpose: `regex("/usr/lib/")` could legitimately be a
 * pattern for a path, and silently guessing which was meant is the thing this avoids.
 */
export function assertUnwrappedRegexSource(pattern: string, context?: string) {
  if (!/^\/.*\/[dgimsuvy]*$/s.test(pattern)) return;
  throw new SchemaError(
    `${context ? `${context} - ` : ''}expects the pattern itself, not a /.../ literal`,
    {
      tip: [
        'drop the surrounding slashes - regex("^abc$") - and pass any flags as a second argument',
        'if the pattern really should match a slash at each end, escape them: regex("\\/usr\\/lib\\/")',
      ],
    },
  );
}

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
    if (this.def.inferredTypeSettings) this.inferredTypeSettings = this.def.inferredTypeSettings;
  }

  static get fnName() { return this.def.name; }

  get def() { return (this.constructor as typeof Resolver).def; }
  get fnName() { return this.def.name; }
  get label() { return this.def.label; }
  get icon() { return this.def.icon; }

  get isStatic() { return false; }
  get staticValue(): ResolvedValue { return undefined; }

  inferredType?: string;
  inferredTypeSettings?: Record<string, any>;
  /** reference to the parsed node that created this resolver, used for error location tracking */
  _parsedNode?: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall
    | ParsedEnvSpecFunctionArgs | ParsedEnvSpecObjectLiteral | ParsedEnvSpecArrayLiteral;
  _errors: Array<SchemaError> = [];

  /**
   * A match value that only turns out to be a `/.../` string once resolved (`$PATTERN`)
   * gets the same deprecation warning a static one gets at process time. Static ones are
   * skipped here since they were already warned about; repeat resolves never stack it.
   */
  protected warnDynamicRegexString(source: Resolver, str: string) {
    // eslint-disable-next-line no-use-before-define
    if (source instanceof StaticValueResolver) return;
    const warning = deprecatedRegexStringWarning(str);
    if (this._errors.some((e) => e.message === warning.message && e.tip === warning.tip)) return;
    this._errors.push(warning);
  }
  private _depsObj: Record<string, boolean> = {};

  get childResolvers(): Array<Resolver> {
    return [
      ...this.arrArgs ?? [],
      ...Object.values(this.objArgs ?? {}),
    ];
  }

  get schemaErrors(): Array<SchemaError> {
    return [
      ...this._errors,
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

  private parent?: ConfigItem | DecoratorInstance;

  private meta: any;
  process(parent?: ConfigItem | DecoratorInstance) {
    this.parent = parent;

    const { argsSchema } = this.def;
    if (argsSchema?.type === 'array' && this.objArgs !== undefined) {
      this._errors.push(new SchemaError('Resolver does not support key-value args'));
    } else if (argsSchema?.type === 'object' && this.arrArgs !== undefined) {
      this._errors.push(new SchemaError('Resolver expects only key-value args'));
    }

    if (argsSchema?.arrayExactLength !== undefined) {
      if (this.arrArgs?.length !== argsSchema.arrayExactLength) {
        this._errors.push(
          new SchemaError(
            `expects exactly ${argsSchema.arrayExactLength} argument${argsSchema.arrayExactLength > 1 ? 's' : ''}`,
          ),
        );
      }
    }
    if (argsSchema?.arrayMinLength !== undefined) {
      if ((this.arrArgs?.length ?? 0) < argsSchema.arrayMinLength) {
        this._errors.push(
          new SchemaError(
            `expects at least ${argsSchema.arrayMinLength} argument${argsSchema.arrayMinLength > 1 ? 's' : ''}`,
          ),
        );
      }
    }
    if (argsSchema?.arrayMaxLength !== undefined) {
      if ((this.arrArgs?.length ?? 0) > argsSchema.arrayMaxLength) {
        this._errors.push(
          new SchemaError(`expects at most ${argsSchema.arrayMaxLength} argument${argsSchema.arrayMaxLength > 1 ? 's' : ''}`),
        );
      }
    }

    if (argsSchema?.objKeyMinLength !== undefined) {
      const objKeyLengths = Object.keys(this.objArgs || {}).length;
      if (objKeyLengths < argsSchema.objKeyMinLength) {
        this._errors.push(
          new SchemaError(
            `expects at least ${argsSchema.objKeyMinLength} key value arg${argsSchema.objKeyMinLength > 1 ? 's' : ''}`,
          ),
        );
      }
    }

    // call specific resolve fn for the resolver
    if (this._errors.length === 0) {
      try {
        this.meta = this.def.process?.call(this);
      } catch (error) {
        if (error instanceof SchemaError) {
          this._errors.push(error);
        } else if (error instanceof Error) {
          this._errors.push(new SchemaError(error));
        } else {
          throw new Error(`Non-error thrown while processing resolver - ${error}`);
        }
      }
    }

    // adding fn name to resolver schema errors
    if (!this.def.name.startsWith('\0')) {
      for (const e of this._errors) {
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
    if (!depItem.isValid) {
      // include the dep's own errors - when this surfaces from a root decorator, item-level
      // errors are never printed (config checks are skipped once there are schema errors)
      const depErrors = depItem.errors.filter((e) => !e.isWarning).map((e) => `- ${e.message}`);
      throw new ResolutionError(`Referenced item "${key}" is not valid`, {
        ...depErrors.length && { tip: [`${key} errors:`, ...depErrors] },
      });
    }
    // a valid-but-unresolved dep means the calling context forgot to resolve deps
    // first (see earlyResolve / resolveEnvValues); returning resolvedValue here
    // would silently produce undefined instead of the item's actual value
    if (!depItem.isResolved) throw new Error(`Referenced item "${key}" has not been resolved yet`);
    if (depItem.isBuiltin) depItem._builtinValueUsed = true;
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
  /** settings passed to the inferred data type when it is instantiated */
  inferredTypeSettings?: Record<string, any>;
  /** If true, using this resolver implies the item is sensitive (unless explicitly overridden) */
  impliesSensitive?: boolean;
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
    if (_staticValue !== undefined && !(_staticValue instanceof RegExp)) {
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

// resolver for a standalone object literal `{ k=v, ... }` — resolves to a plain object
export class ObjectLiteralResolver extends Resolver {
  static def = {
    name: '\0objectLiteral', // used internally, so we add the extra \0
    label: 'object literal',
    icon: 'bi:braces',
    resolve() { return undefined; },
  };
  get isStatic() {
    // static when every value is static
    return Object.values(this.objArgs ?? {}).every((r) => r.isStatic);
  }
  async resolve() {
    const obj = {} as Record<string, any>;
    for (const key in this.objArgs) {
      obj[key] = await this.objArgs[key].resolve();
    }
    return obj;
  }
}

// resolver for a standalone array literal `[ v, ... ]` — resolves to a plain array
export class ArrayLiteralResolver extends Resolver {
  static def = {
    name: '\0arrayLiteral', // used internally, so we add the extra \0
    label: 'array literal',
    icon: 'bi:bracket',
    resolve() { return undefined; },
  };
  get isStatic() {
    return (this.arrArgs ?? []).every((r) => r.isStatic);
  }
  async resolve() {
    const arr = [] as Array<any>;
    for (const arg of this.arrArgs ?? []) {
      arr.push(await arg.resolve());
    }
    return arr;
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
    this._errors.push(err);
  }
}

export function createResolver<T>(
  def: ResolverDef<T>,
  /** used when the def doesn't set its own, e.g. a plugin's icon for the resolvers it registers */
  defaults?: { icon?: string },
) {
  const ResolverClass = class extends Resolver {};
  ResolverClass.def = def.icon || !defaults?.icon ? def : { ...def, icon: defaults.icon };
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

/** `$1`..`$9`, `${10}`, `$@`, `$*`: how a shell command reads the values passed after it */
const SHELL_POSITIONAL_REF = /\$(?:[1-9]|\{\d+\}|[@*])/;

/** How an `exec()` value arg would be written as a positional value, or undefined if it can't be */
function execValueSource(part: Resolver): string | undefined {
  if (part.fnName === 'ref' && part.arrArgs?.[0] instanceof StaticValueResolver) {
    return `$${String(part.arrArgs[0].staticValue)}`;
  }
  return part._parsedNode?.toString();
}

/** Static command text the array-form rewrite can handle: plain words, spaces and double quotes */
const EXEC_PLAIN_TEXT = /^[A-Za-z0-9_\-./:=@%+, "]*$/;

/**
 * Rewrite a shell command made of plain words, double quotes and values as an
 * array-form `exec()`, e.g. `./load.sh --env ${APP_ENV}` becomes
 * `exec(["./load.sh", "--env", $APP_ENV])`. A word that mixes text and refs
 * becomes one string using env-spec's own `${}` expansion. Returns undefined
 * if any part can't be written that way.
 */
function execArrayFormSuggestion(parts: Array<Resolver>): string | undefined {
  type Piece = { text: string } | { value: Resolver };
  const words: Array<Array<Piece>> = [];
  let current: Array<Piece> | undefined;
  let inQuotes = false;
  for (const part of parts) {
    if (!(part instanceof StaticValueResolver)) {
      current ??= [];
      if (!words.includes(current)) words.push(current);
      current.push({ value: part });
      continue;
    }
    const text = String(part.staticValue ?? '');
    if (!EXEC_PLAIN_TEXT.test(text)) return;
    for (const char of text) {
      if (char === ' ' && !inQuotes) {
        current = undefined;
        continue;
      }
      current ??= [];
      if (!words.includes(current)) words.push(current);
      if (char === '"') inQuotes = !inQuotes;
      else current.push({ text: char });
    }
  }
  if (inQuotes) return;

  const elements: Array<string> = [];
  for (const word of words) {
    if (word.length === 1 && 'value' in word[0]) {
      const source = execValueSource(word[0].value);
      if (!source) return;
      elements.push(source);
      continue;
    }
    let str = '';
    for (const piece of word) {
      if ('text' in piece) str += piece.text;
      else if (piece.value.fnName === 'ref' && piece.value.arrArgs?.[0] instanceof StaticValueResolver) {
        str += `\${${String(piece.value.arrArgs[0].staticValue)}}`;
      } else return; // a function inside a word has no string-expansion form
    }
    elements.push(`"${str}"`);
  }
  return elements.length ? `exec([${elements.join(', ')}])` : undefined;
}

/**
 * Tips for a shell-form `exec()` whose command is not fixed text. When the
 * command is a template (`${REF}`s in static text), spell out the rewrite:
 * the array form if the text has no shell syntax, otherwise the same command
 * reading `"$1"`, `"$2"`... with the values passed after it.
 */
function execShellCommandTips(arg: Resolver): Array<string> {
  const posix = process.platform !== 'win32';
  if (arg.fnName !== 'concat' || !arg.arrArgs?.length) {
    // a value or function as the whole command: exec($CMD), exec(if(...))
    return [
      'to pick the program from a value, use the array form, which runs it with no shell: exec([$CLI, "get", $ITEM])',
      'to switch between fixed commands, wrap the calls instead: if($IS_PROD, exec(`prod-cli get`), exec(`dev-cli get`))',
    ];
  }

  const tips: Array<string> = [];
  const arrayForm = execArrayFormSuggestion(arg.arrArgs);
  if (arrayForm) tips.push(`use the array form, which runs the program with no shell: ${arrayForm}`);

  // otherwise keep the shell command, reading each value as "$1", "$2"... That is only
  // a mechanical rewrite when the text has no quotes or escapes of its own, which would
  // change what the inserted "$1" means.
  let command = '';
  const values: Array<string> = [];
  let canRewrite = true;
  let hasRef = false;
  for (const part of arg.arrArgs) {
    if (part instanceof StaticValueResolver) {
      const text = String(part.staticValue ?? '');
      if (/['"`\\]/.test(text)) canRewrite = false;
      command += text;
    } else {
      const source = execValueSource(part);
      if (!source) canRewrite = false;
      if (part.fnName === 'ref') hasRef = true;
      values.push(source ?? '');
      command += `"$${values.length}"`;
    }
  }
  if (!tips.length && canRewrite && posix) {
    tips.push(`keep the shell command and pass the values after it, where it reads them as "$1", "$2"...: exec(\`${command}\`, ${values.join(', ')})`);
  }
  if (!tips.length) {
    tips.push(posix
      ? 'use the array form, which runs the program with no shell (exec(["my-cli", "get", $ITEM])), or pass values after the shell command and read them as "$1", "$2"... (exec(`my-cli get "$1" | jq -r .value`, $ITEM))'
      : 'use the array form, which runs the program with no shell: exec(["my-cli", "get", $ITEM])');
  }
  if (hasRef && posix) {
    tips.push('if you meant a shell variable (for example one set with env=), write the command in single quotes: env-spec reads $NAME inside backticks and double quotes as a reference to another item');
  }
  return tips;
}

export const ExecResolver: typeof Resolver = createResolver({
  name: 'exec',
  icon: 'iconoir:terminal',
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 1,
  },
  process() {
    for (const key of Object.keys(this.objArgs ?? {})) {
      if (!EXEC_OPTION_KEYS.includes(key)) {
        throw new SchemaError(`does not accept a "${key}" option (expected one of ${EXEC_OPTION_KEYS.join(', ')})`);
      }
    }
    const [command, ...values] = this.arrArgs!;

    // array form: exec(["./script", "--env", $APP_ENV]) runs the program directly, no shell
    if (command instanceof ArrayLiteralResolver) {
      if (!command.arrArgs?.length) throw new SchemaError('array form needs at least the program: exec(["my-cli", "arg"])');
      if (values.length) {
        const sources = [...command.arrArgs, ...values].map((r) => (
          r instanceof StaticValueResolver ? JSON.stringify(String(r.staticValue ?? '')) : execValueSource(r)
        ));
        throw new SchemaError('the array form takes all of its arguments inside the array', {
          tip: `move them into the array: ${sources.every(Boolean) ? `exec([${sources.join(', ')}])` : 'exec(["my-cli", "get", $ITEM])'}`,
        });
      }
      return;
    }

    // shell form: the command runs through the shell, so it must be fixed text. A value
    // (`${REF}`, `$CMD`, a nested call) can come from the process environment or a
    // .env.local, and spliced into the command it would be read as shell syntax.
    if (!(command instanceof StaticValueResolver) || typeof command.staticValue !== 'string') {
      throw new SchemaError('a shell command must be fixed text: a value inserted into it could run as shell code', {
        tip: execShellCommandTips(command),
      });
    }
    if (values.length) {
      if (process.platform === 'win32') {
        throw new SchemaError('values after a shell command ("$1", "$2"...) need a POSIX shell, which Windows does not have', {
          tip: 'use the array form, which works everywhere: exec(["my-cli", "get", $ITEM])',
        });
      }
      if (!SHELL_POSITIONAL_REF.test(command.staticValue)) {
        // most likely meant as program + arguments, so spell out the array form for it
        const asArray = EXEC_PLAIN_TEXT.test(command.staticValue) && !command.staticValue.includes('"')
          ? execArrayFormSuggestion([command, ...values].flatMap((v, i) => (i ? [new StaticValueResolver(' '), v] : [v])))
          : undefined;
        throw new SchemaError('values after a shell command are passed to it as "$1", "$2"..., but this command does not use them', {
          tip: [
            `to pass arguments to a program, use the array form: ${asArray ?? 'exec(["my-cli", "get", $ITEM])'}`,
            'or read the values in the command: exec(`my-cli get "$1"`, $ITEM)',
          ],
        });
      }
    }
  },
  async resolve() {
    const args = this.arrArgs!;

    // options: cwd= (relative to the env file), env= (object literal, added to the
    // child's environment), timeout= (duration), stdin= (written to the child's stdin).
    // env and stdin exist so a secret can reach a CLI without going through argv,
    // which every process on the machine can read via `ps`.
    const childOpts: ExecChildOptions = { shell: false };

    const cwdVal = await resolveExecOption(this.objArgs, 'cwd');
    if (cwdVal !== undefined) {
      if (typeof cwdVal !== 'string' || !cwdVal) throw new ResolutionError('cwd= must be a non-empty string');
      const ds = this.dataSource as { fullPath?: string } | undefined;
      const baseDir = ds?.fullPath ? path.dirname(ds.fullPath) : process.cwd();
      childOpts.cwd = path.resolve(baseDir, cwdVal);
    }

    const envVal = await resolveExecOption(this.objArgs, 'env');
    if (envVal !== undefined) {
      if (!_.isPlainObject(envVal)) throw new ResolutionError('env= must be an object literal, e.g. env={TOKEN=$TOKEN}');
      childOpts.env = {};
      for (const [k, v] of Object.entries(envVal as Record<string, ResolvedValue>)) {
        if (v === undefined || v === null) continue;
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
          throw new ResolutionError(`env= value for "${k}" must resolve to a string`);
        }
        childOpts.env[k] = String(v);
      }
    }

    const timeoutVal = await resolveExecOption(this.objArgs, 'timeout');
    if (timeoutVal !== undefined) {
      if (typeof timeoutVal !== 'string' && typeof timeoutVal !== 'number') {
        throw new ResolutionError('timeout= must be a duration like "30s" or "2m"');
      }
      try {
        childOpts.timeoutMs = parseDuration(timeoutVal);
      } catch (err) {
        throw new ResolutionError(`timeout= is not a valid duration: ${(err as Error).message}`);
      }
      if (childOpts.timeoutMs <= 0) throw new ResolutionError('timeout= must be greater than 0');
    }

    const stdinVal = await resolveExecOption(this.objArgs, 'stdin');
    if (stdinVal !== undefined && stdinVal !== null) {
      if (typeof stdinVal !== 'string' && typeof stdinVal !== 'number' && typeof stdinVal !== 'boolean') {
        throw new ResolutionError('stdin= must resolve to a string');
      }
      childOpts.stdin = String(stdinVal);
    }

    const toArgString = (v: ResolvedValue, what: string) => {
      if (v === undefined || v === null) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      throw new ResolutionError(`${what} must resolve to strings`);
    };

    let run: () => Promise<{ stdout: string }>;
    const [command, ...values] = args;
    if (command instanceof ArrayLiteralResolver) {
      // array form: no shell, each element is exactly one argument to the program
      const argv: Array<string> = [];
      for (const el of command.arrArgs ?? []) argv.push(toArgString(await el.resolve(), 'array elements'));
      const [file, ...fileArgs] = argv;
      if (!file) throw new ResolutionError('array form needs a non-empty program as its first element');
      run = () => runExecChild(file, fileArgs, childOpts);
    } else {
      const commandStr = (command as StaticValueResolver).staticValue as string;
      if (!commandStr) throw new ResolutionError('needs a non-empty command');
      if (values.length) {
        // shell form with values: `sh -c <command> sh <values...>`, so the command reads
        // them as "$1", "$2"... The shell expands a parameter as data and never
        // re-parses it, so a value cannot add commands.
        const positional: Array<string> = [];
        for (const v of values) positional.push(toArgString(await v.resolve(), 'values'));
        run = () => runExecChild('/bin/sh', ['-c', commandStr, 'sh', ...positional], childOpts);
      } else {
        run = () => runExecChild(commandStr, [], { ...childOpts, shell: true });
      }
    }

    try {
      // ? NOTE - putting these calls through a simple queue for now
      // this avoids multiple 1password auth popups, but it also makes multiple 1p calls very slow
      // we likely want to remove this once we have the specific 1Password plugin re-implemented
      const { stdout } = await execQueue.enqueue(run);
      // trim trailing newline by default
      // we could allow options here?
      return stdout.replace(/\n$/, '');
    } catch (err) {
      // surface the exit code and stderr on the error itself rather than logging here -
      // a stray log would land in stdout and corrupt machine-readable output (e.g. json-full).
      // stdout is left out since it may contain a partially-printed secret, and the command
      // is reported as written in the schema (not with values filled in) for the same
      // reason: a $SECRET passed as an argument must not land in error output.
      const execErr = err as ExecChildFailure;
      const timedOut = execErr.killed && childOpts.timeoutMs !== undefined;
      let exitInfo = '';
      if (timedOut) exitInfo = ` (timed out after ${timeoutVal})`;
      else if (execErr.code !== undefined && execErr.code !== null) exitInfo = ` (exit code ${execErr.code})`;
      const stderr = execErr.stderr?.trim();
      const asWritten = this._parsedNode?.toString();
      throw new ResolutionError(`command failed${exitInfo}${asWritten ? `: ${asWritten}` : ''}`, {
        ...stderr && { tip: `stderr:\n${stderr}` },
      });
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

    // Auto-register builtin vars when referenced. Also when the item is already declared
    // (e.g. `VARLOCK_ENV=` to attach decorators): an early-resolved env flag may depend on it
    // before finishLoad attaches builtin defs to declared items
    if (isBuiltinVar(refKey)) {
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
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    if (!(this.arrArgs?.[0] instanceof StaticValueResolver)) {
      throw new SchemaError('expects a static pattern passed in');
    }
    const regexStr = this.arrArgs[0].staticValue;
    if (typeof regexStr !== 'string') {
      throw new SchemaError('expects a string');
    }
    assertUnwrappedRegexSource(regexStr);
    let flags: string | undefined;
    if (this.arrArgs[1] !== undefined) {
      if (!(this.arrArgs[1] instanceof StaticValueResolver)) {
        throw new SchemaError('flags must be a static value');
      }
      const flagsVal = this.arrArgs[1].staticValue;
      if (typeof flagsVal !== 'string') throw new SchemaError('flags must be a string');
      flags = flagsVal;
    }
    try {
      return new RegExp(regexStr, flags);
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
      this._errors.push(new SchemaError('key=value syntax is deprecated', {
        isWarning: true,
        tip: 'Use positional pairs instead: remap($VAR, match1, result1, match2, result2, ...)',
      }));
    } else {
      // new positional mode: 3+ args (value, match1, result1, ...)
      if ((this.arrArgs?.length ?? 0) < 3) {
        throw new SchemaError('expects at least 3 arguments: (value, match1, result1, ...)');
      }
    }
    // match values: every other positional after the source, or the object values in legacy mode
    const matchResolvers = isLegacyKeyValMode
      ? Object.values(this.objArgs!)
      : (this.arrArgs ?? []).filter((_arg, i) => i >= 1 && (i - 1) % 2 === 0);
    const regexString = matchResolvers.find((r) => (
      r instanceof StaticValueResolver && isRegexLikeString(r.staticValue)
    )) as StaticValueResolver | undefined;
    if (regexString) this._errors.push(deprecatedRegexStringWarning(regexString.staticValue as string));
    return { isLegacyKeyValMode };
  },
  async resolve({ isLegacyKeyValMode }) {
    const originalValue = await this.arrArgs![0].resolve();

    if (isLegacyKeyValMode) {
      // legacy key=value mode: key is the result, value is what to match against
      for (const [remappedVal, matchValResolver] of Object.entries(this.objArgs!)) {
        const matchVal = await matchValResolver.resolve();
        // support regex-like unquoted strings (e.g., /pattern/flags) and regex() fn
        if (matchVal instanceof RegExp) {
          if (originalValue !== undefined && matchVal.test(String(originalValue))) return remappedVal;
          continue;
        }
        if (typeof matchVal === 'string') {
          const regex = parseRegexLikeString(matchVal);
          if (regex) {
            this.warnDynamicRegexString(matchValResolver, matchVal);
            if (originalValue !== undefined && regex.test(String(originalValue))) return remappedVal;
            continue;
          }
        }
        if (matchVal === originalValue) return remappedVal;
      }
      return originalValue;
    }

    const remainingArgs = this.arrArgs!.slice(1);
    // iterate in pairs of (match, result); `i + 1 < length` ensures we
    // process only complete pairs, leaving a potential trailing default unprocessed
    for (let i = 0; i + 1 < remainingArgs.length; i += 2) {
      const matchVal = await remainingArgs[i].resolve();
      // support regex-like unquoted strings (e.g., /pattern/flags) and regex() fn
      if (matchVal instanceof RegExp) {
        if (originalValue !== undefined && matchVal.test(String(originalValue))) return remainingArgs[i + 1].resolve();
        continue;
      }
      if (typeof matchVal === 'string') {
        const regex = parseRegexLikeString(matchVal);
        if (regex) {
          this.warnDynamicRegexString(remainingArgs[i], matchVal);
          if (originalValue !== undefined && regex.test(String(originalValue))) return remainingArgs[i + 1].resolve();
          continue;
        }
      }
      if (matchVal === originalValue) return remainingArgs[i + 1].resolve();
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
    return this.arrArgs!;
  },
  async resolve(matchEnvArgs) {
    // this will trigger resolution of the current env if not already done
    const currentEnv = await this.getCurrentEnv();
    if (!currentEnv) throw new SchemaError('current environment is not set');
    const matchEnvs: Array<string> = [];
    for (const arg of matchEnvArgs) {
      const argValue = await arg.resolve();
      // stringifying undefined would give "undefined", which silently never matches
      // (or false-matches an env literally named "undefined") - fail loudly instead
      if (argValue === undefined) {
        throw new SchemaError('argument resolved to undefined - check that any referenced variables are set');
      }
      matchEnvs.push(String(argValue));
    }
    return matchEnvs.includes(currentEnv);
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
      this.inferredTypeSettings = trueVal.inferredTypeSettings;
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

export const AndResolver: typeof Resolver = createResolver({
  name: 'and',
  icon: 'material-symbols:join-inner',
  inferredType: 'boolean',
  argsSchema: {
    type: 'array',
    arrayMinLength: 2,
  },
  async resolve() {
    // short-circuit - later args are not resolved once the result is known
    for (const arg of this.arrArgs!) {
      if (!await arg.resolve()) return false;
    }
    return true;
  },
});

export const OrResolver: typeof Resolver = createResolver({
  name: 'or',
  icon: 'material-symbols:join-full',
  inferredType: 'boolean',
  argsSchema: {
    type: 'array',
    arrayMinLength: 2,
  },
  async resolve() {
    // short-circuit - later args are not resolved once the result is known
    for (const arg of this.arrArgs!) {
      if (await arg.resolve()) return true;
    }
    return false;
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


/**
 * Pulls the host out of a URL using the WHATWG parser rather than a regex, so a value that
 * merely looks like it points somewhere trusted (`https://trusted.example@evil.example/`)
 * yields the host a request would actually be sent to.
 */
function extractDomainFromUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;

  // A leading `scheme://` means the value carries its own authority, so parse it as-is.
  // Anything else without a scheme (`example.com`, `example.com:8080/path`) is a bare host and
  // gets a protocol prepended - `URL` would otherwise read `example.com:` as a non-special
  // scheme and find no host at all. `:<digits>` is what separates a bare host with a port from
  // a genuine scheme-less URL like `mailto:someone@example.com`.
  const hasAuthority = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  const isBareHost = !hasAuthority && (
    !/^[a-z][a-z\d+.-]*:/i.test(trimmed) || /^[^\s:/?#]+:\d+(?:[/?#]|$)/.test(trimmed)
  );

  try {
    const parsed = new URL(isBareHost ? `https://${trimmed}` : trimmed);
    // non-special schemes (`mailto:`, `urn:`, custom protocols) have no host at all
    // `URL` has already lowercased and punycoded the hostname for us
    if (!parsed.hostname) return undefined;
    // a fully qualified host may carry the root label (`example.com.`) - it names the same
    // host, and the trailing dot would fail every downstream hostname check, so drop it
    if (parsed.hostname.endsWith('.') && parsed.hostname !== '.') {
      return parsed.hostname.slice(0, -1);
    }
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

export const DomainFromUrlResolver: typeof Resolver = createResolver({
  name: 'domainFromUrl',
  icon: 'mdi:web',
  inferredType: 'domain',
  // the input is any url, so the result can legitimately be a single-label host (`localhost`)
  // or an ip literal - the type is here to describe the value, not to narrow it
  inferredTypeSettings: { allowSingleLabel: true, allowIp: true, allowIpV6: true },
  argsSchema: {
    type: 'array',
    arrayExactLength: 1,
  },
  async resolve() {
    const value = await this.arrArgs![0].resolve();
    // an empty input stays empty rather than becoming an error, so this composes with
    // optional items - fallback()/if() upstream still see undefined
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') {
      throw new ResolutionError('expects a string url');
    }
    const domain = extractDomainFromUrl(value);
    if (domain === undefined) {
      throw new ResolutionError('unable to extract a domain from the value', {
        tip: 'expects a url like `https://api.example.com/path` or a bare host like `example.com`',
      });
    }
    return domain;
  },
});


// ── Random value generators ────────────────────────────────────────────

/**
 * Generates a uniform [0, 1) double using CSPRNG bytes, avoiding the
 * predictability of Math.random (V8's xorshift128+).
 */
function cryptoRandomFloat01(): number {
  // upper 53 bits of an 8-byte CSPRNG draw → uniform double in [0, 1)
  const buf = randomBytes(8);
  // eslint-disable-next-line no-bitwise
  const hi = buf.readUInt32BE(0) >>> 5; // 27 bits
  // eslint-disable-next-line no-bitwise
  const lo = buf.readUInt32BE(4) >>> 6; // 26 bits
  return (hi * 2 ** 26 + lo) / 2 ** 53;
}

export const RandomNumResolver: typeof Resolver = createResolver({
  name: 'randomNum',
  description: 'Generate a random number. Integer by default; pass `precision=N` to return a float.',
  icon: 'mdi:dice-multiple',
  inferredType: 'number',
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    const args = this.arrArgs ?? [];
    let min = 0;
    let max: number;
    if (args.length === 1) {
      if (!args[0].isStatic || typeof args[0].staticValue !== 'number') {
        throw new SchemaError('randomNum() max argument must be a static number');
      }
      max = args[0].staticValue as number;
    } else {
      if (!args[0].isStatic || typeof args[0].staticValue !== 'number') {
        throw new SchemaError('randomNum() min argument must be a static number');
      }
      if (!args[1].isStatic || typeof args[1].staticValue !== 'number') {
        throw new SchemaError('randomNum() max argument must be a static number');
      }
      min = args[0].staticValue as number;
      max = args[1].staticValue as number;
    }
    if (min > max) {
      throw new SchemaError(`randomNum() min (${min}) must be <= max (${max})`);
    }

    let precision: number | undefined;
    const precisionResolver = this.objArgs?.precision;
    if (precisionResolver) {
      if (!precisionResolver.isStatic || typeof precisionResolver.staticValue !== 'number') {
        throw new SchemaError('randomNum() precision must be a static integer');
      }
      precision = precisionResolver.staticValue as number;
      if (!Number.isInteger(precision) || precision < 0 || precision > 20) {
        throw new SchemaError('randomNum() precision must be an integer in [0, 20]');
      }
    }

    // integer mode (default): require integer bounds for predictable results
    if (precision === undefined && (!Number.isInteger(min) || !Number.isInteger(max))) {
      throw new SchemaError('randomNum() arguments must be integers when `precision` is not set');
    }

    return { min, max, precision };
  },
  async resolve({ min, max, precision }) {
    if (precision === undefined) {
      // crypto.randomInt is exclusive on upper bound, so +1 for inclusive
      return cryptoRandomInt(min, max + 1);
    }
    const value = min + cryptoRandomFloat01() * (max - min);
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
  description: 'Generate a random hex string. Length is in characters by default; pass `bytes=true` to treat it as byte length.',
  icon: 'mdi:dice-multiple',
  inferredType: 'string',
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 0,
    arrayMaxLength: 1,
  },
  process() {
    const args = this.arrArgs ?? [];
    let n = 32; // default 32 hex chars
    if (args.length === 1) {
      if (!args[0].isStatic || typeof args[0].staticValue !== 'number') {
        throw new SchemaError('randomHex() length argument must be a static number');
      }
      n = args[0].staticValue as number;
      if (!Number.isInteger(n) || n < 1) {
        throw new SchemaError('randomHex() length must be a positive integer');
      }
    }

    let bytesMode = false;
    const bytesResolver = this.objArgs?.bytes;
    if (bytesResolver) {
      if (!bytesResolver.isStatic || typeof bytesResolver.staticValue !== 'boolean') {
        throw new SchemaError('randomHex() bytes must be a static boolean');
      }
      bytesMode = bytesResolver.staticValue as boolean;
    }

    return { n, bytesMode };
  },
  async resolve({ n, bytesMode }) {
    if (bytesMode) return randomBytes(n).toString('hex');
    // string-length mode: generate ceil(n/2) bytes (each byte = 2 hex chars), slice to exact length
    return randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
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
    // rejection sampling to avoid modulo bias when charset.length doesn't divide 256.
    // discard any byte in the "tail" region [256 - (256 % L), 256) so the remaining
    // bytes map uniformly across [0, L) via modulo.
    const L = charset.length;
    const cap = 256 - (256 % L);
    let result = '';
    while (result.length < length) {
      // overshoot a bit since we expect to reject some bytes; ~1.05x is plenty for L <= 128
      const needed = length - result.length;
      const buf = randomBytes(Math.ceil(needed * 1.1) + 8);
      for (let i = 0; i < buf.length && result.length < length; i++) {
        if (buf[i] < cap) result += charset[buf[i] % L];
      }
    }
    return result;
  },
});

// ── One-time passwords ─────────────────────────────────────────────────

export const GenerateOtpResolver: typeof Resolver = createResolver({
  name: 'generateOtp',
  description: 'Generate a time-based one-time password (TOTP) code from a shared secret',
  icon: 'mdi:timer-lock-outline',
  inferredType: 'string',
  argsSchema: {
    type: 'mixed',
    arrayExactLength: 1,
  },
  process() {
    // note that the secret itself is usually not static (a ref, encrypted value,
    // or plugin fn call) so it only gets validated at resolution time
    const secretResolver = this.arrArgs![0];

    let digits: number | undefined;
    const digitsResolver = this.objArgs?.digits;
    if (digitsResolver) {
      if (!digitsResolver.isStatic || typeof digitsResolver.staticValue !== 'number') {
        throw new SchemaError('digits must be a static number');
      }
      digits = digitsResolver.staticValue as number;
      if (!Number.isInteger(digits) || digits < 6 || digits > 10) {
        throw new SchemaError('digits must be an integer in [6, 10]');
      }
    }

    let period: number | undefined;
    const periodResolver = this.objArgs?.period;
    if (periodResolver) {
      if (!periodResolver.isStatic) {
        throw new SchemaError('period must be a static value');
      }
      const periodVal = periodResolver.staticValue;
      if (typeof periodVal === 'number') {
        // bare numbers are seconds here (not ms like `cache()` ttl) since that is
        // how every TOTP setup screen expresses it
        period = periodVal;
      } else if (typeof periodVal === 'string') {
        try {
          period = parseDuration(periodVal) / 1000;
        } catch (err) {
          throw new SchemaError(err instanceof Error ? err.message : String(err));
        }
      } else {
        throw new SchemaError('period must be a number of seconds or a duration string like "60s"');
      }
      // sub-second windows are never a real TOTP config, and catch `period="60"`,
      // which the duration parser reads as 60ms
      if (!Number.isFinite(period) || period < 1) {
        throw new SchemaError('period must be at least 1 second');
      }
    }

    let algorithm: OtpAlgorithm | undefined;
    const algorithmResolver = this.objArgs?.algorithm;
    if (algorithmResolver) {
      if (!algorithmResolver.isStatic || typeof algorithmResolver.staticValue !== 'string') {
        throw new SchemaError('algorithm must be a static string');
      }
      algorithm = normalizeOtpAlgorithm(algorithmResolver.staticValue as string);
      if (!algorithm) {
        throw new SchemaError(`algorithm must be one of: ${OTP_ALGORITHMS.join(', ')}`);
      }
    }

    let encoding: OtpSecretEncoding | undefined;
    const encodingResolver = this.objArgs?.encoding;
    if (encodingResolver) {
      if (!encodingResolver.isStatic || typeof encodingResolver.staticValue !== 'string') {
        throw new SchemaError('encoding must be a static string');
      }
      const encodingVal = String(encodingResolver.staticValue).toLowerCase();
      if (!(OTP_SECRET_ENCODINGS as ReadonlyArray<string>).includes(encodingVal)) {
        throw new SchemaError(`encoding must be one of: ${OTP_SECRET_ENCODINGS.join(', ')}`);
      }
      encoding = encodingVal as OtpSecretEncoding;
    }

    return {
      secretResolver, digits, period, algorithm, encoding,
    };
  },
  async resolve({
    secretResolver, digits, period, algorithm, encoding,
  }) {
    const secret = await secretResolver.resolve();
    if (typeof secret !== 'string' || !secret) {
      throw new ResolutionError('expects a non-empty string secret', {
        tip: 'The secret should be the base32 seed (or `otpauth://totp/...` URI) from your 2FA setup',
      });
    }

    let generated: GeneratedTotp;
    try {
      generated = generateTotp({
        secret, digits, period, algorithm, encoding,
      });
    } catch (err) {
      // error messages from otp.ts never contain the secret itself
      throw new ResolutionError(`failed to generate code: ${err instanceof Error ? err.message : String(err)}`, {
        tip: 'The secret should be the base32 seed (or `otpauth://totp/...` URI) from your 2FA setup',
      });
    }

    return generated.code;
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
      // the settings travel with the type - without them a forwarded `domain` type would be
      // instantiated with stricter defaults than the child resolver's own value can satisfy
      this.inferredTypeSettings = childResolver.inferredTypeSettings;
    }

    // warn if the child resolver is a static value — caching a literal is pointless
    if (childResolver instanceof StaticValueResolver) {
      this._errors.push(new SchemaError(
        'wraps a static value which never changes — caching has no effect',
        { isWarning: true },
      ));
    }

    // a one-time password is only valid within its current time window, so a
    // cached one is always either stale or about to be
    if (childResolver?.fnName === 'generateOtp') {
      throw new SchemaError('cannot cache generateOtp(), since codes expire', {
        tip: 'Cache the secret instead, e.g. `generateOtp(cache(op("op://vault/item/totp seed")))`',
      });
    }

    // optional explicit cache key
    const keyResolver = this.objArgs?.key;
    let customKey: string | undefined;
    if (keyResolver) {
      if (!keyResolver.isStatic || typeof keyResolver.staticValue !== 'string') {
        throw new SchemaError('key must be a static string');
      }
      customKey = keyResolver.staticValue as string;
      try {
        assertValidCacheKey(customKey, 'cache key');
      } catch (err) {
        throw new SchemaError(err instanceof Error ? err.message : String(err));
      }
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
        throw new SchemaError('ttl must be a duration string like "1h", "forever", or a number of milliseconds');
      }
      try {
        parseTtl(ttlVal);
      } catch (err) {
        throw new SchemaError(err instanceof Error ? err.message : String(err));
      }
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
      const itemKey = item?.key ?? 'unknown';
      cacheKey = `resolver:${filePath}:${itemKey}:${resolverText}`;
      // auto keys must never hard-fail key validation — fall back to hashing when
      // the resolver text is too long or contains characters a key can't hold
      if (cacheKey.length > MAX_CACHE_KEY_LENGTH || hasInvalidCacheKeyChars(cacheKey)) {
        const digest = createHash('sha256').update(cacheKey).digest('hex');
        cacheKey = `resolver:${filePath}:${itemKey}:sha256:${digest.slice(0, 16)}`;
        if (cacheKey.length > MAX_CACHE_KEY_LENGTH || hasInvalidCacheKeyChars(cacheKey)) {
          cacheKey = `resolver:sha256:${digest}`;
        }
      }
    }

    if (cacheStore && !ctx?.skipCache) {
      const ttlMs = state.ttl != null ? parseTtl(state.ttl) : TTL_FOREVER;
      const result = await cacheStore.getOrSet(cacheKey, ttlMs, async () => await childResolver.resolve());
      if (!result) return undefined;
      if (result.cacheHit) {
        ctx?.cacheHits.push({ cacheKey, cachedAt: result.cachedAt, expiresAt: result.expiresAt });
      }
      return result.value;
    }

    return await childResolver.resolve();
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
  RandomNumResolver,
  RandomUuidResolver,
  RandomHexResolver,
  RandomStringResolver,
  GenerateOtpResolver,
  CacheResolver,
  RemapResolver,
  IfsResolver,
  ForEnvResolver,
  EqResolver,
  IfResolver,
  NotResolver,
  AndResolver,
  OrResolver,
  IsEmptyResolver,
  DomainFromUrlResolver,
  RegexResolver,
  InferFromPrefixResolver,
];

/// /

// An unquoted value shaped like `fn(...)` that the parser could not read as a function
// call (e.g. an unquoted arg containing a space) falls back to a plain string. That is
// almost always a mistake, so we error rather than silently using the literal text
// (which could otherwise be shipped as a "secret"). In decorators, a space splits the
// call into the value `fn(a` plus stray text `b)`, so that shape is passed in too.
const LOOKS_LIKE_FN_CALL_REGEX = /^([a-zA-Z][a-zA-Z0-9_]*)\(.*\)$/s;
const STARTS_LIKE_FN_CALL_REGEX = /^([a-zA-Z][a-zA-Z0-9_]*)\(/;
export function getMalformedFunctionCallError(
  parsedValue: unknown,
  opts?: { decoratorName?: string, strayText?: string },
) {
  if (!(parsedValue instanceof ParsedEnvSpecStaticValue)) return;
  if (parsedValue.data.quote || typeof parsedValue.data.rawValue !== 'string') return;
  const rawValue = parsedValue.data.rawValue.trim();
  const fnName = opts?.strayText?.includes(')')
    ? rawValue.match(STARTS_LIKE_FN_CALL_REGEX)?.[1]
    : rawValue.match(LOOKS_LIKE_FN_CALL_REGEX)?.[1];
  if (!fnName) return;
  const subject = opts?.decoratorName ? `@${opts.decoratorName} value` : 'Value';
  return new SchemaError(`${subject} looks like a call to ${fnName}() but could not be parsed as a function call`, {
    tip: [
      'Function args containing spaces or other special characters must be quoted, e.g. `op("op://Vault/Item Name/field")`',
      'If you meant a literal string, wrap the whole value in quotes',
    ],
  });
}

export function convertParsedValueToResolvers(
  value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall
    | ParsedEnvSpecFunctionArgs | ParsedEnvSpecObjectLiteral | ParsedEnvSpecArrayLiteral | undefined,
  dataSource: EnvGraphDataSource | undefined,
  registeredResolvers: Record<string, ResolverChildClass>,
): Resolver | undefined {
  if (value === undefined) {
    return undefined;
  } else if (value instanceof ParsedEnvSpecStaticValue) {
    return new StaticValueResolver(value.unescapedValue);
  } else if (value instanceof ParsedEnvSpecObjectLiteral) {
    const objArgs: Record<string, Resolver> = {};
    for (const kv of value.values) {
      const valResolver = convertParsedValueToResolvers(kv.value, dataSource, registeredResolvers);
      if (!valResolver) throw new Error('Did not expect to find undefined resolver in object literal');
      objArgs[kv.key] = valResolver;
    }
    const resolver = new ObjectLiteralResolver(undefined, objArgs, dataSource);
    resolver._parsedNode = value;
    return resolver;
  } else if (value instanceof ParsedEnvSpecArrayLiteral) {
    const arrArgs = value.values.map((v) => {
      const argResolver = convertParsedValueToResolvers(v, dataSource, registeredResolvers);
      if (!argResolver) throw new Error('Did not expect to find undefined resolver in array literal');
      return argResolver;
    });
    const resolver = new ArrayLiteralResolver(arrArgs, undefined, dataSource);
    resolver._parsedNode = value;
    return resolver;
  } else if (
    value instanceof ParsedEnvSpecFunctionCall
    // this is used only for bare decorator fn calls `@fn(arr1, arr2, k1=v1)`
    || value instanceof ParsedEnvSpecFunctionArgs
  ) {
    let ResolverFnClass: ResolverChildClass | undefined;
    let argsFromParser: Array<
      ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall
      | ParsedEnvSpecKeyValuePair
    >;
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
