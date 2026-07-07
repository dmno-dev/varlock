/**
 * Integration tests for the VarlockResolver (builtin-resolver.ts).
 *
 * Tests the full varlock("local:...") decrypt path end-to-end using the
 * file-based fallback backend (no native binary needed).
 */

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Force file fallback
process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK = '1';

const testDir = path.join(os.tmpdir(), `varlock-resolver-test-${process.pid}`);

vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => testDir,
}));

let localEncrypt: typeof import('./index');
let VarlockResolver: typeof import('./builtin-resolver')['VarlockResolver'];
let StaticValueResolver: typeof import('../../env-graph/lib/resolver')['StaticValueResolver'];

beforeEach(async () => {
  fs.mkdirSync(testDir, { recursive: true });
  vi.resetModules();
  process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK = '1';
  localEncrypt = await import('./index');
  const resolverMod = await import('./builtin-resolver');
  VarlockResolver = resolverMod.VarlockResolver;
  const resolverLib = await import('../../env-graph/lib/resolver');
  StaticValueResolver = resolverLib.StaticValueResolver;
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('VarlockResolver with file fallback', () => {
  it('decrypts a varlock("local:...") payload end-to-end', async () => {
    // Set up: generate a key and encrypt a value
    await localEncrypt.ensureKey();
    const plaintext = 'my-secret-api-key';
    const ciphertext = await localEncrypt.encryptValue(plaintext);
    const payload = `local:${ciphertext}`;

    // Create a resolver instance the way the framework would
    const payloadResolver = new StaticValueResolver(payload);
    const resolver = new VarlockResolver([payloadResolver]);

    // Process (validates args and produces state)
    resolver.process();
    expect(resolver.schemaErrors).toHaveLength(0);

    // Resolve (actually decrypts)
    const result = await resolver.resolve();
    expect(result).toBe(plaintext);
  });

  it('decrypts a payload without the local: prefix', async () => {
    await localEncrypt.ensureKey();
    const plaintext = 'no-prefix-secret';
    const ciphertext = await localEncrypt.encryptValue(plaintext);

    const payloadResolver = new StaticValueResolver(ciphertext);
    const resolver = new VarlockResolver([payloadResolver]);
    resolver.process();
    expect(resolver.schemaErrors).toHaveLength(0);

    const result = await resolver.resolve();
    expect(result).toBe(plaintext);
  });

  it('throws a ResolutionError on invalid ciphertext', async () => {
    await localEncrypt.ensureKey();

    const payloadResolver = new StaticValueResolver('local:garbage-data');
    const resolver = new VarlockResolver([payloadResolver]);
    resolver.process();

    await expect(resolver.resolve()).rejects.toThrow(/Decryption failed/);
  });

  it('throws a SchemaError when no arguments are provided', () => {
    const resolver = new VarlockResolver([]);
    resolver.process();
    expect(resolver.schemaErrors.length).toBeGreaterThan(0);
    expect(resolver.schemaErrors[0].message).toMatch(/expects/);
  });

  it('throws a SchemaError for non-static arguments', () => {
    // A non-static resolver (e.g., another function call) should fail schema validation
    const nonStaticResolver = new VarlockResolver([]); // empty resolver as stand-in
    const resolver = new VarlockResolver([nonStaticResolver]);
    resolver.process();
    expect(resolver.schemaErrors.length).toBeGreaterThan(0);
  });

  it('handles concurrent decrypt calls via batch queue', async () => {
    await localEncrypt.ensureKey();
    const values = ['secret-1', 'secret-2', 'secret-3'];
    const ciphertexts = await Promise.all(
      values.map((v) => localEncrypt.encryptValue(v)),
    );

    // Create resolvers for each
    const resolvers = ciphertexts.map((ct) => {
      const payloadResolver = new StaticValueResolver(`local:${ct}`);
      const resolver = new VarlockResolver([payloadResolver]);
      resolver.process();
      return resolver;
    });

    // Resolve all concurrently (triggers batch processing)
    const results = await Promise.all(resolvers.map((r) => r.resolve()));
    expect(results).toEqual(values);
  });

  it('decrypts with an explicit key= arg using the matching key', async () => {
    await localEncrypt.ensureKey('ci');
    const plaintext = 'ci-only-secret';
    const ciphertext = await localEncrypt.encryptValue(plaintext, 'ci');

    const resolver = new VarlockResolver(
      [new StaticValueResolver(`local:${ciphertext}`)],
      { key: new StaticValueResolver('ci') },
    );
    resolver.process();
    expect(resolver.schemaErrors).toHaveLength(0);
    expect(await resolver.resolve()).toBe(plaintext);
  });

  it('a value encrypted with a named key does NOT decrypt without key= (wrong key)', async () => {
    await localEncrypt.ensureKey(); // default key
    await localEncrypt.ensureKey('ci');
    const ciphertext = await localEncrypt.encryptValue('ci-secret', 'ci');

    // no key= arg → default key → mismatched → decrypt fails
    const resolver = new VarlockResolver([new StaticValueResolver(`local:${ciphertext}`)]);
    resolver.process();
    await expect(resolver.resolve()).rejects.toThrow(/Decryption failed/);
  });

  it('rejects an invalid key= arg with a SchemaError', () => {
    const resolver = new VarlockResolver(
      [new StaticValueResolver('local:whatever')],
      { key: new StaticValueResolver('bad key!') },
    );
    resolver.process();
    expect(resolver.schemaErrors.length).toBeGreaterThan(0);
    expect(resolver.schemaErrors[0].message).toMatch(/not a valid key id/);
  });

  it('surfaces a device-bound hint when the requested key is missing', async () => {
    await localEncrypt.ensureKey(); // only the default key exists
    const ciphertext = await localEncrypt.encryptValue('x'); // encrypted with default
    // reference asks for a key that does not exist on this device
    const resolver = new VarlockResolver(
      [new StaticValueResolver(`local:${ciphertext}`)],
      { key: new StaticValueResolver('does-not-exist') },
    );
    resolver.process();
    const err = await resolver.resolve().then(() => undefined, (e) => e);
    expect(err).toBeDefined();
    expect(err.message).toMatch(/Decryption failed/);
    // the actionable "keys are device-bound" hint lands on the error tip, keyed by the missing key id
    expect(err.tip).toMatch(/device-bound/);
    expect(err.tip).toContain('does-not-exist');
  });
});

describe('buildVarlockReference', () => {
  it('omits key= for the default key and includes it for a named key', async () => {
    const { buildVarlockReference } = await import('./builtin-resolver');
    expect(buildVarlockReference('CT')).toBe('varlock("local:CT")');
    expect(buildVarlockReference('CT', undefined)).toBe('varlock("local:CT")');
    expect(buildVarlockReference('CT', 'ci')).toBe('varlock("local:CT", key="ci")');
  });
});

describe('local-encrypt key metadata (file backend)', () => {
  it('validates key ids', () => {
    expect(localEncrypt.isValidKeyId('ci')).toBe(true);
    expect(localEncrypt.isValidKeyId('varlock-default')).toBe(true);
    expect(localEncrypt.isValidKeyId('deploy_2024.v1')).toBe(true);
    expect(localEncrypt.isValidKeyId('bad key')).toBe(false);
    expect(localEncrypt.isValidKeyId('../escape')).toBe(false);
    expect(localEncrypt.isValidKeyId('')).toBe(false);
  });

  it('lists generated keys (file-backend keys never require presence auth)', async () => {
    await localEncrypt.ensureKey('alpha');
    await localEncrypt.ensureKey('beta');
    const details = localEncrypt.listKeyDetails();
    const ids = details.map((d) => d.keyId).sort();
    expect(ids).toEqual(['alpha', 'beta']);
    expect(details.every((d) => d.requireAuth === false)).toBe(true);
  });
});
