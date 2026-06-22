import { describe, expect, test } from 'vitest';
import { parseEnvSpecDotEnvFile, ParsedEnvSpecFunctionCall } from '@env-spec/parser';

import { extractKeychainRefFromCall } from '../keychain.command.js';

function parseValue(source: string) {
  const file = parseEnvSpecDotEnvFile(source);
  const value = file.configItems[0]?.value;
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
});
