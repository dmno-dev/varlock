import { describe, expect, test } from 'vitest';
import { parseEnvSpecDotEnvFile, ParsedEnvSpecFunctionCall } from '@env-spec/parser';

import {
  assertKeychainImportSchemaPresent,
  collectSensitivePlaintextImports,
  extractKeychainRefFromCall,
  formatKeychainRef,
  getSensitivePlaintextImportValue,
  isKeychainItemNotFoundError,
} from '../keychain.command.js';
import { CliExitError } from '../../helpers/exit-error.js';
import { DaemonError } from '../../../lib/local-encrypt/daemon-client.js';

function parseConfigItem(source: string) {
  const file = parseEnvSpecDotEnvFile(source);
  const item = file.configItems[0];
  if (!item) throw new Error('Expected config item');
  return item;
}

function parseValue(source: string) {
  const value = parseConfigItem(source).value;
  if (!(value instanceof ParsedEnvSpecFunctionCall)) throw new Error('Expected function call');
  return value;
}

describe('extractKeychainRefFromCall', () => {
  test('extracts named service and account refs', () => {
    const ref = extractKeychainRefFromCall(
      'API_KEY',
      parseValue('API_KEY=keychain(service="varlock", account="project:jb:API_KEY")'),
    );

    expect(ref).toEqual({
      key: 'API_KEY',
      service: 'varlock',
      account: 'project:jb:API_KEY',
      keychain: undefined,
    });
  });

  test('extracts positional service shorthand', () => {
    const ref = extractKeychainRefFromCall(
      'DATABASE_PASSWORD',
      parseValue('DATABASE_PASSWORD=keychain("com.company.database")'),
    );

    expect(ref).toEqual({
      key: 'DATABASE_PASSWORD',
      service: 'com.company.database',
      account: undefined,
      keychain: undefined,
    });
  });

  test('ignores prompt mode refs', () => {
    const ref = extractKeychainRefFromCall('API_KEY', parseValue('API_KEY=keychain(prompt)'));
    expect(ref).toBeUndefined();
  });

  test('rejects account-only refs because fix-access requires a service', () => {
    expect(() => extractKeychainRefFromCall(
      'API_KEY',
      parseValue('API_KEY=keychain(account="project:jb:API_KEY")'),
    )).toThrow(CliExitError);
  });
});

describe('formatKeychainRef', () => {
  test('escapes env-spec expansion syntax in generated refs', () => {
    expect(formatKeychainRef({
      service: 'var$lock',
      account: 'project:$(whoami):API_KEY',
    })).toBe('keychain(service="var\\$lock", account="project:\\$(whoami):API_KEY")');
  });
});

describe('assertKeychainImportSchemaPresent', () => {
  test('allows import when an explicit schema file was loaded', () => {
    expect(() => assertKeychainImportSchemaPresent({
      sortedDataSources: [{ type: 'container' }, { type: 'schema', fullPath: '/project/.env.schema' }],
    })).not.toThrow();
  });

  test('rejects import when only value env files were loaded', () => {
    expect(() => assertKeychainImportSchemaPresent({
      sortedDataSources: [{ type: 'container' }, { type: 'values', fullPath: '/project/.env' }],
    })).toThrow(CliExitError);
  });
});

describe('getSensitivePlaintextImportValue', () => {
  test('imports schema-sensitive plaintext even without an explicit @sensitive decorator', () => {
    const item = parseConfigItem('API_KEY=secret-value');

    expect(getSensitivePlaintextImportValue({
      isSensitive: true,
      defs: [{ source: { type: 'schema' } }],
    }, item.value)).toBe('secret-value');
  });

  test('skips non-sensitive plaintext values', () => {
    const item = parseConfigItem('PUBLIC_VALUE=hello');

    expect(getSensitivePlaintextImportValue({
      isSensitive: false,
      defs: [{ source: { type: 'schema' } }],
    }, item.value)).toBeUndefined();
  });

  test('skips values that were not defined by the schema file', () => {
    const item = parseConfigItem('UNSCHEMAED_SECRET=secret-value');

    expect(getSensitivePlaintextImportValue({
      isSensitive: true,
      defs: [{ source: { type: 'values' } }],
    }, item.value)).toBeUndefined();
  });
});

describe('collectSensitivePlaintextImports', () => {
  const schema = {
    API_KEY: { isSensitive: true, defs: [{ source: { type: 'schema' } }] },
    PUBLIC_URL: { isSensitive: false, defs: [{ source: { type: 'schema' } }] },
  };

  test('imports only schema-sensitive items, taking values from the input file', () => {
    const file = parseEnvSpecDotEnvFile('API_KEY=from-input-file\nPUBLIC_URL=https://example.com\n');

    expect(collectSensitivePlaintextImports(file.configItems, schema)).toEqual([{ key: 'API_KEY', value: 'from-input-file' }]);
  });

  test('uses the input file value verbatim, never an overriding graph value', () => {
    // The env graph (configSchema) only decides sensitivity; the value to store must come
    // from the input file's own parsed item, even if another file would override it.
    const file = parseEnvSpecDotEnvFile('API_KEY=the-real-input-value\n');

    expect(collectSensitivePlaintextImports(file.configItems, schema)).toEqual([{ key: 'API_KEY', value: 'the-real-input-value' }]);
  });
});

describe('isKeychainItemNotFoundError', () => {
  test('uses stable daemon error codes instead of localized text', () => {
    expect(isKeychainItemNotFoundError(new DaemonError('localized message', 'itemNotFound'))).toBe(true);
    expect(isKeychainItemNotFoundError(new DaemonError('Keychain item not found'))).toBe(false);
  });
});
