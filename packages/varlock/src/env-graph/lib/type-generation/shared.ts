import type { TypeGenItemInfo } from '../config-item';

export type CoercedType = | 'string'
  | 'int' // integer number — languages that distinguish can emit int; JS/TS just uses number
  | 'number' // general (possibly fractional) number
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

function isIntegerNumber(info: TypeGenItemInfo): boolean {
  type NumberDef = { _isInt?: boolean };
  return !!(info.dataType?._rawDef as NumberDef | undefined)?._isInt;
}

function resolveCoercedType(info: TypeGenItemInfo): CoercedType {
  const dataTypeName = info.dataType?.name;

  if (info.dataType) {
    // ports are always integers; `number` is an integer only when constrained (isInt / precision=0);
    // `duration` can be fractional (unit conversion), so it stays a general number
    if (dataTypeName === 'port') return 'int';
    if (dataTypeName === 'number') return isIntegerNumber(info) ? 'int' : 'number';
    if (dataTypeName === 'duration') return 'number';
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

function resolveRawStringType(coerced: CoercedType): RawStringType {
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

/** Keys of sensitive fields, in schema order — emitted as a constant so consumers can build redaction/leak-scanning. */
export function getSensitiveKeys(fields: Array<ResolvedFieldType>): Array<string> {
  return fields.filter((f) => f.isSensitive).map((f) => f.key);
}

/**
 * Language-agnostic doc content lines for a field (description, docs links, deprecation, enum values).
 * Deliberately excludes the key name — repeating it as a comment is noise. Returns `[]` when there's
 * nothing worth a comment, so emitters can skip the doc entirely.
 */
export function getFieldDocLines(field: ResolvedFieldType): Array<string> {
  const lines: Array<string> = [];
  if (field.docs.description) lines.push(...field.docs.description.split('\n'));
  for (const entry of field.docs.docsLinks) {
    lines.push(`Docs: ${[entry.url, entry.description].filter(Boolean).join(' | ')}`);
  }
  if (field.docs.isDeprecated) {
    lines.push(field.docs.deprecationMessage ? `Deprecated: ${field.docs.deprecationMessage}` : 'Deprecated');
  }
  if (typeof field.coerced === 'object' && 'enum' in field.coerced && field.coerced.enum.length) {
    lines.push(`Valid values: ${field.coerced.enum.map((o) => JSON.stringify(o)).join(' | ')}`);
  }
  return lines;
}
