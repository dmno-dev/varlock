import { readFile } from 'node:fs/promises';
import {
  CleartextMessage,
  createMessage,
  decrypt,
  decryptKey,
  encrypt,
  PrivateKey,
  PublicKey,
  readCleartextMessage,
  readKey,
  readMessage,
  readPrivateKey,
} from 'openpgp';

export { PrivateKey, PublicKey } from 'openpgp';

export const encodeMessage = async (message: string | Record<string, any>, pubKey: PublicKey, privKey: PrivateKey) => {
  const text = await createMessage({ text: typeof message === 'string' ? message : JSON.stringify(message) });

  return encrypt({ message: text, encryptionKeys: pubKey, signingKeys: privKey });
};

export const decodeMessage = async (message: string, privateKey: PrivateKey) => {
  const msg = await readMessage({ armoredMessage: message });
  const { data } = await decrypt({ message: msg, decryptionKeys: privateKey });

  return JSON.parse(data);
};

export const getPublicKey = async (key: string): Promise<PublicKey> => {
  const isArmored = key.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----');
  const armoredKey = isArmored ? key : await readFile(key, 'utf8');

  return await readKey({ armoredKey });
};

export const getPrivateKey = async (key: string, passphrase?: string): Promise<PrivateKey> => {
  const isArmored = key.startsWith('-----BEGIN PGP PRIVATE KEY BLOCK-----');
  const armoredKey = isArmored ? key : await readFile(key, 'utf8');
  const privateKey = await readPrivateKey({ armoredKey });

  return passphrase ? decryptKey({ privateKey, passphrase }) : privateKey;
};

export const getMessage = async (message: string): Promise<CleartextMessage> => {
  const isBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message);

  message = isBase64 ? Buffer.from(message, 'base64').toString('utf8') : message;

  return await readCleartextMessage({ cleartextMessage: message });
};
