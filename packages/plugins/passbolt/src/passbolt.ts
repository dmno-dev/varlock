import type {
    ClientOptions,
    CustomFieldKey,
    CustomFieldValue,
    DecodedResource,
    Folder,
    Resource,
    UUIDv4String,
    GpgAccountKit
} from './types';
import { getPrivateKey, PrivateKey, getMessage, getPublicKey } from './openpgp';
import { ApiClient, type SecretIndex, type FolderV4IndexAndView, type FolderV5IndexAndView } from './apiClient';

export type { ClientOptions, UUIDv4String } from './types';

const defaultOptions: Partial<ClientOptions> = {
    duration: 1000 * 60 * 10, // 10minutes
}

export class PassboltClient
{
    private readonly duration: number;
    private readonly options: ClientOptions;
    private readonly apiClient: ApiClient;

    private metadataKeys: Map<string, PrivateKey>;
    private initialized: boolean;
    private privateKey: PrivateKey | undefined;

    constructor (options: ClientOptions) {
        this.options = { ...defaultOptions, ...options };

        this.metadataKeys = new Map<string, PrivateKey>();
        this.duration = this.options.duration!;
        this.initialized = false;
        this.privateKey = undefined;
        this.apiClient = new ApiClient(this.options.serverUrl);
    }

    public get isInitialized () {
        return this.initialized && this.apiClient.isAuthorized;
    }

    public static async instantiateWithAccountKit (accountKit: string, passphrase: string, duration?: number): Promise<PassboltClient> {
        try {
            const
                message = await getMessage(accountKit),
                data = JSON.parse(message.getText());

            if (PassboltClient.isAccountKit(data)) {
                const
                    privateKey = data.user_private_armored_key,
                    userId = data.user_id,
                    serverUrl = data.domain,
                    publicKey = await getPublicKey(data.user_public_armored_key),
                    verifyResult = await message.verify([ publicKey ]);

                duration ??= defaultOptions.duration;

                if (await verifyResult[0].verified) {
                    return new PassboltClient({ passphrase, privateKey, serverUrl, userId, duration });
                }
            }
        } catch (err) {
            // do nothing
        }
        return new PassboltClient({} as ClientOptions);
    }

    public static isAccountKit (data: any): data is GpgAccountKit {
        const {
            user_id,
            domain,
            user_public_armored_key,
            user_private_armored_key,
            server_public_armored_key
        } = data as GpgAccountKit;

        return [
            user_id,
            domain,
            user_public_armored_key,
            user_private_armored_key,
            server_public_armored_key
        ].every(value => value !== undefined);
    }


    private parseCustomFields (customKeys?: CustomFieldKey[], customValues?: CustomFieldValue[]) {
        if (!customKeys || !customValues) {
            return;
        }

        const
            keys = customKeys.reduce<Record<string, string>>((p, c) => (p[c.id] = c.metadata_key, p), { }),
            values = customValues.reduce<Record<string, string>>((p, c) => (p[c.id] = c.secret_value, p), { });

        return customKeys.reduce<Record<string, string>>((p, c) => (p[keys[c.id]] = values[c.id], p), {});
    }

    private async decodeResource (resource: Resource): Promise<DecodedResource | void> {
        const
            [ secret ] = resource.secrets as unknown as SecretIndex[],
            decSecret = await this.apiClient.decodeSecret(secret.data, this.privateKey!),
            password = decSecret?.password,
            totp = decSecret?.totp?.secret_key;

        if (!this.apiClient.isResourceV5IndexAndView(resource)) {
            return { name: resource.name, totp, password, customFields: undefined };
        }

        const
            { metadata, metadata_key_id } =  resource,
            metakey = this.metadataKeys.get(metadata_key_id);

        if (metakey) {
            const
                decodedMetadata = await this.apiClient.decodeMetadata(metadata, metakey),
                customFields = this.parseCustomFields(decodedMetadata.custom_fields, decSecret.custom_fields);

            return { name: decodedMetadata.name, totp, password, customFields };
        }
    }

    private async convertToFolder (folder: FolderV4IndexAndView | FolderV5IndexAndView): Promise<Folder | void> {
        if (!this.apiClient.isFolderV5IndexAndView(folder)) {
            return { id: folder.id, name: folder.name, parent: folder.folder_parent_id };
        }

        const
            { metadata, metadata_key_id } = folder,
            metakey = this.metadataKeys.get(metadata_key_id);

        if (metakey) {
            const decodedMetadata = await this.apiClient.decodeMetadata(metadata, metakey);

            return { id: folder.id, name: decodedMetadata.name, parent: folder.folder_parent_id };
        }
    }

    public async init () {
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

    public async getResource (resourceId: UUIDv4String): Promise<DecodedResource | void> {
        !this.isInitialized && await this.init();

        try {
            const resource = await this.apiClient.getResource(resourceId);

            return await this.decodeResource(resource);
        } catch (err) {
            return;
        } finally {
            this.apiClient.logout().catch(() => {});
        }
    }

    public async getResources (folderId: UUIDv4String): Promise<DecodedResource[]> {
        !this.isInitialized && await this.init();

        try {
            const
                resources = await this.apiClient.getResources(folderId),
                decodedResources = await Promise.all(resources.map(this.decodeResource.bind(this)));

            return decodedResources.filter(res => res !== undefined) as DecodedResource[];
        } catch (err) {
            return [];
        } finally {
            this.apiClient.logout().catch(() => {});
        }
    }

    public async findFolder (search: string, folders?: Folder[], parent: string | null = null): Promise<UUIDv4String | void> {
        !this.isInitialized && await this.init();

        try {
            if (!folders) {
                const
                    rawFolders = await this.apiClient.getFolders(),
                    decoded = await Promise.all(rawFolders.map(this.convertToFolder.bind(this)));

                folders = decoded.filter(item => item !== undefined) as Folder[];
            }

            if (!folders) {
                return;
            }

            const
                parts = search.split(/(?<!\\)\//).map(e => e.replaceAll(/\\\//g, '/')),
                part = parts.shift(),
                found = folders.find(folder => folder.name === part && folder.parent === parent);

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
            this.apiClient.logout().catch(() => {});
        }
    }
}
