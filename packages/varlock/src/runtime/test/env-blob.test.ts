import { describe, it, expect } from 'vitest';
import { buildEnvBlobBindings, readEnvBlob, chunkString } from '../env-blob';
import { isEncryptedBlob } from '../crypto';

const json = JSON.stringify({ config: { A: { value: 'x'.repeat(3000), isSensitive: false } } });

describe('env blob bindings', () => {
  it('round-trips a small blob as a single __VARLOCK_ENV', () => {
    const bindings = buildEnvBlobBindings({ json });
    expect(Object.keys(bindings)).toEqual(['__VARLOCK_ENV']);
    expect(readEnvBlob(bindings)).toBe(json);
  });

  it('chunks past maxBytes and reassembles', () => {
    const bindings = buildEnvBlobBindings({ json, maxBytes: 1000 });
    expect(bindings.__VARLOCK_ENV).toBeUndefined();
    expect(bindings.__VARLOCK_ENV_CHUNKS).toBe('4');
    expect(Object.keys(bindings).filter((k) => /^__VARLOCK_ENV_\d+$/.test(k)).length).toBe(4);
    expect(readEnvBlob(bindings)).toBe(json);
  });

  it('encrypts when asked and ships the key alongside', () => {
    const bindings = buildEnvBlobBindings({ json, encryptInjectedEnv: true, maxBytes: 5120 });
    expect(bindings._VARLOCK_ENV_KEY).toMatch(/^[0-9a-f]+$/);
    expect(isEncryptedBlob(bindings.__VARLOCK_ENV!)).toBe(true);
    expect(readEnvBlob(bindings)).toBe(json);
  });

  it('reuses an explicit key and chunks the ciphertext', () => {
    const key = 'ab'.repeat(32);
    const bindings = buildEnvBlobBindings({ json, encryptionKey: key, maxBytes: 800 });
    expect(bindings._VARLOCK_ENV_KEY).toBe(key);
    expect(bindings.__VARLOCK_ENV_CHUNKS).toBeDefined();
    expect(readEnvBlob(bindings)).toBe(json);
  });

  it('never splits a multi-byte character', () => {
    const chunks = chunkString('é'.repeat(10), 3);
    expect(chunks.every((c) => new TextEncoder().encode(c).byteLength <= 3)).toBe(true);
    expect(chunks.join('')).toBe('é'.repeat(10));
  });

  it('readEnvBlob validates chunk metadata', () => {
    expect(readEnvBlob({})).toBeUndefined();
    expect(() => readEnvBlob({ __VARLOCK_ENV_CHUNKS: 'nope' })).toThrow(/invalid __VARLOCK_ENV_CHUNKS/);
    expect(() => readEnvBlob({ __VARLOCK_ENV_CHUNKS: '2', __VARLOCK_ENV_0: 'a' })).toThrow(/missing chunk/);
    expect(() => readEnvBlob({ __VARLOCK_ENV: 'varlock:v1:abc' })).toThrow(/_VARLOCK_ENV_KEY/);
  });
});
