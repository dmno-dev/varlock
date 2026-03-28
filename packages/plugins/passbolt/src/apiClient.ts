import type {
  FolderV5IndexAndView,
  GpgChallengeRequest,
  GpgChallengeResponse,
  GpgMetadata,
  GpgMetadataPrivateKey,
  GpgSecret,
  ApiResource,
  ApiFolder,
  FoldersResponse,
  ResourceResponse,
  ResourcesResponse,
  MetadataKeyResponse,
  ResourceV5IndexAndView,
  LoginResponse,
  LogoutResponse,
  VerifyResponse,
  RefreshResponse,
  UUIDv4String,
} from './types';
import ky, { type KyInstance } from 'ky';
import { randomUUID } from 'node:crypto';
import {
  decodeMessage, encodeMessage, getPrivateKey, getPublicKey, PrivateKey,
} from './openpgp';

export class ApiClient {
  private accessToken?: string;
  private refreshToken?: string;
  private tokenExpiry?: number;
  private readonly baseUrl: string;
  private api: KyInstance;

  constructor(serverUrl: string) {
    this.baseUrl = serverUrl;
    this.api = ky.create({ prefixUrl: this.baseUrl });
  }

  public get isAuthorized() {
    return [
      this.accessToken !== undefined,
      this.refreshToken !== undefined,
      this.tokenExpiry !== undefined && Date.now() <= this.tokenExpiry,
    ].every(Boolean);
  }

  private createAuthChallenge(duration: number): GpgChallengeRequest {
    return {
      version: '1.0.0',
      domain: this.baseUrl,
      verify_token: randomUUID() as UUIDv4String,
      verify_token_expiry: Math.round((Date.now() + duration) / 1000),
    };
  }

  public async login(userId: string, privateKey: PrivateKey, duration: number): Promise<void> {
    try {
      if (!this.isAuthorized) {
        const
          { body: publicKey } = await this.api.get('auth/verify.json').json<VerifyResponse>();
        const pub = await getPublicKey(publicKey.keydata);
        const authChallenge = this.createAuthChallenge(duration);
        const challenge = await encodeMessage(authChallenge, pub, privateKey);
        const loginRequest = { user_id: userId, challenge };
        const { body } = await this.api.post('auth/jwt/login.json', { json: loginRequest }).json<LoginResponse>();
        const challengeResponse = await decodeMessage(body.challenge, privateKey) as GpgChallengeResponse;
        const { verify_token: verifyToken, access_token: accessToken, refresh_token: refreshToken } = challengeResponse;

        if (accessToken && refreshToken && verifyToken === authChallenge.verify_token) {
          this.accessToken = accessToken;
          this.refreshToken = refreshToken;
          this.tokenExpiry = authChallenge.verify_token_expiry * 1000;
        }
      } else {
        const
          request = { user_id: userId, refresh_token: this.refreshToken! };
        const { body } = await this.api.post('auth/jwt/refresh.json', { json: request }).json<RefreshResponse>();

        this.accessToken = body.access_token;
        this.tokenExpiry = Date.now() + duration;
      }
    } catch (err) {
      this.accessToken = undefined;
      this.refreshToken = undefined;
      this.tokenExpiry = undefined;
    } finally {
      if (this.isAuthorized) {
        this.api = this.api.extend({ headers: { Authorization: `Bearer ${this.accessToken}` } });
      }
    }
  }

  public async logout(): Promise<void> {
    try {
      if (this.isAuthorized) {
        const request = { refresh_token: this.refreshToken };

        await this.api.post('auth/jwt/logout.json', { json: request }).json<LogoutResponse>();
      }
      this.accessToken = undefined;
      this.refreshToken = undefined;
      this.tokenExpiry = undefined;
    } catch (err) {
      // do nothing
    }
  }

  public async getUserMetadataKeys(userId: string, privateKey: PrivateKey): Promise<Map<string, PrivateKey>> {
    const keyMap = new Map<string, PrivateKey>();

    try {
      const
        { origin } = new URL(this.baseUrl);
      const searchParams = { 'filter[deleted]': 0, 'filter[expired]': 0, 'contain[metadata_private_keys]': 1 };
      const { body } = await this.api.get('metadata/keys.json', { searchParams }).json<MetadataKeyResponse>();

      for await (const { metadata_private_keys: metadataPrivateKeys } of body) {
        for await (const { metadata_key_id: metadataKeyId, user_id: _userId, data } of metadataPrivateKeys ?? []) {
          if (_userId === userId) {
            const { domain, armored_key: armoredKey } = await decodeMessage(data, privateKey) as GpgMetadataPrivateKey;

            if (domain === origin) {
              keyMap.set(metadataKeyId, await getPrivateKey(armoredKey));
            }
          }
        }
      }
    } catch (err) {
      // do nothing
    }
    return keyMap;
  }

  public async getResource(resourceId: UUIDv4String): Promise<ApiResource> {
    resourceId = encodeURIComponent(resourceId) as UUIDv4String;

    const
      searchParams = { 'contain[secret]': 1 };
    const res = await this.api.get(`resources/${resourceId}.json`, { searchParams }).json<ResourceResponse>();

    return res.body;
  }

  public async getResources(folderId: UUIDv4String): Promise<Array<ApiResource>> {
    const
      searchParams = { 'contain[secret]': 1, 'filter[has-parent]': folderId };
    const res = await this.api.get('resources.json', { searchParams }).json<ResourcesResponse>();

    return res.body;
  }

  public async getFolders(): Promise<Array<ApiFolder>> {
    const res = await this.api.get('folders.json').json<FoldersResponse>();

    return res.body;
  }

  public isResourceV5IndexAndView(resource: any): resource is ResourceV5IndexAndView {
    const { metadata, metadata_key_id: keyId, metadata_key_type: keyType } = resource as ResourceV5IndexAndView;

    return !!(metadata && keyId && keyType);
  }

  public isFolderV5IndexAndView(folder: any): folder is FolderV5IndexAndView {
    const { metadata, metadata_key_id: keyId, metadata_key_type: keyType } = folder as FolderV5IndexAndView;

    return !!(metadata && keyId && keyType);
  }

  public async decodeMetadata(metadata: string, metakey: PrivateKey): Promise<GpgMetadata> {
    return await decodeMessage(metadata, metakey) as GpgMetadata;
  }

  public async decodeSecret(secret: string, privateKey: PrivateKey): Promise<GpgSecret> {
    return await decodeMessage(secret, privateKey) as GpgSecret;
  }
}
