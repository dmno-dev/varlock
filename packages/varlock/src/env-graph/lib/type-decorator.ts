import {
  ParsedEnvSpecFunctionCall,
  ParsedEnvSpecKeyValuePair,
  ParsedEnvSpecStaticValue,
  type ParsedEnvSpecDecorator,
} from '@env-spec/parser';
import {
  buildArrayDataType,
  ARRAY_TYPE_OPTION_KEYS,
  EnvGraphDataType,
  type EnvGraphDataTypeFactory,
} from './data-types';
import { SchemaError } from './errors';

export type ParsedTypeDecorator = {
  name: string;
  positional: Array<ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall>;
  settings: Record<string, unknown>;
};

export function parseTypeDecoratorValue(
  value: ParsedEnvSpecDecorator['value'],
): ParsedTypeDecorator | undefined {
  if (!value) return undefined;
  if (value instanceof ParsedEnvSpecStaticValue) {
    return { name: value.value as string, positional: [], settings: {} };
  }
  if (value instanceof ParsedEnvSpecFunctionCall) {
    const positional: ParsedTypeDecorator['positional'] = [];
    const settings: Record<string, unknown> = {};
    for (const arg of value.data.args.values) {
      if (arg instanceof ParsedEnvSpecKeyValuePair) {
        if (arg.value instanceof ParsedEnvSpecStaticValue) {
          settings[arg.key] = arg.value.value;
        }
      } else if (
        arg instanceof ParsedEnvSpecStaticValue
        || arg instanceof ParsedEnvSpecFunctionCall
      ) {
        positional.push(arg);
      }
    }
    return { name: value.name, positional, settings };
  }
  return undefined;
}

function pickArraySettings(settings: Record<string, unknown>) {
  const arraySettings: Record<string, unknown> = {};
  const elementSettings: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(settings)) {
    if (ARRAY_TYPE_OPTION_KEYS.has(key)) arraySettings[key] = val;
    else elementSettings[key] = val;
  }
  return { arraySettings, elementSettings };
}

function createDataTypeFromParsedTypeImpl(
  registry: Record<string, EnvGraphDataTypeFactory>,
  parsed: ParsedTypeDecorator,
): EnvGraphDataType {
  function createElementDataType(
    spec: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall,
    forwardedSettings: Record<string, unknown>,
  ): { elementType: EnvGraphDataType; elementTypeName: string } {
    if (spec instanceof ParsedEnvSpecFunctionCall) {
      const inner = parseTypeDecoratorValue(spec);
      if (!inner) throw new SchemaError('invalid nested element type');
      const elementType = createDataTypeFromParsedTypeImpl(registry, inner);
      return { elementType, elementTypeName: inner.name };
    }
    const elementTypeName = spec.value as string;
    if (!(elementTypeName in registry)) {
      throw new SchemaError(`unknown element data type: ${elementTypeName}`);
    }
    const factory = registry[elementTypeName];
    const elementType = Object.keys(forwardedSettings).length
      ? factory(forwardedSettings)
      : factory();
    return { elementType, elementTypeName };
  }

  const { name, positional, settings } = parsed;

  if (name === 'array') {
    if (!positional.length) {
      throw new SchemaError('array type requires an element type as first argument');
    }
    const { arraySettings, elementSettings } = pickArraySettings(settings);
    const { elementType, elementTypeName } = createElementDataType(
      positional[0],
      elementSettings,
    );
    return buildArrayDataType(elementType, elementTypeName, arraySettings);
  }

  if (!(name in registry)) {
    throw new SchemaError(`unknown data type: ${name}`);
  }
  const factory = registry[name];

  if (name === 'enum') {
    const enumValues = positional
      .filter((arg) => arg instanceof ParsedEnvSpecStaticValue)
      .map((arg) => (arg as ParsedEnvSpecStaticValue).value);
    return factory(...enumValues);
  }

  if (Object.keys(settings).length) {
    return factory(settings);
  }
  return factory();
}

export function createDataTypeFromParsedType(
  registry: Record<string, EnvGraphDataTypeFactory>,
  parsed: ParsedTypeDecorator,
): EnvGraphDataType {
  return createDataTypeFromParsedTypeImpl(registry, parsed);
}
