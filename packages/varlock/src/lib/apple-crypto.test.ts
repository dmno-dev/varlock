import { describe, it, expect } from 'vitest';
import { createKeyPair, decrypt, encrypt } from './apple-crypto';

// this data was created by swift using apple crypto utils
const APPLE_EXAMPLE = {
  // `SecKeyCreateRandomKey()` (bits = 256, type = kSecAttrKeyTypeECSECPrimeRandom), exported w/ `key.base64EncodedString()`
  privateKey: 'BASjpkY5BcnSK4EzP5JF36Sjxh0m1UO8TlZiIYgCExXdvqU8m6sadOw8d5e5Lg0vaxPz4ofVpZrV8effVyzADgosT+TglfeSwQvd/Z5+LeGxReMkskZ3jeguH4qrHnMiOQ==',
  publicKey: 'BASjpkY5BcnSK4EzP5JF36Sjxh0m1UO8TlZiIYgCExXdvqU8m6sadOw8d5e5Lg0vaxPz4ofVpZrV8effVyzADgo=',
  // `SecKeyCreateEncryptedData()` (algo = `eciesEncryptionCofactorVariableIVX963SHA384AESGCM`, using above key)
  encryptedMessage: 'BAyJ8n03fcjFIswbi3ddWpShecHzEwkdssqXRX82dkZSRM4PAidGNzVopykwI8FWfFj3yhS7ff8WgqNg61SftLrBcVKSm2uwn+oS7wzGg8Lq07J5bJj+hRBdJgStLBD5LurJV3nMofM=',
  decryptedMessage: 'hello world from swift!',
};

describe('apple-compatible cryptographic utils', () => {
  it('can decrypt using a private key and message created by swift', async () => {
    const decrypted = await decrypt(APPLE_EXAMPLE.privateKey, APPLE_EXAMPLE.encryptedMessage);
    expect(decrypted).toBe(APPLE_EXAMPLE.decryptedMessage);
  });

  it('can encrypt a new message using the public key and decrypt it using the private key', async () => {
    const message = `hello world from node! @ ${new Date().toISOString()}`;
    const encrypted = await encrypt(APPLE_EXAMPLE.publicKey, message);
    const decrypted = await decrypt(APPLE_EXAMPLE.privateKey, encrypted);
    expect(decrypted).toBe(message);
  });
  it('can encrypt a new message using the private key and decrypt it using the private key', async () => {
    const message = `hello world from node! @ ${new Date().toISOString()}`;
    const encrypted = await encrypt(APPLE_EXAMPLE.privateKey, message);
    const decrypted = await decrypt(APPLE_EXAMPLE.privateKey, encrypted);
    expect(decrypted).toBe(message);
  });

  it('can create a new keypair, and encrypt/decrypt with it', async () => {
    // NOTE - this obviously doesn't test that the keypair can be used by swift, but that has been manually veriried
    const keypair = await createKeyPair();
    const message = `hello world from node! @ ${new Date().toISOString()}`;
    const encrypted = await encrypt(keypair.publicKey, message);
    const decrypted = await decrypt(keypair.privateKey, encrypted);
    expect(decrypted).toBe(message);
  });
});
