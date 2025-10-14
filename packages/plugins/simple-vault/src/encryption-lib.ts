import crypto, { JsonWebKey } from 'node:crypto';

const KEY_EXPORT_FORMAT = 'jwk';
const ENCRYPTION_ALGO = 'AES-GCM';
const IV_LENGTH = 12; // For GCM a nonce length of 12 bytes is recommended!
const KEY_USAGES = ['encrypt', 'decrypt'] as const;
const KEY_SPLIT_SEP = '//';

export async function generateEncryptionKeyString() {
  const key = await crypto.subtle.generateKey(
    { name: ENCRYPTION_ALGO, length: 256 },
    true,
    KEY_USAGES,
  );
  const exportableKey = await crypto.subtle.exportKey(KEY_EXPORT_FORMAT, key);
  return exportableKey.k!;
}

export async function importEncryptionKey(keyData: JsonWebKey) {
  return crypto.subtle.importKey(
    KEY_EXPORT_FORMAT,
    keyData,
    ENCRYPTION_ALGO,
    true,
    KEY_USAGES,
  );
}
export async function importEncryptionKeyString(keyStr: string) {
  return importEncryptionKey({
    key_ops: KEY_USAGES,
    ext: true,
    kty: 'oct',
    k: keyStr,
    alg: 'A256GCM',
  });
}


export async function generateDmnoEncryptionKeyString(keyName: string) {
  if (keyName.includes(KEY_SPLIT_SEP)) {
    throw new Error(`dmno encryption key name must not include separator "${KEY_SPLIT_SEP}"`);
  }
  const key = await generateEncryptionKeyString();
  return `dmno${KEY_SPLIT_SEP}${keyName}${KEY_SPLIT_SEP}${key}`;
}

export async function importDmnoEncryptionKeyString(dmnoKeyStr: string) {
  if (!dmnoKeyStr) {
    throw new Error('dmno encryption key must not be empty');
  }
  if (!dmnoKeyStr.startsWith(`dmno${KEY_SPLIT_SEP}`)) {
    throw new Error(`dmno keys must start with dmno${KEY_SPLIT_SEP}`);
  }
  const [,keyName, keyStr] = dmnoKeyStr.split(KEY_SPLIT_SEP);
  if (!keyStr) throw new Error('dmno keys must have a key name');

  const cryptoKey = await importEncryptionKeyString(keyStr);

  return { key: cryptoKey, keyName };
}

export async function encrypt(key: crypto.webcrypto.CryptoKey, rawValue: any, additionalData?: string) {
  const nonce = crypto.randomBytes(IV_LENGTH);

  const encryptedData = await crypto.subtle.encrypt(
    {
      name: ENCRYPTION_ALGO,
      iv: nonce,
      tagLength: 128, // ?
      ...additionalData && { additionalData: Buffer.from(additionalData, 'base64') },
    },
    key,
    new TextEncoder().encode(JSON.stringify(rawValue)),
  );
  const ivWithData = new Uint8Array(
    Array.from(nonce).concat(Array.from(new Uint8Array(encryptedData))),
  );

  const encryptedStr = Buffer.from(ivWithData).toString('base64');
  return encryptedStr;
}


export async function decrypt(key: crypto.webcrypto.CryptoKey, base64EncryptedVal: string, additionalData?: string) {
  const nonceCiphertextTag = Uint8Array.from(atob(base64EncryptedVal), (c) => c.charCodeAt(0));
  const decryptionNonce = nonceCiphertextTag.subarray(0, IV_LENGTH);
  const ciphertextTag = nonceCiphertextTag.subarray(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt({
    name: ENCRYPTION_ALGO,
    iv: decryptionNonce,
    ...additionalData && { additionalData: Buffer.from(additionalData, 'base64') },
  }, key, ciphertextTag);

  const decryptedStr = new TextDecoder().decode(decrypted);
  const decryptedValue = JSON.parse(decryptedStr);
  return decryptedValue;
}

