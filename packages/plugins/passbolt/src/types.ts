import type { ResourceV4IndexAndView, ResourceV5IndexAndView } from './generatedClientFunctions';

export type UUIDv4String = `${string}${string}${string}${string}${string}${string}${string}${string}${string
}-${string}${string}${string}${string}${string}-4${string}${string}${string}${string
}-${"8" | "9" | "A" | "B" | "a" | "b"}${string}${string}${string}${string
}-${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}`;

export type ClientOptions = {
    passphrase: string
    privateKey: string
    serverUrl: string
    userId: string
    duration?: number
};

export type Resource = ResourceV4IndexAndView | ResourceV5IndexAndView;
export type Folder = {
    id: string
    name: string
    parent: string | null
};

export type DecodedResource = {
    name: string
    password: string | undefined
    totp: string | undefined
    customFields: Record<string, string> | undefined
};

type CustomField = {
    id: string
    type: string
};

export type CustomFieldKey = CustomField & { metadata_key: string };

export type CustomFieldValue = CustomField & { secret_value: string };

type GpgMessage = {};

export type GpgChallengeRequest = GpgMessage & {
    version: '1.0.0'
    domain: string
    verify_token: UUIDv4String
    verify_token_expiry: number
};

export type GpgMetadataPrivateKey = GpgMessage & {
    object_type: string
    domain: string
    fingerprint: string
    armored_key: string
    passphrase: string
};

export type GpgMetadata = GpgMessage & {
    object_type: string
    resource_type_id: string
    name: string
    username: string
    uris: string[]
    custom_fields?: {
        id: string
        type: string
        metadata_key: string
    }[]
};

export type GpgSecret = GpgMetadata & {
    object_type: string
    password?: string
    totp?: {
        secret_key: string
        period: number
        digits: number
        algorithm: string
    },
    custom_fields?: {
        id: string
        type: string
        secret_value: string
    }[]
};

export type GpgAccountKit = GpgMessage & {
    domain: string
    user_id: UUIDv4String
    username: string
    first_name: string
    last_name: string
    user_private_armored_key: string
    user_public_armored_key: string
    server_public_armored_key: string
    security_token: {
        code: string
        color: string
        textcolor: string
    }
}

export type GpgChallengeResponse = GpgChallengeRequest & { access_token: string, refresh_token: string };
