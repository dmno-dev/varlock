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
      ...getDecoratorOccurrences('# @initOp(allowAppAuth=true) @initOp(token=$OP_TOKEN)', 2),
    ]);

    expect(duplicates.map((diagnostic) => diagnostic.message)).toContain(
      '@required can only be used once in the same decorator block.',
    );
    expect(
      duplicates.some((diagnostic) => diagnostic.message.includes('@docs')),
    ).toBe(false);
    expect(
      duplicates.some((diagnostic) => diagnostic.message.includes('@initOp')),
    ).toBe(false);
  });

  // Plugin inits (@initInfisical, @initOp, etc.) are not in the intellisense
  // catalog, so repeatability depends on detecting `@name(` even when `)` is
  // on a later line. One representative covers all of them.
  it('treats multiline open-paren decorator calls as function calls', () => {
    expect(getDecoratorOccurrences('# @initInfisical(', 0)).toEqual([
      {
        name: 'initInfisical',
        line: 0,
        start: 2,
        end: 16,
        isFunctionCall: true,
      },
    ]);

    const diagnostics = createDecoratorDiagnostics([
      ...getDecoratorOccurrences('# @initInfisical(', 0),
      ...getDecoratorOccurrences('# @initInfisical(', 1),
    ]);
    expect(
      diagnostics.some((diagnostic) => diagnostic.message.includes('@initInfisical')),
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

  it('ignores decorator-like text inside regular comments', () => {
    const diagnostics = createDecoratorDiagnostics(
      getDecoratorOccurrences('# this @required mention is just documentation', 0),
    );

    expect(diagnostics).toEqual([]);
  });

  it('ignores decorator-like text inside post-comments on decorator lines', () => {
    const diagnostics = createDecoratorDiagnostics(
      getDecoratorOccurrences('# @required # this @optional is commented', 0),
    );

    expect(diagnostics).toEqual([]);
  });

  it('matches parser behavior for leading @word comments', () => {
    expect(getDecoratorOccurrences('# @todo: revisit this later', 0)).toEqual([
      {
        name: 'todo',
        line: 0,
        start: 2,
        end: 7,
        isFunctionCall: false,
      },
    ]);
    expect(getDecoratorOccurrences('# @see docs for details', 0)).toEqual([
      {
        name: 'see',
        line: 0,
        start: 2,
        end: 6,
        isFunctionCall: false,
      },
    ]);
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

  it('ignores type info inside regular comments above an item', () => {
    const document = createLineDocument([
      '# mention @type=url(prependHttps=true) in docs only',
      'API_URL=example.com',
    ]);

    expect(getTypeInfoFromPrecedingComments(document, 1)).toBeUndefined();
  });

  it('ignores type info inside post-comments on decorator lines', () => {
    const document = createLineDocument([
      '# @required # @type=url(prependHttps=true)',
      'API_URL=example.com',
    ]);

    expect(getTypeInfoFromPrecedingComments(document, 1)).toBeUndefined();
  });

  it('validates enum values against the decorator list', () => {
    const typeInfo = {
      name: 'enum',
      args: ['prod', 'dev'],
      options: {},
    };

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

  it('validates noTrailingSlash url option', () => {
    expect(
      validateStaticValue(
        { name: 'url', args: [], options: { noTrailingSlash: 'true' } },
        'https://example.com/api/',
      ),
    ).toBe('URL must not have a trailing slash.');

    expect(
      validateStaticValue(
        { name: 'url', args: [], options: { noTrailingSlash: 'true' } },
        'https://example.com/api',
      ),
    ).toBeUndefined();

    expect(
      validateStaticValue(
        { name: 'url', args: [], options: { noTrailingSlash: 'true' } },
        'https://example.com',
      ),
    ).toBeUndefined();
  });

  it('validates domain values and options', () => {
    const domainType = (options: Record<string, string> = {}) => (
      { name: 'domain', args: [], options }
    );

    expect(validateStaticValue(domainType(), 'example.com')).toBeUndefined();
    expect(validateStaticValue(domainType(), 'api.internal.example.co.uk')).toBeUndefined();

    expect(validateStaticValue(domainType(), 'https://example.com')).toContain('protocol or path');
    expect(validateStaticValue(domainType(), 'example.com/foo')).toContain('protocol or path');
    expect(validateStaticValue(domainType(), 'example.com:8080')).toContain('port');
    expect(validateStaticValue(domainType(), 'example..com')).toContain('valid domain');
    expect(validateStaticValue(domainType(), '192.168.1.1')).toContain('IP address');

    expect(validateStaticValue(domainType(), '*.example.com')).toContain('allowWildcard');
    expect(validateStaticValue(domainType({ allowWildcard: 'true' }), '*.example.com')).toBeUndefined();

    expect(validateStaticValue(domainType(), 'localhost')).toContain('allowSingleLabel');
    expect(validateStaticValue(domainType({ allowSingleLabel: 'true' }), 'localhost')).toBeUndefined();

    expect(validateStaticValue(domainType({ allowIp: 'true' }), '192.168.1.1')).toBeUndefined();
    expect(validateStaticValue(domainType({ allowIp: 'true' }), 'db.example.com')).toBeUndefined();
    expect(validateStaticValue(domainType({ allowIp: 'true' }), '192.168.1.999')).toContain('IPv4');
    expect(validateStaticValue(domainType({ allowIp: 'true' }), '192.168.1.1:5432')).toContain('port');

    expect(validateStaticValue(domainType({ matches: '\\.example\\.com$' }), 'api.example.com')).toBeUndefined();
    expect(validateStaticValue(domainType({ matches: '\\.example\\.com$' }), 'api.other.com')).toContain('must match');

    // parity with runtime: matches applies to the normalized value, and regex flags are honored
    expect(validateStaticValue(
      domainType({ normalize: 'true', matches: '/^api\\.example\\.com$/' }),
      'API.EXAMPLE.COM',
    )).toBeUndefined();
    expect(validateStaticValue(domainType({ matches: '/^api\\./i' }), 'API.example.com')).toBeUndefined();

    // the wildcard label counts toward the 253-char total length limit
    const suffix253 = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
    expect(validateStaticValue(domainType({ allowWildcard: 'true' }), suffix253)).toBeUndefined();
    expect(validateStaticValue(domainType({ allowWildcard: 'true' }), `*.${suffix253}`)).toContain('valid domain');
  });

  it('validates matches (regex) url option', () => {
    expect(
      validateStaticValue(
        { name: 'url', args: [], options: { matches: '^https://api\\.' } },
        'https://api.example.com',
      ),
    ).toBeUndefined();

    expect(
      validateStaticValue(
        { name: 'url', args: [], options: { matches: '^https://api\\.' } },
        'https://example.com',
      ),
    ).toBe('URL must match `^https://api\\.`.');
  });

  it('validates matches url option using regex() wrapper syntax', () => {
    expect(
      validateStaticValue(
        { name: 'url', args: [], options: { matches: 'regex("^https://api\\.")' } },
        'https://api.example.com',
      ),
    ).toBeUndefined();

    expect(
      validateStaticValue(
        { name: 'url', args: [], options: { matches: 'regex("^https://api\\.")' } },
        'https://example.com',
      ),
    ).toBe('URL must match `regex("^https://api\\.")`.');
  });

  it('validates matches string option using regex() wrapper syntax', () => {
    expect(
      validateStaticValue(
        { name: 'string', args: [], options: { matches: 'regex("^[A-Z]+$")' } },
        'HELLO',
      ),
    ).toBeUndefined();

    expect(
      validateStaticValue(
        { name: 'string', args: [], options: { matches: 'regex("^[A-Z]+$")' } },
        'hello',
      ),
    ).toBe('Value must match `regex("^[A-Z]+$")`.');
  });

  it('validates matches url option using /regex/ literal syntax', () => {
    expect(
      validateStaticValue(
        { name: 'url', args: [], options: { matches: '/^https:\\/\\/api\\./' } },
        'https://api.example.com',
      ),
    ).toBeUndefined();

    expect(
      validateStaticValue(
        { name: 'url', args: [], options: { matches: '/^https:\\/\\/api\\./' } },
        'https://example.com',
      ),
    ).toBe('URL must match `/^https:\\/\\/api\\./`.');
  });

  it('validates matches string option using /regex/ literal syntax', () => {
    expect(
      validateStaticValue(
        { name: 'string', args: [], options: { matches: '/^[A-Z]+$/' } },
        'HELLO',
      ),
    ).toBeUndefined();

    expect(
      validateStaticValue(
        { name: 'string', args: [], options: { matches: '/^[A-Z]+$/' } },
        'hello',
      ),
    ).toBe('Value must match `/^[A-Z]+$/`.');
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
