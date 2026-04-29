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
});
