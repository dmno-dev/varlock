import _ from '@env-spec/utils/my-dash';
import {
  ParsedEnvSpecArrayLiteral,
  ParsedEnvSpecFunctionCall,
  ParsedEnvSpecKeyValuePair,
  ParsedEnvSpecObjectLiteral,
  ParsedEnvSpecStaticValue,
  type ParsedEnvSpecDecorator,
} from '@env-spec/parser';
import type { CoercedType, EnvGraphDataType, EnvGraphDataTypeFactory } from './data-types';
import { convertParsedValueToResolvers, type Resolver } from './resolver';
import type { EnvGraphDataSource } from './data-source';
import { SchemaError } from './errors';

type DataTypesRegistry = Record<string, EnvGraphDataTypeFactory>;

export type TypeSpecContext = {
  registry: DataTypesRegistry;
  /** resolver function registry - option VALUES may be resolver calls (if, remap, ...) */
  resolverFns: Record<string, any>;
  dataSource?: EnvGraphDataSource;
};

/** a node that can describe a type - either a bare name (`email`) or a call (`enum(a, b)`) */
type TypeSpecNode = ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall;

/**
 * A parsed `@type` spec, built in two phases so dynamic (resolver-valued) parts don't
 * make code generation env-dependent:
 * - `build()` with no args returns the PROVISIONAL instance - deferred settings omitted,
 *   a dynamic whole type replaced by its first static candidate (or string). Deterministic,
 *   safe for type generation.
 * - `build(resolved)` returns the FINAL instance once the deferred resolvers have resolved.
 *   The caller must verify the final `coercedType` matches the provisional one, so dynamic
 *   parts can vary validation behavior but never the generated types.
 */
export type TypeSpecPlan = {
  /** resolver-valued parts to resolve before the final build; empty = fully static */
  deferred: Array<{ resolver: Resolver, label: string }>;
  build: (resolved?: Map<Resolver, any>) => EnvGraphDataType;
};

/** marker wrapping a deferred (resolver-valued) option in a settings record */
class DeferredValue {
  constructor(readonly resolver: Resolver) {}
}

/** replace DeferredValue markers with their resolved values (or omit them in provisional mode) */
function materializeSettings(
  settings: Record<string, any>,
  resolved?: Map<Resolver, any>,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, val] of Object.entries(settings)) {
    if (val instanceof DeferredValue) {
      if (resolved?.has(val.resolver)) out[key] = resolved.get(val.resolver);
      // not resolved yet (provisional build) - omit the setting entirely
    } else {
      out[key] = val;
    }
  }
  return out;
}

const ARRAY_OPTION_KEYS = ['minLength', 'maxLength', 'isLength', 'unique', 'separator', 'format'] as const;
const RECORD_OPTION_KEYS = ['keyType', 'entriesMinLength', 'entriesMaxLength', 'entriesIsLength'] as const;

function unknownDataTypeError(name: string, context?: string): SchemaError {
  return new SchemaError(`${context ? `${context} - ` : ''}unknown data type: ${name}`, {
    // `object` is the natural guess for what varlock calls `record` (reserved for a
    // possible future per-key shape type)
    ...name === 'object' ? { tip: 'use record(...) for typed key/value maps, or simple-object for untyped JSON objects' } : {},
  });
}

function typeSpecDisplayName(node: TypeSpecNode): string {
  return node instanceof ParsedEnvSpecFunctionCall ? node.name : String(node.value);
}

function coercedTypeFingerprint(type: EnvGraphDataType): string {
  return JSON.stringify(type.coercedType ?? 'string');
}

/**
 * Interpret a named-option VALUE: static scalars and literals pass through; a resolver
 * call (if, remap, ref via `$VAR`, ...) becomes a DeferredValue resolved at item
 * resolution time. The deprecated `regex("...")` form converts to a RegExp.
 */
function optionValue(
  kv: ParsedEnvSpecKeyValuePair,
  ctx: TypeSpecContext,
  deferred: TypeSpecPlan['deferred'],
  context: string,
): any {
  const val = kv.value;
  if (val instanceof ParsedEnvSpecStaticValue) return val.value;
  if (val instanceof ParsedEnvSpecObjectLiteral || val instanceof ParsedEnvSpecArrayLiteral) {
    return val.simplifiedValue;
  }
  if (val instanceof ParsedEnvSpecFunctionCall) {
    if (val.name === 'regex') {
      // deprecated `regex("...")` option form, converted to a RegExp instance
      const regexArgs = val.simplifiedArgs;
      if (Array.isArray(regexArgs) && typeof regexArgs[0] === 'string') {
        return new RegExp(regexArgs[0]);
      }
      throw new SchemaError(`${context} - invalid regex() in option "${kv.key}"`);
    }
    if (val.name in ctx.resolverFns) {
      const resolver = convertParsedValueToResolvers(val, ctx.dataSource, ctx.resolverFns);
      if (!resolver) throw new SchemaError(`${context} - could not build resolver for option "${kv.key}"`);
      deferred.push({ resolver, label: kv.key });
      return new DeferredValue(resolver);
    }
    throw new SchemaError(`${context} - option "${kv.key}" is not a static value or a known resolver function`);
  }
  throw new SchemaError(`${context} - option "${kv.key}" must be a static value or resolver call`);
}

/** build a nested type plan (element type of `array(...)`, values/`keys=` of `object(...)`) */
function buildNestedTypePlan(
  ctx: TypeSpecContext,
  node: TypeSpecNode,
  context: string,
): TypeSpecPlan {
  if (node instanceof ParsedEnvSpecStaticValue) {
    const name = String(node.value);
    if (!(name in ctx.registry)) throw unknownDataTypeError(name, context);
    return { deferred: [], build: () => ctx.registry[name]() };
  }
  // mutual recursion - nested composite types (array of objects, etc.) recurse back through here
  // eslint-disable-next-line no-use-before-define
  return buildTypeCallPlan(ctx, node, context);
}

function validateArraySettings(settings: Record<string, any>, context: string) {
  if (settings.separator !== undefined && (!_.isString(settings.separator) || settings.separator === '')) {
    throw new SchemaError(`${context} - separator must be a non-empty string`);
  }
  if (settings.format !== undefined && settings.format !== 'separator' && settings.format !== 'json') {
    throw new SchemaError(`${context} - format must be "separator" or "json"`);
  }
  for (const lengthKey of ['minLength', 'maxLength', 'isLength'] as const) {
    if (settings[lengthKey] !== undefined && !_.isNumber(settings[lengthKey])) {
      throw new SchemaError(`${context} - ${lengthKey} must be a number`);
    }
  }
  if (settings.unique !== undefined && !_.isBoolean(settings.unique)) {
    throw new SchemaError(`${context} - unique must be a boolean`);
  }
}

function buildArrayTypePlan(
  ctx: TypeSpecContext,
  fnCall: ParsedEnvSpecFunctionCall,
  context: string,
): TypeSpecPlan {
  const deferred: TypeSpecPlan['deferred'] = [];
  const positionals: Array<TypeSpecNode> = [];
  const settings: Record<string, any> = {};

  for (const arg of fnCall.data.args.values) {
    if (arg instanceof ParsedEnvSpecKeyValuePair) {
      if (!(ARRAY_OPTION_KEYS as ReadonlyArray<string>).includes(arg.key)) {
        throw new SchemaError(
          `${context} - unknown array option "${arg.key}" (valid: ${ARRAY_OPTION_KEYS.join(', ')})`,
          { tip: 'element type options go in a nested call, e.g. array(email(normalize=true))' },
        );
      }
      settings[arg.key] = optionValue(arg, ctx, deferred, context);
    } else if (arg instanceof ParsedEnvSpecStaticValue || arg instanceof ParsedEnvSpecFunctionCall) {
      positionals.push(arg);
    } else {
      throw new SchemaError(`${context} - invalid argument in array(...)`);
    }
  }

  if (positionals.length > 1) {
    throw new SchemaError(`${context} - array(...) takes a single element type argument`, {
      tip: 'to allow a fixed set of values use a nested enum, e.g. array(enum(dev, staging, prod))',
    });
  }

  let elementPlan: TypeSpecPlan | undefined;
  let elementTypeName: string | undefined;
  if (positionals.length === 1) {
    elementPlan = buildNestedTypePlan(ctx, positionals[0], context);
    elementTypeName = typeSpecDisplayName(positionals[0]);
    deferred.push(...elementPlan.deferred);
  }

  // validate the static settings upfront so schema errors surface at load time
  validateArraySettings(materializeSettings(settings), context);

  return {
    deferred,
    build: (resolved) => {
      const materialized = materializeSettings(settings, resolved);
      validateArraySettings(materialized, context);
      if (elementPlan) {
        materialized.element = elementPlan.build(resolved);
        materialized.elementTypeName = elementTypeName;
      }
      return ctx.registry.array(materialized);
    },
  };
}

function validateRecordSettings(settings: Record<string, any>, context: string) {
  for (const lengthKey of ['entriesMinLength', 'entriesMaxLength', 'entriesIsLength'] as const) {
    if (settings[lengthKey] !== undefined && !_.isNumber(settings[lengthKey])) {
      throw new SchemaError(`${context} - ${lengthKey} must be a number`);
    }
  }
}

function buildRecordTypePlan(
  ctx: TypeSpecContext,
  fnCall: ParsedEnvSpecFunctionCall,
  context: string,
): TypeSpecPlan {
  const deferred: TypeSpecPlan['deferred'] = [];
  const positionals: Array<TypeSpecNode> = [];
  const settings: Record<string, any> = {};
  let keyTypePlan: TypeSpecPlan | undefined;

  for (const arg of fnCall.data.args.values) {
    if (arg instanceof ParsedEnvSpecKeyValuePair) {
      if (!(RECORD_OPTION_KEYS as ReadonlyArray<string>).includes(arg.key)) {
        throw new SchemaError(
          `${context} - unknown record option "${arg.key}" (valid: ${RECORD_OPTION_KEYS.join(', ')})`,
          { tip: 'value type options go in a nested call, e.g. record(string(minLength=2))' },
        );
      }
      if (arg.key === 'keyType') {
        // `keyType=` takes a type spec (name or call), not a scalar
        if (
          arg.value instanceof ParsedEnvSpecStaticValue
          || arg.value instanceof ParsedEnvSpecFunctionCall
        ) {
          keyTypePlan = buildNestedTypePlan(ctx, arg.value, context);
          deferred.push(...keyTypePlan.deferred);
        } else {
          throw new SchemaError(`${context} - keyType must be a type name or type call, e.g. keyType=enum(us, eu)`);
        }
      } else {
        settings[arg.key] = optionValue(arg, ctx, deferred, context);
      }
    } else if (arg instanceof ParsedEnvSpecStaticValue || arg instanceof ParsedEnvSpecFunctionCall) {
      positionals.push(arg);
    } else {
      throw new SchemaError(`${context} - invalid argument in record(...)`);
    }
  }

  if (positionals.length > 1) {
    throw new SchemaError(`${context} - record(...) takes a single value type argument`);
  }
  let valuesPlan: TypeSpecPlan | undefined;
  let valuesTypeName: string | undefined;
  if (positionals.length === 1) {
    valuesPlan = buildNestedTypePlan(ctx, positionals[0], context);
    valuesTypeName = typeSpecDisplayName(positionals[0]);
    deferred.push(...valuesPlan.deferred);
  }

  // validate the static settings upfront so schema errors surface at load time
  validateRecordSettings(materializeSettings(settings), context);

  return {
    deferred,
    build: (resolved) => {
      const materialized = materializeSettings(settings, resolved);
      validateRecordSettings(materialized, context);
      if (valuesPlan) {
        materialized.values = valuesPlan.build(resolved);
        materialized.valuesTypeName = valuesTypeName;
      }
      if (keyTypePlan) materialized.keyType = keyTypePlan.build(resolved);
      return ctx.registry.record(materialized);
    },
  };
}

/**
 * Extract a scalar type call's args into positional values + named settings. Same
 * walk as the composite types use for their options, so every type call in a spec
 * shares one arg-handling convention. Nested type calls are only meaningful as
 * array/object element types, which have their own handling above.
 */
function extractScalarTypeArgs(
  fnCall: ParsedEnvSpecFunctionCall,
  ctx: TypeSpecContext,
  deferred: TypeSpecPlan['deferred'],
  context: string,
): { positionals: Array<any>, settings: Record<string, any> } {
  const positionals: Array<any> = [];
  const settings: Record<string, any> = {};

  for (const arg of fnCall.data.args.values) {
    if (arg instanceof ParsedEnvSpecKeyValuePair) {
      settings[arg.key] = optionValue(arg, ctx, deferred, context);
    } else if (arg instanceof ParsedEnvSpecStaticValue) {
      positionals.push(arg.value);
    } else if (arg instanceof ParsedEnvSpecFunctionCall) {
      throw new SchemaError(
        `${context} - nested type calls are only supported as array/object element types; positional args must be static`,
      );
    } else {
      throw new SchemaError(`${context} - invalid argument`);
    }
  }

  return { positionals, settings };
}

/**
 * Enum gets a dedicated builder because its members may be resolver-valued -
 * `enum($ALLOWED_MODES)` sources members from another item at resolution time, and a
 * member that resolves to an ARRAY spreads its elements (the typed-array payoff).
 *
 * Typegen: a dynamic enum cannot produce a literal union deterministically, so its
 * provisional instance is a plain string type - generated code widens to `string`,
 * which stays valid since resolved members are required to be strings.
 */
function buildEnumTypePlan(
  ctx: TypeSpecContext,
  fnCall: ParsedEnvSpecFunctionCall,
  context: string,
): TypeSpecPlan {
  const deferred: TypeSpecPlan['deferred'] = [];
  const members: Array<any> = [];

  for (const arg of fnCall.data.args.values) {
    if (arg instanceof ParsedEnvSpecKeyValuePair) {
      throw new SchemaError(`${context} - enum does not take named options, only a list of members`);
    } else if (arg instanceof ParsedEnvSpecStaticValue) {
      members.push(arg.value);
    } else if (arg instanceof ParsedEnvSpecFunctionCall && arg.name in ctx.resolverFns) {
      const resolver = convertParsedValueToResolvers(arg, ctx.dataSource, ctx.resolverFns);
      if (!resolver) throw new SchemaError(`${context} - could not build resolver for enum member`);
      deferred.push({ resolver, label: 'enum member' });
      members.push(new DeferredValue(resolver));
    } else {
      throw new SchemaError(`${context} - enum members must be static values or resolver calls (e.g. $OTHER_ITEM)`);
    }
  }

  return {
    deferred,
    build: (resolved) => {
      if (!deferred.length) return ctx.registry.enum(...members);
      // provisional build for a dynamic enum - membership unknown until resolution
      if (!resolved) return ctx.registry.string();

      const finalMembers: Array<any> = [];
      for (const member of members) {
        if (!(member instanceof DeferredValue)) {
          finalMembers.push(member);
          continue;
        }
        const resolvedVal = resolved.get(member.resolver);
        if (Array.isArray(resolvedVal)) finalMembers.push(...resolvedVal);
        else if (resolvedVal !== undefined) finalMembers.push(resolvedVal);
      }
      if (!finalMembers.length) {
        throw new SchemaError(`${context} - dynamic enum members resolved to an empty list`);
      }
      for (const member of finalMembers) {
        // generated code saw `string` (see provisional above), so members must be strings
        if (typeof member !== 'string') {
          throw new SchemaError(
            `${context} - dynamic enum members must resolve to strings (got ${JSON.stringify(member)})`,
            { tip: 'generated types treat a dynamic enum as a string, so non-string members would not round-trip' },
          );
        }
      }
      return ctx.registry.enum(...finalMembers);
    },
  };
}

/**
 * Build a plan from a `@type=...` call node whose name IS a registered data type.
 * The composite types (`array(...)`, `object(...)`) get strict option validation +
 * recursive element/key types; scalar types call their factory with either positional
 * args spread (e.g. enum members) or a single settings object (named options) - never both.
 */
function buildTypeCallPlan(
  ctx: TypeSpecContext,
  fnCall: ParsedEnvSpecFunctionCall,
  context: string,
): TypeSpecPlan {
  const name = fnCall.name;
  if (!(name in ctx.registry)) throw unknownDataTypeError(name, context);

  if (name === 'array') return buildArrayTypePlan(ctx, fnCall, context);
  if (name === 'record') return buildRecordTypePlan(ctx, fnCall, context);
  if (name === 'enum') return buildEnumTypePlan(ctx, fnCall, context);

  const deferred: TypeSpecPlan['deferred'] = [];
  const { positionals, settings } = extractScalarTypeArgs(fnCall, ctx, deferred, context);
  const factory = ctx.registry[name];
  if (positionals.length && Object.keys(settings).length) {
    throw new SchemaError(`${context} - cannot mix positional args and named options`);
  }
  return {
    deferred,
    build: (resolved) => {
      if (positionals.length) return factory(...positionals);
      const materialized = materializeSettings(settings, resolved);
      if (Object.keys(materialized).length) return factory(materialized);
      return factory();
    },
  };
}

/**
 * A DYNAMIC whole type - `@type=if(forEnv(production), url, string)` - where the
 * decorator value is a resolver call that resolves to a type NAME at resolution time.
 *
 * Code generation stays deterministic: the provisional instance comes from the first
 * static candidate type name found in the call's top-level args (`url` above), and all
 * candidates must generate the same type (a url and a string are both strings for
 * type generation's sake - a number and a string are not). The caller re-verifies the
 * resolved type's coercedType against the provisional one, which also covers opaque
 * expressions with no extractable candidates.
 */
function buildDynamicTypePlan(
  ctx: TypeSpecContext,
  fnCall: ParsedEnvSpecFunctionCall,
): TypeSpecPlan {
  const context = `@type=${fnCall.name}(...)`;
  const resolver = convertParsedValueToResolvers(fnCall, ctx.dataSource, ctx.resolverFns);
  if (!resolver) throw new SchemaError(`${context} - could not build resolver`);

  // candidate type names = static string args (positional or named values) naming registry types
  const candidates: Array<string> = [];
  for (const arg of fnCall.data.args.values) {
    let staticVal: any;
    if (arg instanceof ParsedEnvSpecStaticValue) staticVal = arg.value;
    else if (arg instanceof ParsedEnvSpecKeyValuePair && arg.value instanceof ParsedEnvSpecStaticValue) {
      staticVal = arg.value.value;
    }
    if (typeof staticVal === 'string' && staticVal in ctx.registry && !candidates.includes(staticVal)) {
      candidates.push(staticVal);
    }
  }

  const candidateFingerprints = _.uniq(candidates.map((name) => coercedTypeFingerprint(ctx.registry[name]())));
  if (candidateFingerprints.length > 1) {
    throw new SchemaError(
      `${context} - possible types (${candidates.join(', ')}) do not all generate the same type`,
      { tip: 'a dynamic @type may vary validation but not the generated type - e.g. url vs string is ok, number vs string is not' },
    );
  }

  const provisionalName = candidates[0] ?? 'string';

  return {
    deferred: [{ resolver, label: '@type' }],
    build: (resolved) => {
      if (!resolved?.has(resolver)) return ctx.registry[provisionalName]();
      const resolvedName = resolved.get(resolver);
      if (typeof resolvedName !== 'string' || !(resolvedName in ctx.registry)) {
        throw new SchemaError(`${context} - resolved to invalid data type: ${JSON.stringify(resolvedName)}`);
      }
      return ctx.registry[resolvedName]();
    },
  };
}

/**
 * Build a TypeSpecPlan from the parsed `@type` decorator value.
 * Throws SchemaError for unknown types / invalid options.
 */
export function buildTypeSpecPlan(
  ctx: TypeSpecContext,
  decoratorValue: NonNullable<ParsedEnvSpecDecorator['value']>,
): TypeSpecPlan {
  if (decoratorValue instanceof ParsedEnvSpecStaticValue) {
    const name = String(decoratorValue.value);
    if (!(name in ctx.registry)) throw unknownDataTypeError(name);
    return { deferred: [], build: () => ctx.registry[name]() };
  }
  if (decoratorValue instanceof ParsedEnvSpecFunctionCall) {
    if (decoratorValue.name in ctx.registry) {
      return buildTypeCallPlan(ctx, decoratorValue, `@type=${decoratorValue.name}(...)`);
    }
    if (decoratorValue.name in ctx.resolverFns) {
      return buildDynamicTypePlan(ctx, decoratorValue);
    }
    throw unknownDataTypeError(decoratorValue.name);
  }
  throw new SchemaError('@type must be set to a type name (e.g. @type=number) or a type call (e.g. @type=enum(a, b))');
}

/**
 * Structural compatibility for the provisional-vs-final guard: exact match, plus one
 * safe widening - a resolved enum whose members are all strings stays assignable to a
 * provisional plain-string type (dynamic enums generate `string`). Checked recursively
 * so the widening also applies inside composites (e.g. `array(enum($MODES))`).
 */
function coercedTypeCompatible(provisional: CoercedType, final: CoercedType): boolean {
  if (JSON.stringify(provisional) === JSON.stringify(final)) return true;
  if (
    provisional === 'string'
    && typeof final === 'object' && 'enum' in final
    && final.enum.every((m) => typeof m === 'string')
  ) return true;
  if (typeof provisional === 'object' && typeof final === 'object') {
    if ('arrayOf' in provisional && 'arrayOf' in final) {
      return coercedTypeCompatible(provisional.arrayOf, final.arrayOf);
    }
    if ('recordOf' in provisional && 'recordOf' in final) {
      return coercedTypeCompatible(provisional.recordOf.values ?? 'string', final.recordOf.values ?? 'string')
        && coercedTypeCompatible(provisional.recordOf.keys ?? 'string', final.recordOf.keys ?? 'string');
    }
  }
  return false;
}

/** compatibility check used by the caller's provisional-vs-final guard */
export function coercedTypesMatch(provisional: EnvGraphDataType, final: EnvGraphDataType): boolean {
  return coercedTypeCompatible(provisional.coercedType ?? 'string', final.coercedType ?? 'string');
}
