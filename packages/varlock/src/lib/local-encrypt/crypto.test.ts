import { describe, it, expect } from 'vitest';
import {
  DEVICE_PAYLOAD_VERSION, IDENTITY_PAYLOAD_VERSION, assertSupportedPayloadVersion,
  createKeyPair, encrypt, decrypt, readPayloadVersion,
} from './crypto';

describe('ECIES crypto', () => {
  it('round-trips encrypt → decrypt', async () => {
    const keyPair = await createKeyPair();
    const plaintext = 'hello world — this is a secret!';

    const ciphertext = await encrypt(keyPair.publicKey, plaintext);
    const decrypted = await decrypt(keyPair.privateKey, keyPair.publicKey, ciphertext);

    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext each time (random nonce)', async () => {
    const keyPair = await createKeyPair();
    const plaintext = 'same input';

    const ct1 = await encrypt(keyPair.publicKey, plaintext);
    const ct2 = await encrypt(keyPair.publicKey, plaintext);

    expect(ct1).not.toBe(ct2);

    // But both decrypt to the same value
    expect(await decrypt(keyPair.privateKey, keyPair.publicKey, ct1)).toBe(plaintext);
    expect(await decrypt(keyPair.privateKey, keyPair.publicKey, ct2)).toBe(plaintext);
  });

  it('fails with wrong private key', async () => {
    const keyPair1 = await createKeyPair();
    const keyPair2 = await createKeyPair();
    const plaintext = 'secret';

    const ciphertext = await encrypt(keyPair1.publicKey, plaintext);

    await expect(decrypt(keyPair2.privateKey, keyPair2.publicKey, ciphertext)).rejects.toThrow();
  });

  it('fails with truncated payload', async () => {
    const keyPair = await createKeyPair();
    const ciphertext = await encrypt(keyPair.publicKey, 'test');

    // Truncate the base64 payload
    const truncated = ciphertext.slice(0, 20);
    await expect(decrypt(keyPair.privateKey, keyPair.publicKey, truncated)).rejects.toThrow('Payload too short');
  });

  it('fails with wrong version byte', async () => {
    const keyPair = await createKeyPair();
    const ciphertext = await encrypt(keyPair.publicKey, 'test');

    // Decode, change version byte, re-encode
    const buf = Buffer.from(ciphertext, 'base64');
    buf[0] = 0xFF;
    const tampered = buf.toString('base64');

    await expect(decrypt(keyPair.privateKey, keyPair.publicKey, tampered)).rejects.toThrow(
      'unsupported encrypted payload version 255',
    );
  });

  it('handles empty string', async () => {
    const keyPair = await createKeyPair();
    const ciphertext = await encrypt(keyPair.publicKey, '');
    const decrypted = await decrypt(keyPair.privateKey, keyPair.publicKey, ciphertext);
    expect(decrypted).toBe('');
  });

  it('handles unicode and emoji', async () => {
    const keyPair = await createKeyPair();
    const plaintext = 'こんにちは 🔐 résumé café';
    const ciphertext = await encrypt(keyPair.publicKey, plaintext);
    const decrypted = await decrypt(keyPair.privateKey, keyPair.publicKey, ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('handles large payloads', async () => {
    const keyPair = await createKeyPair();
    const plaintext = 'x'.repeat(100_000);
    const ciphertext = await encrypt(keyPair.publicKey, plaintext);
    const decrypted = await decrypt(keyPair.privateKey, keyPair.publicKey, ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('payload has correct structure', async () => {
    const keyPair = await createKeyPair();
    const ciphertext = await encrypt(keyPair.publicKey, 'test');
    const payload = Buffer.from(ciphertext, 'base64');

    // version(1) + ephemeralPubKey(65) + nonce(12) + ciphertext(4 for "test") + tag(16) = 98
    expect(payload[0]).toBe(0x01); // version
    expect(payload[1]).toBe(0x04); // uncompressed point prefix
    expect(payload.length).toBe(1 + 65 + 12 + 4 + 16); // 98 bytes
  });
});

describe('assertSupportedPayloadVersion', () => {
  /** Build a payload-shaped buffer whose first byte is the given version */
  function payloadWithVersion(version: number) {
    const buf = Buffer.alloc(1 + 65 + 12 + 4 + 16);
    buf[0] = version;
    buf[1] = 0x04;
    return buf.toString('base64');
  }

  it('accepts a real v1 payload', async () => {
    const keyPair = await createKeyPair();
    const ciphertext = await encrypt(keyPair.publicKey, 'test');
    expect(DEVICE_PAYLOAD_VERSION).toBe(0x01);
    expect(() => assertSupportedPayloadVersion(ciphertext)).not.toThrow();
  });

  it('accepts a synthetic v1 payload', () => {
    expect(() => assertSupportedPayloadVersion(payloadWithVersion(0x01))).not.toThrow();
  });

  it('accepts a v2 (identity-encrypted) payload', () => {
    expect(IDENTITY_PAYLOAD_VERSION).toBe(0x02);
    expect(() => assertSupportedPayloadVersion(payloadWithVersion(0x02))).not.toThrow();
  });

  it('rejects a v3 payload with an upgrade hint', () => {
    expect(() => assertSupportedPayloadVersion(payloadWithVersion(0x03)))
      .toThrow('unsupported encrypted payload version 3; upgrade varlock');
  });

  it('reports the actual version number it found', () => {
    expect(() => assertSupportedPayloadVersion(payloadWithVersion(0xFF)))
      .toThrow('unsupported encrypted payload version 255');
  });

  it('leaves non-payload junk to the backend to report', () => {
    // not canonical base64, so it is not one of our payloads at all
    expect(() => assertSupportedPayloadVersion('garbage-data')).not.toThrow();
    expect(() => assertSupportedPayloadVersion('not-valid-base64-ciphertext!')).not.toThrow();
    expect(() => assertSupportedPayloadVersion('')).not.toThrow();
  });
});

describe('readPayloadVersion', () => {
  it('reports the version byte of a real payload', async () => {
    const keyPair = await createKeyPair();
    const v1 = await encrypt(keyPair.publicKey, 'test');
    const v2 = await encrypt(keyPair.publicKey, 'test', { version: IDENTITY_PAYLOAD_VERSION });
    expect(readPayloadVersion(v1)).toBe(0x01);
    expect(readPayloadVersion(v2)).toBe(0x02);
  });

  it('returns undefined for things that are not payloads', () => {
    expect(readPayloadVersion('')).toBeUndefined();
    expect(readPayloadVersion('not-valid-base64-ciphertext!')).toBeUndefined();
  });
});

describe('identity (v2) payloads', () => {
  it('round-trips encrypt → decrypt', async () => {
    const keyPair = await createKeyPair();
    const plaintext = 'identity-encrypted secret';

    const ciphertext = await encrypt(keyPair.publicKey, plaintext, { version: IDENTITY_PAYLOAD_VERSION });
    expect(Buffer.from(ciphertext, 'base64')[0]).toBe(0x02);

    expect(await decrypt(keyPair.privateKey, keyPair.publicKey, ciphertext)).toBe(plaintext);
  });

  it('uses the same wire format as v1 apart from the version byte', async () => {
    const keyPair = await createKeyPair();
    const v1 = Buffer.from(await encrypt(keyPair.publicKey, 'test'), 'base64');
    const v2 = Buffer.from(
      await encrypt(keyPair.publicKey, 'test', { version: IDENTITY_PAYLOAD_VERSION }),
      'base64',
    );
    expect(v2.length).toBe(v1.length);
    expect(v2[1]).toBe(0x04); // uncompressed point prefix
  });
});
