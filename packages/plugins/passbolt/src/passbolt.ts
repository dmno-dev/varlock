import type {
  ClientOptions,
  CustomFieldKey,
  CustomFieldValue,
  Resource,
  Folder,
  ApiResource,
  UUIDv4String,
  GpgAccountKit,
  SecretIndex,
  ApiFolder,
  GpgSecret,
} from './types';
import {
  getPrivateKey, PrivateKey, getMessage, getPublicKey,
} from './openpgp';
import { ApiClient } from './apiClient';
import { webcrypto } from 'node:crypto';

export type { ClientOptions, UUIDv4String } from './types';

const defaultOptions: Partial<ClientOptions> = {
  duration: 1000 * 60 * 10, // 10minutes
};

export class PassboltClient {
  private readonly duration: number;
  private readonly options: ClientOptions;
  private readonly apiClient: ApiClient;

  private metadataKeys: Map<string, PrivateKey>;
  private initialized: boolean;
  private privateKey: PrivateKey | undefined;

  constructor(options: ClientOptions) {
    this.options = { ...defaultOptions, ...options };

    this.metadataKeys = new Map<string, PrivateKey>();
    this.duration = this.options.duration!;
    this.initialized = false;
    this.privateKey = undefined;
    this.apiClient = new ApiClient(this.options.serverUrl);
  }

  public get isInitialized() {
    return this.initialized && this.apiClient.isAuthorized;
  }

  public static async instantiateWithAccountKit(accountKit: string, passphrase: string): Promise<PassboltClient> {
    try {
      const message = await getMessage(accountKit);
      const data = JSON.parse(message.getText());

      if (PassboltClient.isAccountKit(data)) {
        const privateKey = data.user_private_armored_key;
        const userId = data.user_id;
        const serverUrl = data.domain;
        const publicKey = await getPublicKey(data.user_public_armored_key);
        const verifyResult = await message.verify([publicKey]);

        if (await verifyResult[0].verified) {
          return new PassboltClient({
            passphrase, privateKey, serverUrl, userId, duration: defaultOptions.duration,
          });
        }
      }
    } catch (err) {
      // do nothing
    }
    return new PassboltClient({} as ClientOptions);
  }

  public static isAccountKit(data: any): data is GpgAccountKit {
    const {
      user_id: userId,
      domain,
      user_public_armored_key: userPublicArmoredKey,
      user_private_armored_key: userPrivateArmoredKey,
      server_public_armored_key: serverPublicArmoredKey,
    } = data as GpgAccountKit;

    return [userId, domain, userPublicArmoredKey, userPrivateArmoredKey, serverPublicArmoredKey].every(Boolean);
  }

  private base32ToBuffer(str: string) {
    str = str.toUpperCase().replace(/=+$/, '');

    if (!/^[A-Z234567]+$/.test(str)) {
      return;
    }

    const buffer = Buffer.alloc((str.length * 5) / 8);

    for (let i = 0, val = 0, bits = 0, idx = 0, chr = str.charCodeAt(0); i < str.length; chr = str.charCodeAt(++i)) {
      val = (val << 5) | (chr - (chr >= 65 ? 65 : 24)); // eslint-disable-line no-bitwise
      bits += 5;

      if (bits >= 8) {
        buffer[idx++] = (val >>> (bits -= 8)) & 255; // eslint-disable-line no-bitwise
      }
    }

    return buffer;
  }

  private async generateTotpCode(secret: GpgSecret) {
    if (!secret.totp) {
      return;
    }

    const algorithmMap: Record<string, string> = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };
    const totp = secret.totp;
    const keyBuffer = this.base32ToBuffer(totp.secret_key);

    if (!keyBuffer) {
      return;
    }

    const epochSeconds = Math.floor(Date.now() / 1000);
    const timeHex = Math.floor(epochSeconds / totp.period).toString(16).padStart(16, '0');
    const crypto = webcrypto.subtle;
    const algorithm = { name: 'HMAC', hash: { name: algorithmMap[totp.algorithm] ?? 'SHA-1' } };
    const hmacKey = await crypto.importKey('raw', keyBuffer, algorithm, false, ['sign']);
    const signature = await crypto.sign('HMAC', hmacKey, Buffer.from(timeHex, 'hex'));
    const signatureHex = Buffer.from(signature).toString('hex');
    const offset = Number(`0x${signatureHex.slice(-1)}`) * 2;
    const masked = Number(`0x${signatureHex.slice(offset, offset + 8)}`) & 0x7fffffff; // eslint-disable-line no-bitwise

    return masked.toString().slice(-totp.digits);
  }

  private parseCustomFields(customKeys?: Array<CustomFieldKey>, customValues?: Array<CustomFieldValue>) {
    if (!customKeys || !customValues) {
      return;
    }

    const keys = customKeys.reduce<Record<string, string>>((p, c) => {
      p[c.id] = c.metadata_key;
      return p;
    }, {});
    const values = customValues.reduce<Record<string, string>>((p, c) => {
      p[c.id] = c.secret_value;
      return p;
    }, {});

    return customKeys.reduce<Record<string, string>>((p, c) => {
      p[keys[c.id]] = values[c.id];
      return p;
    }, {});
  }

  private async decodeResource(resource: ApiResource): Promise<Resource | void> {
    const [secret] = resource.secrets as unknown as Array<SecretIndex>;
    const decSecret = await this.apiClient.decodeSecret(secret.data, this.privateKey!);
    const password = decSecret?.password;
    const totp = decSecret?.totp ? {
      secretKey: decSecret.totp.secret_key,
      period: decSecret.totp.period,
      digits: decSecret.totp.digits,
      algorithm: decSecret.totp.algorithm,
      code: await this.generateTotpCode(decSecret),
    } : undefined;

    if (!this.apiClient.isResourceV5IndexAndView(resource)) {
      return {
        id: resource.id,
        name: resource.name,
        uri: resource.uri,
        username: resource.username,
        totp,
        password,
      };
    }

    const { metadata, metadata_key_id: metadataKeyId } = resource;
    const metakey = this.metadataKeys.get(metadataKeyId);

    if (metakey) {
      const decodedMetadata = await this.apiClient.decodeMetadata(metadata, metakey);
      const customFields = this.parseCustomFields(decodedMetadata.custom_fields, decSecret.custom_fields);

      return {
        id: resource.id,
        name: decodedMetadata.name,
        uri: decodedMetadata.uris[0],
        username: decodedMetadata.username,
        totp,
        password,
        customFields,
      };
    }
  }

  private async convertToFolder(folder: ApiFolder): Promise<Folder | void> {
    if (!this.apiClient.isFolderV5IndexAndView(folder)) {
      return { id: folder.id, name: folder.name, parent: folder.folder_parent_id };
    }

    const { metadata, metadata_key_id: metadataKeyId } = folder;
    const metakey = this.metadataKeys.get(metadataKeyId);

    if (metakey) {
      const decodedMetadata = await this.apiClient.decodeMetadata(metadata, metakey);

      return { id: folder.id, name: decodedMetadata.name, parent: folder.folder_parent_id };
    }
  }

  public async init() {
    const { userId, passphrase, privateKey } = this.options;

    try {
      this.privateKey = await getPrivateKey(privateKey, passphrase);

      await this.apiClient.login(userId, this.privateKey, this.duration);
    } catch (err) {
      this.initialized = false;
      this.privateKey = undefined;
      this.metadataKeys.clear();
    } finally {
      this.initialized = this.apiClient.isAuthorized && this.privateKey !== undefined;

      if (this.initialized) {
        this.metadataKeys = await this.apiClient.getUserMetadataKeys(userId, this.privateKey!);
      }
    }
  }

  public async getResource(resourceId: UUIDv4String): Promise<Resource | void> {
    if (!this.isInitialized) {
      await this.init();
    }

    try {
      const resource = await this.apiClient.getResource(resourceId);

      return await this.decodeResource(resource);
    } catch (err) {
      return;
    } finally {
      this.apiClient.logout().catch(() => { /* do nothing */ });
    }
  }

  public async getResources(folderId: UUIDv4String): Promise<Array<Resource>> {
    if (!this.isInitialized) {
      await this.init();
    }

    try {
      const resources = await this.apiClient.getResources(folderId);
      const decodedResources = await Promise.all(resources.map(this.decodeResource.bind(this)));

      return decodedResources.filter((res) => res !== undefined) as Array<Resource>;
    } catch (err) {
      return [];
    } finally {
      this.apiClient.logout().catch(() => { /* do nothing */ });
    }
  }

  public async findFolder(
    search: string,
    folders?: Array<Folder>,
    parent?: string | null,
  ): Promise<UUIDv4String | undefined> {
    if (!this.isInitialized) {
      await this.init();
    }

    parent ??= null;

    try {
      if (!folders) {
        const rawFolders = await this.apiClient.getFolders();
        const decoded = await Promise.all(rawFolders.map(this.convertToFolder.bind(this)));

        folders = decoded.filter((item) => item !== undefined) as Array<Folder>;
      }

      if (!folders) {
        return;
      }

      const parts = search.split(/(?<!\\)\//).map((e) => e.replaceAll(/\\\//g, '/'));
      const part = parts.shift();
      const found = folders.find((folder) => folder.name === part && folder.parent === parent);

      if (!found) {
        return;
      }

      if (parts.length) {
        return this.findFolder(parts.join('/'), folders, found.id);
      } else {
        return found.id as UUIDv4String;
      }
    } catch (err) {
      return;
    } finally {
      this.apiClient.logout().catch(() => { /* do nothing */ });
    }
  }
}
