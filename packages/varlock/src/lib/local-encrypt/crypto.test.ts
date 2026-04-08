import { describe, it, expect } from 'vitest';
import { createKeyPair, encrypt, decrypt } from './crypto';

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
      'Unsupported payload version',
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
