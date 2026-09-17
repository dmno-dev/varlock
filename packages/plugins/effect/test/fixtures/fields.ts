import type { ResolvedFieldType } from 'varlock/plugin-lib';

export function field(overrides: Partial<ResolvedFieldType> & Pick<ResolvedFieldType, 'key'>): ResolvedFieldType {
  return {
    coerced: 'string',
    isRequired: true,
    isSensitive: false,
    docs: {
      isDeprecated: false,
      docsLinks: [],
    },
    ...overrides,
  };
}

export const fields: Array<ResolvedFieldType> = [
  field({ key: 'NAME' }),
  field({ key: 'ENABLED', coerced: 'boolean' }),
  field({ key: 'PORT', coerced: 'int' }),
  field({ key: 'RATIO', coerced: 'number' }),
  field({ key: 'STAGE', coerced: { enum: ['dev', 'prod'] } }),
  field({ key: 'LEVEL', coerced: { enum: [1, 2] } }),
  field({ key: 'HOSTS', coerced: { arrayOf: 'string' } }),
  field({ key: 'MATRIX', coerced: { arrayOf: { arrayOf: 'int' } } }),
  field({ key: 'LIMITS', coerced: { recordOf: { keys: { enum: ['us', 'eu'] }, values: 'int' } } }),
  field({ key: 'FLAGS', coerced: { recordOf: { values: 'boolean' } } }),
  field({ key: 'ENTRIES', coerced: { arrayOf: { recordOf: { values: { arrayOf: 'number' } } } } }),
  field({ key: 'DATA', coerced: 'object' }),
  field({ key: 'METADATA', coerced: { recordOf: {} } }),
  field({ key: 'OPTIONAL', isRequired: false }),
  field({ key: 'OPTIONAL_PORT', coerced: 'int', isRequired: false }),
  field({ key: 'OPTIONAL_DATA', coerced: 'object', isRequired: false }),
  field({ key: 'TOKEN', isRequired: false, isSensitive: true }),
  field({ key: 'SECRET_PORT', coerced: 'int', isSensitive: true }),
  field({ key: 'SECRET_STAGE', coerced: { enum: ['dev', 'prod'] }, isSensitive: true }),
  field({ key: 'SECRET_DATA', coerced: 'object', isSensitive: true }),
  field({
    key: 'SECRET_HOSTS', coerced: { arrayOf: 'string' }, isRequired: false, isSensitive: true,
  }),
];
