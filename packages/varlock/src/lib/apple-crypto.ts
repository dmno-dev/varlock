/*
  This is a set of crypto utility functions that are compatible with those found in the Apple Security SDKs

  Specifically, `createKeyPair()` creates a keypair compatible with
  > SecKeyCreateRandomKey (bits = 256, type = kSecAttrKeyTypeECSECPrimeRandom)
  and `encrypt()` and `decrypt()` are compatible with the output of
  > SecKeyCreateEncryptedData / SecKeyCreateDecryptedData - algo = `eciesEncryptionCofactorVariableIVX963SHA384AESGCM`, keys as above

  This is so that we can use the same keypair for a machine with the native app and without
  or transfer a key from the home folder to the native app, if the user installs it later

  NOTE:The Apple SecKey format for EC keys uses X9.63 format
  For P-256, the public key point coordinates are 32 bytes each
  > public key:  04 || X || Y       (65 bytes for P-256)
  > private key: 04 || X || Y || D  (97 bytes for P-256)

  None of how this works is well documented anywhere, but was based on this article and linked go library
  https://jedda.me/cross-platform-encryption-with-apples-secure-enclave/
*/

import crypto from 'node:crypto';

const CURVE_TYPE = 'P-256';
const KDF_ALGO = 'SHA-384';
const IV_SIZE = 16;
const AES_KEY_SIZE = 16; // AES-128 for P-256
const EPHEMERAL_KEY_SIZE = 65; // P-256 uncompressed point format
const SHARED_SECRET_BITS = 256;
const ENCRYPTION_ALGO = 'AES-GCM';


function arrayBufferToStr(buffer: Uint8Array) {
  return String.fromCharCode.apply(null, Array.from(buffer));
}
function base64ToArrayBuffer(base64: string, urlSafe = false) {
  if (urlSafe) base64 = base64.replaceAll('-', '+').replaceAll('_', '/');
  const binaryString = atob(base64);
  return Uint8Array.from(binaryString, (char) => char.charCodeAt(0));
}

function arrayBufferToBase64(buffer: Uint8Array, urlSafe = false) {
  const base64 = btoa(arrayBufferToStr(buffer));
  if (urlSafe) return base64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  else return base64;
}

async function exportPrivateKeyToBase64Keypair(privateKey: crypto.webcrypto.CryptoKey) {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const { x, y, d } = jwk;
  const xBuf = base64ToArrayBuffer(x!, true);
  const yBuf = base64ToArrayBuffer(y!, true);
  const dBuf = base64ToArrayBuffer(d!, true);

  return {
    privateKey: arrayBufferToBase64(new Uint8Array([4, ...xBuf, ...yBuf, ...dBuf])),
    publicKey: arrayBufferToBase64(new Uint8Array([4, ...xBuf, ...yBuf])),
  };
}

async function importKeyFromBase64(base64Key: string, isPrivate: boolean) {
  const keyData = base64ToArrayBuffer(base64Key);

  const x = keyData.slice(1, 33);
  const y = keyData.slice(33, 65);
  const d = isPrivate ? keyData.slice(65, 97) : undefined;

  const publicKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: CURVE_TYPE,
      x: arrayBufferToBase64(x, true),
      y: arrayBufferToBase64(y, true),
      ...d && { d: arrayBufferToBase64(d, true) },
      ext: true,
    },
    {
      name: 'ECDH',
      namedCurve: CURVE_TYPE,
    },
    true,
    isPrivate ? ['deriveKey', 'deriveBits'] : [],
  );
  return publicKey;
}

async function derivePublicKeyFromPrivate(privateKey: crypto.webcrypto.CryptoKey) {
  // Export the private key to JWK format to get the x, y coordinates
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);

  // Create a public JWK using the same x, y coordinates
  const publicJwk = {
    kty: 'EC',
    crv: CURVE_TYPE,
    x: jwk.x,
    y: jwk.y,
    ext: true,
  };

  // Import as public key
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicJwk,
    {
      name: 'ECDH',
      namedCurve: CURVE_TYPE,
    },
    true,
    [], // Public key has no allowed operations
  );

  return publicKey;
}

async function encryptECIESX963AESGCM(publicKey: crypto.webcrypto.CryptoKey, plaintext: Uint8Array) {
  try {
    // Generate ephemeral key pair
    const ephemeralKeyPair = await crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: CURVE_TYPE,
      },
      true,
      ['deriveKey', 'deriveBits'],
    );

    // Export ephemeral public key to raw format
    const ephemeralPublicKeyRaw = await crypto.subtle.exportKey('raw', ephemeralKeyPair.publicKey);

    // Perform ECDH to get shared secret
    const sharedSecret = await crypto.subtle.deriveBits(
      {
        name: 'ECDH',
        public: publicKey,
      },
      ephemeralKeyPair.privateKey,
      SHARED_SECRET_BITS,
    );

    // X9.63 KDF implementation
    const kdfInput = new Uint8Array([
      ...new Uint8Array(sharedSecret),
      0,
      0,
      0,
      1, // Counter = 1
      ...new Uint8Array(ephemeralPublicKeyRaw), // SharedInfo = ephemeral public key
    ]);

    // Derive key material
    const derivedMaterial = await crypto.subtle.digest(KDF_ALGO, kdfInput);

    // Split derived material into key and IV
    const derivedBytes = new Uint8Array(derivedMaterial);
    const aesKeyBytes = derivedBytes.slice(0, AES_KEY_SIZE);
    const iv = derivedBytes.slice(AES_KEY_SIZE, AES_KEY_SIZE + IV_SIZE);

    // Import AES key
    const aesKey = await crypto.subtle.importKey(
      'raw',
      aesKeyBytes,
      { name: ENCRYPTION_ALGO },
      false,
      ['encrypt'],
    );

    // Encrypt the plaintext
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: ENCRYPTION_ALGO,
        iv,
        tagLength: 128,
      },
      aesKey,
      plaintext,
    );

    // Combine ephemeral public key and ciphertext
    return new Uint8Array([
      ...new Uint8Array(ephemeralPublicKeyRaw),
      ...new Uint8Array(ciphertext),
    ]);
  } catch (error) {
    throw new Error('Encryption failed', { cause: error });
  }
}

async function decryptECIESX963AESGCM(privateKey: crypto.webcrypto.CryptoKey, ciphertext: Uint8Array) {
  try {
    // Extract ephemeral public key and actual ciphertext
    const ephemeralPubKeyRaw = ciphertext.slice(0, EPHEMERAL_KEY_SIZE);
    const encryptedData = ciphertext.slice(EPHEMERAL_KEY_SIZE);

    // Import ephemeral public key
    const ephemeralKey = await crypto.subtle.importKey(
      'raw',
      ephemeralPubKeyRaw,
      {
        name: 'ECDH',
        namedCurve: CURVE_TYPE,
      },
      false,
      [],
    );

    // Perform ECDH to get shared secret
    const sharedSecret = await crypto.subtle.deriveBits(
      {
        name: 'ECDH',
        public: ephemeralKey,
      },
      privateKey,
      SHARED_SECRET_BITS,
    );

    // X9.63 KDF
    const kdfInput = new Uint8Array([
      ...new Uint8Array(sharedSecret),
      0,
      0,
      0,
      1, // Counter = 1
      ...ephemeralPubKeyRaw, // SharedInfo = ephemeral public key
    ]);

    // Derive key material
    const derivedMaterial = await crypto.subtle.digest(KDF_ALGO, kdfInput);

    // Split derived material into key and IV
    const derivedBytes = new Uint8Array(derivedMaterial);
    const aesKeyBytes = derivedBytes.slice(0, AES_KEY_SIZE);
    const iv = derivedBytes.slice(AES_KEY_SIZE, AES_KEY_SIZE + IV_SIZE);

    // Import AES key
    const aesKey = await crypto.subtle.importKey(
      'raw',
      aesKeyBytes,
      { name: ENCRYPTION_ALGO },
      false,
      ['decrypt'],
    );

    // Decrypt
    const plaintext = await crypto.subtle.decrypt(
      {
        name: ENCRYPTION_ALGO,
        iv,
        tagLength: 128,
      },
      aesKey,
      encryptedData,
    );

    const plaintextData = new Uint8Array(plaintext);
    return new TextDecoder().decode(plaintextData);
  } catch (error) {
    throw new Error('Decryption failed', { cause: error });
  }
}



export async function createKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: CURVE_TYPE,
    },
    true,
    ['deriveKey', 'deriveBits'],
  );
  return exportPrivateKeyToBase64Keypair(keyPair.privateKey);
}

export async function decrypt(privateKeyBase64: string, encryptedMessageBase64: string) {
  const privateKey = await importKeyFromBase64(privateKeyBase64, true);

  const decrypted = await decryptECIESX963AESGCM(
    privateKey,
    base64ToArrayBuffer(encryptedMessageBase64),
  );
  return decrypted;
}

export async function encrypt(publicOrPrivateKeyBase64: string, plaintext: string) {
  const publicKey = await importKeyFromBase64(publicOrPrivateKeyBase64, false);
  const encrypted = await encryptECIESX963AESGCM(
    publicKey,
    new TextEncoder().encode(plaintext),
  );
  return arrayBufferToBase64(encrypted);
}
