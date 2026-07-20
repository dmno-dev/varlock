import _ from '@env-spec/utils/my-dash';
import {
  ParsedEnvSpecFunctionCall,
  ParsedEnvSpecKeyValuePair,
  ParsedEnvSpecStaticValue,
  type ParsedEnvSpecDecorator,
} from '@env-spec/parser';
import type { EnvGraphDataType, EnvGraphDataTypeFactory } from './data-types';
import { SchemaError } from './errors';

type DataTypesRegistry = Record<string, EnvGraphDataTypeFactory>;

/** a node that can describe a type - either a bare name (`email`) or a call (`enum(a, b)`) */
type TypeSpecNode = ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall;

const ARRAY_OPTION_KEYS = ['minLength', 'maxLength', 'unique', 'separator', 'format'] as const;
const OBJECT_OPTION_KEYS = ['keys'] as const;

function typeSpecDisplayName(node: TypeSpecNode): string {
  return node instanceof ParsedEnvSpecFunctionCall ? node.name : String(node.value);
}

/** build a type instance from a nested type spec (element type of `array(...)`, `keys=`/values of `object(...)`) */
function buildNestedDataType(
  registry: DataTypesRegistry,
  node: TypeSpecNode,
  context: string,
): EnvGraphDataType {
  if (node instanceof ParsedEnvSpecStaticValue) {
    const name = String(node.value);
    if (!(name in registry)) throw new SchemaError(`${context} - unknown data type: ${name}`);
    return registry[name]();
  }
  // mutual recursion - nested composite types (array of objects, etc.) recurse back through here
  // eslint-disable-next-line no-use-before-define
  return buildDataTypeFromTypeSpec(registry, node, context);
}

/** a named option inside `array(...)`/`object(...)` must be a static scalar (not a call/ref) */
function staticOptionValue(kv: ParsedEnvSpecKeyValuePair, context: string): any {
  if (!(kv.value instanceof ParsedEnvSpecStaticValue)) {
    throw new SchemaError(`${context} - option "${kv.key}" must be a static value`);
  }
  return kv.value.value;
}

function buildArrayDataType(
  registry: DataTypesRegistry,
  fnCall: ParsedEnvSpecFunctionCall,
  context: string,
): EnvGraphDataType {
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
      settings[arg.key] = staticOptionValue(arg, context);
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

  if (settings.separator !== undefined && (!_.isString(settings.separator) || settings.separator === '')) {
    throw new SchemaError(`${context} - separator must be a non-empty string`);
  }
  if (settings.format !== undefined && settings.format !== 'separator' && settings.format !== 'json') {
    throw new SchemaError(`${context} - format must be "separator" or "json"`);
  }
  for (const lengthKey of ['minLength', 'maxLength'] as const) {
    if (settings[lengthKey] !== undefined && !_.isNumber(settings[lengthKey])) {
      throw new SchemaError(`${context} - ${lengthKey} must be a number`);
    }
  }
  if (settings.unique !== undefined && !_.isBoolean(settings.unique)) {
    throw new SchemaError(`${context} - unique must be a boolean`);
  }

  if (positionals.length === 1) {
    settings.element = buildNestedDataType(registry, positionals[0], context);
    settings.elementTypeName = typeSpecDisplayName(positionals[0]);
  }

  return registry.array(settings);
}

function buildObjectDataType(
  registry: DataTypesRegistry,
  fnCall: ParsedEnvSpecFunctionCall,
  context: string,
): EnvGraphDataType {
  const positionals: Array<TypeSpecNode> = [];
  const settings: Record<string, any> = {};

  for (const arg of fnCall.data.args.values) {
    if (arg instanceof ParsedEnvSpecKeyValuePair) {
      if (!(OBJECT_OPTION_KEYS as ReadonlyArray<string>).includes(arg.key)) {
        throw new SchemaError(
          `${context} - unknown object option "${arg.key}" (valid: ${OBJECT_OPTION_KEYS.join(', ')})`,
          { tip: 'value type options go in a nested call, e.g. object(url(allowedDomains=[example.com]))' },
        );
      }
      // `keys=` takes a type spec (name or call), not a scalar
      if (
        arg.value instanceof ParsedEnvSpecStaticValue
        || arg.value instanceof ParsedEnvSpecFunctionCall
      ) {
        settings.keys = buildNestedDataType(registry, arg.value, context);
      } else {
        throw new SchemaError(`${context} - keys must be a type name or type call, e.g. keys=enum(us, eu)`);
      }
    } else if (arg instanceof ParsedEnvSpecStaticValue || arg instanceof ParsedEnvSpecFunctionCall) {
      positionals.push(arg);
    } else {
      throw new SchemaError(`${context} - invalid argument in object(...)`);
    }
  }

  if (positionals.length > 1) {
    throw new SchemaError(`${context} - object(...) takes a single value type argument`);
  }
  if (positionals.length === 1) {
    settings.values = buildNestedDataType(registry, positionals[0], context);
    settings.valuesTypeName = typeSpecDisplayName(positionals[0]);
  }

  return registry.object(settings);
}

/**
 * Build a data type instance from a `@type=...` call node. Handles the composite types
 * (`array(...)`, `object(...)`) with strict option validation + recursive element/key
 * types; all other types keep the legacy arg handling (positional spread for enum,
 * settings object for named options).
 */
function buildDataTypeFromTypeSpec(
  registry: DataTypesRegistry,
  fnCall: ParsedEnvSpecFunctionCall,
  context: string,
): EnvGraphDataType {
  const name = fnCall.name;
  if (!(name in registry)) throw new SchemaError(`${context} - unknown data type: ${name}`);

  if (name === 'array') return buildArrayDataType(registry, fnCall, context);
  if (name === 'object') return buildObjectDataType(registry, fnCall, context);

  // legacy handling for all scalar types - `simplifiedArgs` returns an array (all
  // positional, e.g. enum members) or a plain object (all named options)
  const args = fnCall.simplifiedArgs;
  const factory = registry[name];
  return factory(..._.isPlainObject(args) ? [args] : args as Array<any>);
}

/**
 * Build a data type instance from the parsed `@type` decorator value.
 * Throws SchemaError for unknown types / invalid options.
 */
export function buildDataTypeFromTypeDecorator(
  registry: DataTypesRegistry,
  decoratorValue: NonNullable<ParsedEnvSpecDecorator['value']>,
): EnvGraphDataType {
  if (decoratorValue instanceof ParsedEnvSpecStaticValue) {
    const name = String(decoratorValue.value);
    if (!(name in registry)) throw new SchemaError(`unknown data type: ${name}`);
    return registry[name]();
  }
  if (decoratorValue instanceof ParsedEnvSpecFunctionCall) {
    return buildDataTypeFromTypeSpec(registry, decoratorValue, `@type=${decoratorValue.name}(...)`);
  }
  throw new SchemaError('@type must be set to a type name (e.g. @type=number) or a type call (e.g. @type=enum(a, b))');
}
