/// <reference path="../../globals.d.ts" />
import _ from '@env-spec/utils/my-dash';
import {
  ParsedEnvSpecFunctionArgs, ParsedEnvSpecFunctionCall, ParsedEnvSpecStaticValue,
  parseEnvSpecDotEnvFile,
  type ParsedEnvSpecDecorator,
} from '@env-spec/parser';
import { EnvGraphDataSource } from './data-source';
import type { ConfigItem } from './config-item';
import {
  StaticValueResolver, ArrayLiteralResolver, ObjectLiteralResolver, type Resolver, convertParsedValueToResolvers,
} from './resolver';
import { ResolutionError, SchemaError, type VarlockError } from './errors';
import type { EnvGraph } from './env-graph';
import { parseKeyFilterArgs, applyKeyFilter, type KeyFilter } from './key-filter';
import { parseDuration } from '../../lib/duration';
import { PROXY_APPROVAL_EACH_VALUES } from '../../proxy/types';


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

  _errors: Array<VarlockError> = [];

  get schemaErrors(): Array<VarlockError> {
    return [
      ...this._errors.filter((e) => e instanceof SchemaError),
      ...this._decValueResolver?.schemaErrors || [],
    ];
  }

  // error encountered during `execute` function
  get _executionError(): VarlockError | undefined {
    return this._errors.find((e) => e instanceof ResolutionError);
  }

  get errors(): Array<VarlockError> {
    return [
      ...this._errors,
      ...this._decValueResolver?.schemaErrors || [],
    ];
  }

  private decoratorDef?: ItemDecoratorDef | RootDecoratorDef;
  get incompatibleWith() {
    return this.decoratorDef?.incompatibleWith;
  }
  get isFunctionOrValue() {
    return !!(this.decoratorDef as ItemDecoratorDef | undefined)?.isFunctionOrValue;
  }
  /** Purely informational — excluded from the schema fingerprint (see `inert`). */
  get isInert() {
    return !!this.decoratorDef?.inert;
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
        // decorators like @todo and @see are common in comments and should only warn
        const commentLikeDecorators = ['todo', 'see', 'note'];
        const nameLower = this.name.toLowerCase().replace(/:$/, '');
        if (commentLikeDecorators.includes(nameLower)) {
          const hint = nameLower === 'see'
            ? ' - use @docs() to link documentation'
            : ' - did you mean to write a comment?';
          throw new SchemaError(`@${this.name} is not a valid decorator${hint}`, { isWarning: true });
        }

        if (this.parsedDecorator.hasInvalidName) {
          throw new SchemaError(`"@${this.name}" is not a valid decorator name - only letters, numbers, and underscores are allowed`);
        }

        // check if the decorator exists in the other registry (misplaced)
        const otherRegistry = this.isRootDecorator
          ? this.graph.itemDecoratorsRegistry
          : this.graph.rootDecoratorsRegistry;
        if (otherRegistry[this.name]) {
          if (this.isRootDecorator) {
            throw new SchemaError(`@${this.name} is an item decorator and cannot be used in the file header - it must be attached to a config item`);
          } else {
            throw new SchemaError(`@${this.name} is a root decorator and cannot be attached to a config item - it must be in the file header (before the first config item)`);
          }
        }
        throw new SchemaError(`Unknown decorator: @${this.name}`);
      }


      // stray text found after this decorator (e.g. `# @dec some text`)
      if (this.parsedDecorator.strayText) {
        this._errors.push(new SchemaError(
          `Unexpected text "${this.parsedDecorator.strayText}" after @${this.name} - use another # for trailing comments`,
          { isWarning: true },
        ));
      }

      // validate function-call vs value syntax. A decorator marked
      // `isFunctionOrValue` accepts either form (e.g. @proxy(...) or @proxy=x);
      // the two are kept mutually exclusive per item in ConfigItem.process.
      if (!(this.decoratorDef as ItemDecoratorDef).isFunctionOrValue) {
        if (this.decoratorDef.isFunction && !this.isFunctionCall) {
          throw new SchemaError(
            `@${this.name} must be used as a function call - use @${this.name}(...) instead of @${this.name}=value`,
          );
        }
        if (!this.decoratorDef.isFunction && this.isFunctionCall) {
          // bare fn-call syntax `@name(...)` is reserved for repeatable decorators (e.g. @docs()).
          // @sensitive and @proxyConfig are single-use but accept an options-object value, so guide
          // users who tried to pass options as a bare call toward the object form `@name={...}`.
          if (this.name === 'sensitive' || this.name === 'proxyConfig') {
            const fallback = this.name === 'sensitive' ? '{preventLeaks=false}' : '{egress="strict"}';
            const optsStr = this.parsedDecorator.bareFnArgs
              ? `{${this.parsedDecorator.bareFnArgs.values.map((v) => v.toString()).join(', ')}}`
              : fallback;
            throw new SchemaError(
              `@${this.name} is single-use and cannot be called like @${this.name}(...). To pass options, use an object value: @${this.name}=${optsStr}`,
            );
          }
          throw new SchemaError(
            `@${this.name} cannot be used as a function call - use @${this.name}=value instead of @${this.name}(...)`,
          );
        }
      }

      // this is so we can deal with @type, where each data type is not a real resolver
      // so instead we just make a new dummy resolver holding the args
      if (
        this.decoratorDef.useFnArgsResolver
        && (
          this.parsedDecorator.value instanceof ParsedEnvSpecFunctionCall
          || this.parsedDecorator.value instanceof ParsedEnvSpecFunctionArgs
        )
      ) {
        const fnArgsValue = this.parsedDecorator.value instanceof ParsedEnvSpecFunctionCall
          ? this.parsedDecorator.value.data.args
          : this.parsedDecorator.value;
        this._decValueResolver = convertParsedValueToResolvers(
          fnArgsValue,
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
      this._errors.push(e instanceof SchemaError ? e : new SchemaError(e as Error));
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
    if (!this.decValueResolver) {
      // process() already recorded schema errors, don't throw again
      if (this._errors.length) return;
      throw new Error('expected decorator to have a value resolver');
    }
    try {
      this.resolvedValue = await this.decValueResolver.resolve();
    } catch (err) {
      this._errors.push(err as any);
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

// ~ Root decorators ----------------------------------------
export type RootDecoratorDef<Processed = any> = {
  name: string,
  description?: string;
  isFunction?: boolean;
  /** Purely informational (no effect on resolved values/behavior) → excluded from the schema fingerprint. */
  inert?: boolean;
  deprecated?: boolean | string;
  incompatibleWith?: Array<string>;
  process?: (decoratorValue: Resolver) => (Processed | Promise<Processed>);
  execute?: (executeInput: Processed) => void | Promise<void>;
  useFnArgsResolver?: boolean,
};

/**
 * Validate that a `@proxy` list option (`domain`/`method`/`keys`) is either a
 * single string value or an array literal of non-empty static strings. When
 * `requireArray` is set the single form is rejected (used for `keys`, which is
 * always a list). Single non-array values are accepted as-is and validated at
 * resolve time, so dynamic expressions (e.g. `domain=concat(...)`) still work.
 */
function assertProxyStringListArg(
  resolver: Resolver | undefined,
  option: string,
  requireArray: boolean,
): void {
  if (!resolver) return;
  if (resolver instanceof ArrayLiteralResolver) {
    const els = resolver.arrArgs ?? [];
    if (!els.length) throw new SchemaError(`@proxy: ${option} array cannot be empty`);
    for (const el of els) {
      if (!el.isStatic || typeof el.staticValue !== 'string' || !el.staticValue.trim()) {
        throw new SchemaError(`@proxy: ${option} entries must be non-empty strings`);
      }
    }
    return;
  }
  if (requireArray) {
    throw new SchemaError(`@proxy: ${option} must be an array literal, e.g. ${option}=[ITEM_A, ITEM_B]`);
  }
}

/**
 * Shared validation for the function form of `@proxy(...)` — used by both the
 * root (detached) and item (attached) registrations so their rules stay
 * consistent. Requires `domain`; accepts `domain`/`method` as a string or array
 * literal and `keys` as an array literal; rejects positional args; validates the
 * approval options.
 */
const VALID_PROXY_OPTIONS = ['domain', 'path', 'method', 'keys', 'block', 'approval', 'rules'] as const;
/** Per-entry options inside the `rules=[{...}]` array form. Each entry is a
 * policy refinement for the parent's `domain`, so it cannot re-set `domain` or
 * `keys` (injection is controlled by the parent rule). */
const VALID_PROXY_RULE_ENTRY_OPTIONS = ['path', 'method', 'block', 'approval'] as const;
/** Inner options of the `approval={...}` object form. */
const VALID_APPROVAL_OPTIONS = ['enabled', 'each', 'maxDuration'] as const;

/** A static boolean option (`block`) must be a real boolean — a quoted `"true"`
 * or `1` is a misconfiguration that would otherwise silently drop the option
 * (turning a deny rule into a plain allow). Dynamic expressions are validated at
 * resolve time. */
function assertProxyBooleanArg(resolver: Resolver | undefined, option: string): void {
  if (!resolver?.isStatic) return;
  if (typeof resolver.staticValue !== 'boolean') {
    throw new SchemaError(`@proxy: ${option} must be a boolean (true or false), not ${JSON.stringify(resolver.staticValue)}`);
  }
}

/** A static `path` must be a single non-empty string (not an array/number). */
function assertProxyStringArg(resolver: Resolver | undefined, option: string): void {
  if (!resolver?.isStatic) return;
  if (typeof resolver.staticValue !== 'string' || !resolver.staticValue.trim()) {
    throw new SchemaError(`@proxy: ${option} must be a non-empty string`);
  }
}

/**
 * `approval` accepts either a boolean (`approval=true`) or an options object
 * (`approval={each=request, maxDuration=15m}`); the object form implies approval
 * is required unless `enabled=false`. Validates the inner options statically when
 * they're literals; dynamic values are re-checked at resolve time.
 */
function assertProxyApprovalArg(resolver: Resolver | undefined): void {
  if (!resolver) return;
  if (resolver instanceof ObjectLiteralResolver) {
    const inner = resolver.objArgs ?? {};
    for (const key of Object.keys(inner)) {
      if (!VALID_APPROVAL_OPTIONS.includes(key as typeof VALID_APPROVAL_OPTIONS[number])) {
        throw new SchemaError(`@proxy: unknown approval option "${key}". Valid options: ${VALID_APPROVAL_OPTIONS.join(', ')}`);
      }
    }
    const each = inner.each;
    if (each?.isStatic && !(typeof each.staticValue === 'string' && PROXY_APPROVAL_EACH_VALUES.includes(each.staticValue as any))) {
      throw new SchemaError(`@proxy: approval.each must be one of ${PROXY_APPROVAL_EACH_VALUES.join(', ')}`);
    }
    const maxDuration = inner.maxDuration;
    if (maxDuration?.isStatic) {
      try {
        parseDuration(maxDuration.staticValue as string | number);
      } catch {
        throw new SchemaError('@proxy: approval.maxDuration must be a duration like "15m" or 0 (always ask)');
      }
    }
    const enabled = inner.enabled;
    if (enabled?.isStatic && typeof enabled.staticValue !== 'boolean') {
      throw new SchemaError('@proxy: approval.enabled must be a boolean (true or false)');
    }
    return;
  }
  if (resolver.isStatic && typeof resolver.staticValue !== 'boolean') {
    throw new SchemaError('@proxy: approval must be true/false or an options object, e.g. approval={each=request, maxDuration=15m}');
  }
}

/**
 * The `rules=[{...}]` form: a list of policy refinements that share the parent's
 * `domain`. Each entry may set path/method/block/approval (but not domain/keys —
 * injection is the parent rule's job). Statically validates literal entries; the
 * resolve-time validator re-checks dynamic values.
 */
function assertProxyRulesArg(resolver: Resolver | undefined): void {
  if (!resolver) return;
  if (!(resolver instanceof ArrayLiteralResolver)) {
    throw new SchemaError('@proxy: rules must be an array of rule objects, e.g. rules=[{path="/v1/**", block=true}]');
  }
  for (const entry of resolver.arrArgs ?? []) {
    if (!(entry instanceof ObjectLiteralResolver)) {
      throw new SchemaError('@proxy: each rules entry must be an object, e.g. {path="/v1/**", block=true}');
    }
    const inner = entry.objArgs ?? {};
    for (const key of Object.keys(inner)) {
      if (!VALID_PROXY_RULE_ENTRY_OPTIONS.includes(key as typeof VALID_PROXY_RULE_ENTRY_OPTIONS[number])) {
        throw new SchemaError(
          `@proxy: unknown option "${key}" in a rules entry. Valid entry options: ${VALID_PROXY_RULE_ENTRY_OPTIONS.join(', ')} `
            + '(domain and keys are set on the parent @proxy)',
        );
      }
    }
    assertProxyStringListArg(inner.method, 'method', false);
    assertProxyStringArg(inner.path, 'path');
    assertProxyBooleanArg(inner.block, 'block');
    assertProxyApprovalArg(inner.approval);
  }
}

function validateProxyFunctionArgs(argsVal: Resolver): void {
  if (!argsVal.objArgs?.domain) {
    throw new SchemaError('@proxy: missing required "domain" option');
  }

  // Reject unknown options so a typo (e.g. `aproval=true`, `blok=true`) fails loudly
  // instead of silently producing a permissive rule.
  for (const key of Object.keys(argsVal.objArgs)) {
    if (!VALID_PROXY_OPTIONS.includes(key as typeof VALID_PROXY_OPTIONS[number])) {
      throw new SchemaError(
        `@proxy: unknown option "${key}". Valid options: ${VALID_PROXY_OPTIONS.join(', ')}`,
      );
    }
  }

  assertProxyStringListArg(argsVal.objArgs.domain, 'domain', false);
  assertProxyStringListArg(argsVal.objArgs?.method, 'method', false);
  assertProxyStringListArg(argsVal.objArgs?.keys, 'keys', true);
  assertProxyStringArg(argsVal.objArgs?.path, 'path');
  assertProxyBooleanArg(argsVal.objArgs?.block, 'block');
  assertProxyApprovalArg(argsVal.objArgs?.approval);
  assertProxyRulesArg(argsVal.objArgs?.rules);

  if (argsVal.arrArgs?.length) {
    throw new SchemaError('@proxy: positional args are not supported - use keys=[ITEM_A, ITEM_B] to attach items');
  }
}

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
    name: 'cache',
    process: (decVal) => {
      // dynamic values (e.g. forEnv(...)) are validated after resolution in finishLoad
      if (!decVal.isStatic) return undefined;
      const v = decVal.staticValue;
      if (v === 'auto' || v === 'memory' || v === 'disk' || v === 'disabled') return v;
      throw new Error('@cache decorator value must be one of: "auto", "memory", "disk", "disabled"');
    },
  },
  {
    name: 'redactLogs',
  },
  {
    name: 'preventLeaks',
  },
  {
    name: 'encryptInjectedEnv',
  },
  {
    name: 'disableProcessEnvInjection',
  },
  {
    // Single-use header config for the credential proxy. The proxy itself is
    // driven by @proxy decorators on items; @proxyConfig only tunes proxy-wide
    // settings (currently just egress). Value/object form: @proxyConfig={egress="strict"}.
    name: 'proxyConfig',
    process: (decValue) => {
      if (decValue.objArgs === undefined) {
        throw new SchemaError('@proxyConfig must be set to an options object, for example @proxyConfig={egress="strict"}');
      }
      for (const key in decValue.objArgs) {
        if (key !== 'egress' && key !== 'reload') {
          throw new SchemaError(`@proxyConfig: unknown option "${key}" (supported: egress, reload)`);
        }
      }
      const egressResolver = decValue.objArgs.egress;
      if (egressResolver?.isStatic) {
        const egressValue = egressResolver.staticValue;
        if (egressValue !== 'permissive' && egressValue !== 'strict') {
          throw new SchemaError('@proxyConfig: egress must be "permissive" or "strict"');
        }
      }
      const reloadResolver = decValue.objArgs.reload;
      if (reloadResolver?.isStatic) {
        const reloadValue = reloadResolver.staticValue;
        if (reloadValue !== 'off' && reloadValue !== 'manual' && reloadValue !== 'auto') {
          throw new SchemaError('@proxyConfig: reload must be "off", "manual", or "auto"');
        }
      }
    },
  },
  {
    name: 'proxy',
    isFunction: true,
    useFnArgsResolver: true,
    process: (argsVal) => validateProxyFunctionArgs(argsVal),
  },
  {
    name: 'auditIgnorePaths',
    isFunction: true,
  },
  {
    name: 'setValuesBulk',
    isFunction: true,
    process(argsVal) {
      if (!argsVal.arrArgs || argsVal.arrArgs.length === 0) {
        throw new SchemaError('@setValuesBulk requires at least one argument - the data resolver');
      }
      if (argsVal.arrArgs.length > 1) {
        throw new SchemaError(
          '@setValuesBulk expects only one positional argument - the data resolver.'
          + ' Use pick=[...] / omit=[...] to filter keys.',
        );
      }
      if (argsVal.objArgs) {
        const validOptions = new Set(['format', 'createMissing', 'enabled', 'pick', 'omit']);
        for (const key of Object.keys(argsVal.objArgs)) {
          if (!validOptions.has(key)) {
            throw new SchemaError(`@setValuesBulk: unknown option "${key}". Valid options: format, createMissing, enabled, pick, omit`);
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

      // key filters: `pick=[...]` (allowlist) / `omit=[...]` (denylist). Default injects every key.
      const keyFilter = parseKeyFilterArgs(argsVal.objArgs?.pick, argsVal.objArgs?.omit, '@setValuesBulk');

      return {
        graph: argsVal.dataSource!.graph!,
        dataSource: argsVal.dataSource!,
        argsResolver: argsVal,
        keyFilter,
      };
    },
    async execute(processedData) {
      const {
        graph, dataSource, argsResolver, keyFilter,
      } = processedData as {
        graph: EnvGraph;
        dataSource: EnvGraphDataSource;
        argsResolver: Resolver;
        keyFilter?: KeyFilter;
      };

      // check enabled before resolving data - important so disabled sources don't trigger data fetching
      const enabledResolver = argsResolver.objArgs?.enabled;
      if (enabledResolver !== undefined) {
        const enabledValue = await enabledResolver.resolve();
        if (!_.isBoolean(enabledValue)) {
          throw new SchemaError('@setValuesBulk: enabled must be a boolean');
        }
        if (!enabledValue) return; // disabled - skip data resolution entirely
      }

      // resolve the args
      const resolved = await argsResolver.resolve() as { arr: Array<any>, obj: Record<string, any> };
      const dataString = resolved.arr[0];
      const format = resolved.obj?.format as string | undefined;
      const createMissing = resolved.obj?.createMissing ?? false;

      if (dataString === undefined || dataString === null || dataString === '') {
        return; // empty data is a no-op
      }

      if (typeof dataString !== 'string') {
        throw new SchemaError('@setValuesBulk: data resolver must return a string');
      }

      // detect or use explicit format
      const effectiveFormat = format || detectBulkFormat(dataString);

      // parse the data
      let entries: Record<string, { value: string | number | boolean, description?: string }>;
      if (effectiveFormat === 'json') {
        entries = parseJsonBulkValues(dataString);
      } else {
        entries = parseEnvBulkValues(dataString);
      }

      // apply pick/omit key filter (no filter means inject everything)
      applyKeyFilter(entries, keyFilter);

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

// ~ Item decorators ----------------------------------------
export type ItemDecoratorDef<T = any> = {
  name: string,
  incompatibleWith?: Array<string>;
  isFunction?: boolean;
  /** Purely informational (no effect on resolved values/behavior) → excluded from the schema fingerprint. */
  inert?: boolean;
  /**
   * Allow BOTH the function form (`@name(...)`) and the value form (`@name=x`).
   * The two forms are mutually exclusive on a single item (see ConfigItem.process).
   * Used by `@proxy`: `@proxy(domain=...)` routes, `@proxy=passthrough|omit` are
   * value-form modes. The `process` callback must handle both (discriminate on
   * `decoratorValue.isStatic`).
   */
  isFunctionOrValue?: boolean;
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
    name: 'internal',
  },
  {
    name: 'type',
    useFnArgsResolver: true,
  },
  {
    name: 'example',
    inert: true,
  },
  {
    name: 'docsUrl',
    deprecated: 'use `docs()` instead',
    inert: true,
  },
  {
    name: 'docs',
    isFunction: true,
    inert: true,
  },
  {
    name: 'icon',
    inert: true,
  },
  {
    name: 'deprecated',
    inert: true,
  },
  {
    name: 'auditIgnore',
  },
  {
    name: 'placeholder',
    process: (decVal) => {
      if (!decVal.isStatic || !_.isString(decVal.staticValue)) {
        throw new SchemaError('@placeholder must be a static string value');
      }
    },
  },
  {
    name: 'proxy',
    isFunction: true,
    isFunctionOrValue: true,
    useFnArgsResolver: true,
    process: (decVal) => {
      // Value form: @proxy=passthrough (inject the real value) or @proxy=omit
      // (explicitly withhold from the proxied child).
      if (decVal.isStatic) {
        const mode = decVal.staticValue;
        if (mode !== 'passthrough' && mode !== 'omit') {
          throw new SchemaError(
            '@proxy value must be "passthrough" or "omit" — or use @proxy(domain=...) to route a value through the proxy',
          );
        }
        return;
      }
      // Function form: @proxy(domain=..., [path], [method], [block], [approval=true | approval={each, maxDuration, enabled}], [keys=[...]])
      validateProxyFunctionArgs(decVal);
    },
  },

  // test-only decorators — dropped in release builds
  ...__VARLOCK_BUILD_TYPE__ === 'test' ? [
    {
      name: 'warn',
      process() {
        throw new SchemaError('test warning', { isWarning: true });
      },
    },
  ] as Array<ItemDecoratorDef<any>> : [],
];
