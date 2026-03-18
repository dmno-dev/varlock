import { describe, expect, it } from 'vitest';

import { createLineDocument } from '../src/document-lines';
import {
  createDecoratorDiagnostics,
  getDecoratorOccurrences,
  getTypeInfoFromPrecedingComments,
  validateStaticValue,
} from '../src/diagnostics-core';

describe('diagnostics-core', () => {
  it('flags duplicate single-use decorators but not repeatable function decorators', () => {
    const duplicates = createDecoratorDiagnostics([
      ...getDecoratorOccurrences('# @required @required', 0),
      ...getDecoratorOccurrences('# @docs(https://a.com) @docs(https://b.com)', 1),
    ]);

    expect(duplicates.map((diagnostic) => diagnostic.message)).toContain(
      '@required can only be used once in the same decorator block.',
    );
    expect(
      duplicates.some((diagnostic) => diagnostic.message.includes('@docs')),
    ).toBe(false);
  });

  it('flags incompatible decorator pairs inline', () => {
    const diagnostics = createDecoratorDiagnostics(
      getDecoratorOccurrences('# @required @optional @sensitive @public', 0),
    );

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      '@required and @optional cannot be used together.',
    );
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      '@sensitive and @public cannot be used together.',
    );
  });

  it('reads type info from the comment block above an item', () => {
    const document = createLineDocument([
      '# @required @type=url(prependHttps=true, allowedDomains="example.com,api.example.com")',
      'API_URL=example.com',
    ]);

    expect(getTypeInfoFromPrecedingComments(document, 1)).toEqual({
      name: 'url',
      args: [],
      options: {
        prependHttps: 'true',
        allowedDomains: 'example.com,api.example.com',
      },
    });
  });

  it('validates enum values against the decorator list', () => {
    const typeInfo = {
      name: 'enum',
      args: ['prod', 'dev'],
      options: {},
    } as const;

    expect(validateStaticValue(typeInfo, 'prod')).toBeUndefined();
    expect(validateStaticValue(typeInfo, 'staging')).toBe('Value must be one of: prod, dev.');
  });

  it('validates prependHttps url behavior', () => {
    expect(
      validateStaticValue(
        {
          name: 'url',
          args: [],
          options: { prependHttps: 'true' },
        },
        'https://example.com',
      ),
    ).toBe('URL should omit the protocol when prependHttps=true.');

    expect(
      validateStaticValue(
        {
          name: 'url',
          args: [],
          options: { prependHttps: 'true' },
        },
        'example.com',
      ),
    ).toBeUndefined();

    expect(
      validateStaticValue(
        {
          name: 'url',
          args: [],
          options: {},
        },
        'example.com',
      ),
    ).toBe('URL must include a protocol unless prependHttps=true.');
  });

  it('validates boolean, ip version, and port values', () => {
    expect(
      validateStaticValue(
        {
          name: 'boolean',
          args: [],
          options: {},
        },
        'maybe',
      ),
    ).toBe('Value must be a boolean.');

    expect(
      validateStaticValue(
        {
          name: 'ip',
          args: [],
          options: { version: '4' },
        },
        '2001:db8::1',
      ),
    ).toBe('Value must be a valid IPv4 address.');

    expect(
      validateStaticValue(
        {
          name: 'port',
          args: [],
          options: { min: '1024' },
        },
        '443',
      ),
    ).toBe('Port must be greater than or equal to 1024.');
  });

  it('skips overly long string match patterns', () => {
    expect(
      validateStaticValue(
        {
          name: 'string',
          args: [],
          options: { matches: 'a'.repeat(201) },
        },
        'bbb',
      ),
    ).toBeUndefined();
  });
});
