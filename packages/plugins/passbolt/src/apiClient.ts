import type {
    GpgChallengeRequest,
    GpgChallengeResponse,
    GpgMetadata,
    GpgMetadataPrivateKey,
    GpgSecret,
    Resource,
    UUIDv4String
} from './types';
import { ok } from '@oazapfts/runtime';
import { randomUUID } from 'node:crypto';
import { decodeMessage, encodeMessage, getPrivateKey, getPublicKey, PrivateKey } from './openpgp';
import {
    authJwtLogin,
    authJwtLogout,
    authJwtRefresh,
    defaults,
    indexMetadataKeys,
    indexResources,
    viewResource,
    viewAuthVerify,
    indexFolders,
    type ResourceV5IndexAndView,
    type FolderV4IndexAndView,
    type FolderV5IndexAndView
} from './generatedClientFunctions';

export type { SecretIndex, FolderV4IndexAndView, FolderV5IndexAndView } from './generatedClientFunctions';

export class ApiClient
{
    private accessToken?: string;
    private refreshToken?: string;
    private tokenExpiry?: number;

    constructor (serverUrl: string) {
        defaults.baseUrl = serverUrl;
        defaults.headers = { 'Content-Type': 'application/json' };
    }

    public get isAuthorized () {
        return [
            this.accessToken !== undefined,
            this.refreshToken !== undefined,
            this.tokenExpiry !== undefined && Date.now() <= this.tokenExpiry
        ].every(Boolean);
    }

    private createAuthChallenge (duration: number): GpgChallengeRequest {
        return {
            version: '1.0.0',
            domain: defaults.baseUrl,
            verify_token: randomUUID() as UUIDv4String,
            verify_token_expiry: Math.round((Date.now() + duration) / 1000)
        }
    }

    public async login (userId: string, privateKey: PrivateKey, duration: number): Promise<void> {
        try {
            if (!this.isAuthorized) {
                const
                    { body: publicKey } = await ok(viewAuthVerify()),
                    pub = await getPublicKey(publicKey.keydata),
                    authChallenge = this.createAuthChallenge(duration),
                    challenge = await encodeMessage(authChallenge, pub, privateKey),
                    { body: auth } = await ok(authJwtLogin({ user_id: userId, challenge })),
                    challengeResponse = await decodeMessage(auth.challenge, privateKey) as GpgChallengeResponse,
                    { verify_token, access_token, refresh_token } = challengeResponse;

                if (access_token && refresh_token && verify_token === authChallenge.verify_token) {
                    this.accessToken = access_token;
                    this.refreshToken = refresh_token;
                    this.tokenExpiry = authChallenge.verify_token_expiry * 1000;
                }
            } else {
                const { body: auth } = await ok(authJwtRefresh({ user_id: userId, refresh_token: this.refreshToken! }));

                this.accessToken = auth.access_token;
                this.tokenExpiry = Date.now() + duration;
            }
        } catch (err) {
            this.accessToken = undefined;
            this.refreshToken = undefined;
            this.tokenExpiry = undefined;
        } finally {
            if (this.isAuthorized) {
                defaults.headers = { ...defaults.headers, 'Authorization': `Bearer ${ this.accessToken }` };
            }
        }
    }

    public async logout (): Promise<void> {
        try {
            if (this.isAuthorized) {
                await ok(authJwtLogout({ refresh_token: this.refreshToken }));
            }
            this.accessToken = undefined;
            this.refreshToken = undefined;
            this.tokenExpiry = undefined;
        } catch (err) {
            // do nothing
        }
    }

    public async getUserMetadataKeys (userId: string, privateKey: PrivateKey): Promise<Map<string, PrivateKey>> {
        const keyMap = new Map<string, PrivateKey>();

        try {
            const
                { origin } = new URL(defaults.baseUrl),
                keys = await ok(indexMetadataKeys({ filterDeleted: 0, filterExpired: 0, containMetadataPrivateKeys: 1 }));

            keys.body.forEach(({ metadata_private_keys }) => {
                (metadata_private_keys ?? []).forEach(async ({ metadata_key_id, user_id, data }) => {
                    if (user_id === userId) {
                        const { domain, armored_key } = await decodeMessage(data, privateKey) as GpgMetadataPrivateKey;

                        if (domain === origin) {
                            keyMap.set(metadata_key_id, await getPrivateKey(armored_key));
                        }
                    }
                });
            });
            return keyMap;
        } catch (err) {
            return keyMap;
        } finally {
            keyMap.clear();
        }
    }

    public async getResource (resourceId: UUIDv4String): Promise<Resource> {
        const { body } = await ok(viewResource(resourceId, { containSecret: 1 }));

        return body;
    }

    public async getResources (folderId: UUIDv4String): Promise<Resource[]> {
        const { body } = await ok(indexResources({ containSecret: 1, filterHasParent: folderId }));

        return body;
    }

    public isResourceV5IndexAndView (resource: any): resource is ResourceV5IndexAndView {
        const { metadata, metadata_key_id, metadata_key_type } = resource as ResourceV5IndexAndView;

        return metadata !== undefined && metadata_key_id !== undefined && metadata_key_type !== undefined;
    }

    public isFolderV5IndexAndView (folder: any): folder is FolderV5IndexAndView {
        const { metadata, metadata_key_id, metadata_key_type } = folder as FolderV5IndexAndView;

        return !!(metadata && metadata_key_id && metadata_key_type);
    }

    public async decodeMetadata (metadata: string, metakey: PrivateKey): Promise<GpgMetadata> {
        return await decodeMessage(metadata, metakey) as GpgMetadata;
    }

    public async decodeSecret (secret: string, privateKey: PrivateKey): Promise<GpgSecret> {
        return await decodeMessage(secret, privateKey) as GpgSecret;
    }

    public async getFolders (): Promise<(FolderV4IndexAndView | FolderV5IndexAndView)[]> {
        const { body } = await ok(indexFolders());

        return body;
    }
}
