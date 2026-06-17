import _ from '@env-spec/utils/my-dash';
import type { TypeGenItemInfo } from '../config-item';

export const SUPPORTED_TYPEGEN_LANGS = ['ts', 'py', 'rs', 'go', 'php'] as const;
export type TypeGenLang = typeof SUPPORTED_TYPEGEN_LANGS[number];

export function isSupportedTypeGenLang(lang: string): lang is TypeGenLang {
  return (SUPPORTED_TYPEGEN_LANGS as ReadonlyArray<string>).includes(lang);
}

export type CoercedType = | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | { enum: Array<string | number | boolean> };

export type RawStringType = | 'string'
  | { enum: Array<string> }
  | { boolean: true };

export type FieldDocs = {
  description?: string;
  isSensitive: boolean;
  isDeprecated: boolean;
  deprecationMessage?: string;
  docsLinks: Array<{ url: string, description?: string }>;
  icon?: string;
};

export type ResolvedFieldType = {
  key: string;
  coerced: CoercedType;
  rawString: RawStringType;
  isRequired: boolean;
  isSensitive: boolean;
  docs: FieldDocs;
};

function getEnumOptions(info: TypeGenItemInfo): Array<string | number | boolean> {
  type EnumDef = { _rawEnumOptions?: Array<string | number | boolean> };
  const rawEnumOptions = (info.dataType?._rawDef as EnumDef | undefined)?._rawEnumOptions;
  return rawEnumOptions ?? [];
}

export function resolveCoercedType(info: TypeGenItemInfo): CoercedType {
  const dataTypeName = info.dataType?.name;

  if (info.dataType) {
    if (dataTypeName === 'number' || dataTypeName === 'port' || dataTypeName === 'duration') return 'number';
    if (dataTypeName === 'boolean') return 'boolean';
    if (dataTypeName === 'simple-object') return 'object';
    if (dataTypeName === 'enum') {
      const enumOptions = getEnumOptions(info);
      if (!enumOptions.length) return { enum: [] };
      return { enum: enumOptions };
    }
  }
  return 'string';
}

export function resolveRawStringType(coerced: CoercedType): RawStringType {
  if (coerced === 'boolean') return { boolean: true };
  if (typeof coerced === 'object' && 'enum' in coerced) {
    const stringOptions = coerced.enum.filter((option): option is string => typeof option === 'string');
    if (stringOptions.length === coerced.enum.length && stringOptions.length > 0) {
      return { enum: stringOptions };
    }
    return 'string';
  }
  return 'string';
}

export function resolveFieldType(info: TypeGenItemInfo): ResolvedFieldType {
  const coerced = resolveCoercedType(info);
  return {
    key: info.key,
    coerced,
    rawString: resolveRawStringType(coerced),
    isRequired: info.isRequired && !info.isRequiredDynamic,
    isSensitive: info.isSensitive,
    docs: {
      description: info.description,
      isSensitive: info.isSensitive,
      isDeprecated: info.isDeprecated,
      deprecationMessage: info.deprecationMessage,
      docsLinks: info.docsLinks,
      icon: info.icon,
    },
  };
}

export function resolveFieldTypes(items: Array<TypeGenItemInfo>): Array<ResolvedFieldType> {
  return items.map(resolveFieldType);
}

export function getItemTsTypeString(coerced: CoercedType): string {
  if (coerced === 'number') return 'number';
  if (coerced === 'boolean') return 'boolean';
  if (coerced === 'object') return 'Record<string, any>';
  if (typeof coerced === 'object' && 'enum' in coerced) {
    if (!coerced.enum.length) return 'never';
    return _.map(coerced.enum, JSON.stringify).join(' | ');
  }
  return 'string';
}

export function getPythonCoercedTypeString(coerced: CoercedType): string {
  if (coerced === 'number') return 'int';
  if (coerced === 'boolean') return 'bool';
  if (coerced === 'object') return 'dict[str, object]';
  if (typeof coerced === 'object' && 'enum' in coerced) {
    if (!coerced.enum.length) return 'Never';
    return coerced.enum.map((option) => {
      if (typeof option === 'string') return `Literal[${JSON.stringify(option)}]`;
      if (typeof option === 'boolean') return `Literal[${option ? 'True' : 'False'}]`;
      return `Literal[${option}]`;
    }).join(' | ');
  }
  return 'str';
}

export function getPythonRawStringTypeString(rawString: RawStringType): string {
  if (typeof rawString === 'object' && 'boolean' in rawString) {
    return 'Literal["true", "false"]';
  }
  if (typeof rawString === 'object' && 'enum' in rawString) {
    return rawString.enum.map((option) => `Literal[${JSON.stringify(option)}]`).join(' | ');
  }
  return 'str';
}

export function getRustCoercedTypeString(coerced: CoercedType): string {
  if (coerced === 'number') return 'f64';
  if (coerced === 'boolean') return 'bool';
  if (coerced === 'object') return 'serde_json::Value';
  if (typeof coerced === 'object' && 'enum' in coerced) {
    return 'String';
  }
  return 'String';
}

export function getRustRawStringTypeString(rawString: RawStringType): string {
  if (typeof rawString === 'object' && 'boolean' in rawString) {
    return 'String';
  }
  if (typeof rawString === 'object' && 'enum' in rawString) {
    return 'String';
  }
  return 'String';
}

export function snakeCaseToPascalCase(key: string): string {
  return key.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join('');
}

export function envKeyToRustFieldName(key: string): string {
  return key.toLowerCase();
}

export function getGoCoercedTypeString(coerced: CoercedType): string {
  if (coerced === 'number') return 'float64';
  if (coerced === 'boolean') return 'bool';
  if (coerced === 'object') return 'map[string]any';
  if (typeof coerced === 'object' && 'enum' in coerced) {
    if (!coerced.enum.length) return 'any';
    return 'string';
  }
  return 'string';
}

export function getPhpCoercedTypeString(coerced: CoercedType): string {
  if (coerced === 'number') return 'int|float';
  if (coerced === 'boolean') return 'bool';
  if (coerced === 'object') return 'array<string, mixed>';
  if (typeof coerced === 'object' && 'enum' in coerced) {
    if (!coerced.enum.length) return 'never';
    return coerced.enum.map((option) => {
      if (typeof option === 'string') return `'${option.replace(/'/g, "\\'")}'`;
      if (typeof option === 'boolean') return option ? "'true'" : "'false'";
      return String(option);
    }).join('|');
  }
  return 'string';
}

export function getPhpRawStringTypeString(rawString: RawStringType): string {
  if (typeof rawString === 'object' && 'boolean' in rawString) {
    return "'true'|'false'";
  }
  if (typeof rawString === 'object' && 'enum' in rawString) {
    return rawString.enum.map((option) => `'${option.replace(/'/g, "\\'")}'`).join('|');
  }
  return 'string';
}
