import { webcrypto } from 'node:crypto';
import type { VarlockPluginDef } from 'varlock/plugin-lib';
import { decrypt, importEncryptionKeyString } from './encryption-lib';

class ResolutionError extends Error {}
class ValidationError extends Error {}
class SchemaError extends Error {}

class SimpleVaultInstance {
  constructor(readonly id: string, readonly keyName: string) {
  }
  private cryptoKey?: webcrypto.CryptoKey;

  async initDecryptionKey(keyStr: string) {
    // save a little work by only initializing the key once
    this.cryptoKey ||= await importEncryptionKeyString(keyStr);
  }

  async decrypt(encryptedStr: string) {
    if (!this.cryptoKey) throw new Error('expected decryption key to be initialized');
    return await decrypt(this.cryptoKey!, encryptedStr);
  }
}
const vaults: Record<string, SimpleVaultInstance> = {};

export const plugin: VarlockPluginDef = {
  // TODO: this info should move to package.json and be read from there
  // because we'll also need it when running CLI commands
  name: 'simple-vault',
  version: '1.0.0',
  description: 'Encrypt/decrypt env values using a simple shared symmetric key',
  // -

  rootDecorators: [
    {
      name: 'initSimpleVault',
      isFunction: true,
      async process(ctx) {
        const fnArgs = ctx.dec.bareFnArgs;
        const argsObj = (fnArgs?.simplifiedValues as any);

        const id = argsObj.id || '_default';
        const keyName = argsObj.key; // name of env var which holds the encryption key

        vaults[id] = new SimpleVaultInstance(id, keyName);
      },
    },
  ],
  dataTypes: [
    {
      name: 'simpleVaultEncryptionKey',
      sensitive: true,
      typeDescription: 'A symmetric encryption key for @varlock/simple-vault-plugin (AES-256-GCM)',
      icon: 'material-symbols:key',
      async validate(val) {
        try {
          // TODO: we could be smarter about combining this check with the vault key above
          await importEncryptionKeyString(val);
        } catch (err) {
          return new ValidationError('Invalid encryption key');
        }
      },
    },
  ],
  resolverFunctions: [
    {
      name: 'simpleVault',
      label: 'Simple Vault Decrypt',
      icon: 'mdi:archive-lock',
      argsSchema: {
        type: 'array',
        arrayMinLength: 1,
      },
      process() {
        if (!this.arrArgs || !this.arrArgs.length) {
          throw new SchemaError('Expected 1 or 2 arguments');
        }

        let vaultId: string;
        let encryptedVal: string;

        if (this.arrArgs.length === 1) {
          vaultId = '_default';
          if (!this.arrArgs[0].isStatic) {
            throw new SchemaError('expected encrypted data to be a static value');
          } else {
            encryptedVal = String(this.arrArgs[0].staticValue);
          }
        } else if (this.arrArgs.length === 2) {
          if (!this.arrArgs[0].isStatic) {
            throw new SchemaError('expected vault id to be a static value');
          } else {
            vaultId = String(this.arrArgs[0].staticValue);
          }

          if (!this.arrArgs[1].isStatic) {
            throw new SchemaError('expected encrypted data to be a static value');
          } else {
            encryptedVal = String(this.arrArgs[1].staticValue);
          }
        } else {
          throw new SchemaError('Expected 1 or 2 args');
        }

        // make sure vault id is valid
        const selectedVault = vaults[vaultId];
        if (!selectedVault) {
          throw new SchemaError(`Invalid vault id "${vaultId}"`);
        }

        // add dependency on env var which contains encrpytion key
        this.addDep(selectedVault.keyName);

        return { vaultId, encryptedVal };
      },
      async resolve({ vaultId, encryptedVal }) {
        const selectedVault = vaults[vaultId];

        // make sure key is not empty
        const keyStr = this.getDepValue(selectedVault.keyName);
        if (!keyStr) {
          throw new ResolutionError(`Expected ${selectedVault.keyName} to contain a decryption key`);
        }

        // now import the key into a webcrypto key, and save within vault object
        // NOTE - if the user used the custom data type, we will already know the key is good
        try {
          await selectedVault.initDecryptionKey(String(keyStr));
        } catch (err) {
          throw new ResolutionError(`Error loading decryption key - ${(err as any).message}`);
        }

        // now the decrypt the data
        try {
          return await selectedVault.decrypt(encryptedVal);
        } catch (err) {
          throw new ResolutionError(`Error decrypting data - ${(err as any).message}`);
        }
      },
    },
  ],

};

