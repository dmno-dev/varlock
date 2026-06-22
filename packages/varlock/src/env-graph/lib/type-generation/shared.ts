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
