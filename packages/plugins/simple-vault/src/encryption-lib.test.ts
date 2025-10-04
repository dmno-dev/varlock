import { expect, describe, test } from 'vitest';
import {
  generateEncryptionKeyString,
  importEncryptionKeyString,
  encrypt,
  decrypt,
} from './encryption-lib';
import { webcrypto } from 'node:crypto';

const RAW_VALUE = 'my-secret-value';

describe('simple encryption lib tests', () => {
  let keyStr: string;
  let key: webcrypto.CryptoKey;
  let encryptedStr: string;

  test('create key as string', async () => {
    keyStr = await generateEncryptionKeyString();
    expect(keyStr).toBeTypeOf('string');
    expect(keyStr).toHaveLength(43);
  });
  test('import key from string', async () => {
    key = await importEncryptionKeyString(keyStr);
    expect(key.algorithm).toEqual({ name: 'AES-GCM', length: 256 });
    expect(key.usages).toEqual(['encrypt', 'decrypt']);
    expect(key.extractable).toBe(true);
    expect(key.type).toEqual('secret'); // symmetric key
  });
  test('encrypt', async () => {
    encryptedStr = await encrypt(key, RAW_VALUE);
    expect(encryptedStr).toBeTypeOf('string');
    expect(encryptedStr).not.toEqual(RAW_VALUE);
  });
  test('decrypt', async () => {
    const decryptedValue = await decrypt(key, encryptedStr);
    expect(decryptedValue).toEqual(RAW_VALUE);
  });
});

