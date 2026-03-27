/**
 * Passbolt API
 * 5.0.0
 * DO NOT MODIFY - This file has been generated using oazapfts.
 * See https://www.npmjs.com/package/oazapfts
 */
import * as Oazapfts from "@oazapfts/runtime";
import * as QS from "@oazapfts/runtime/query";
export const defaults: Oazapfts.Defaults<Oazapfts.CustomHeaders> = {
    headers: {},
    baseUrl: "https://passbolt.local"
};
const oazapfts = Oazapfts.runtime(defaults);
export const servers = {
    apiPassbolt: "https://passbolt.local"
};
export type Header = {
    id: string;
    status: "success" | "error";
    servertime: number;
    action: string;
    message: string;
    url: string;
    code: number;
};
export type Jwk = {
    kty: string;
    alg: string;
    use: string;
    e: string;
    n: string;
};
export type LoginRequest = {
    user_id: string;
    /** `gpg_encrypt(gpg_sign(challenge_message, user_key), server_key)` */
    challenge: string;
};
export type LoginResponse = {
    challenge: string;
};
export type Logout = {
    refresh_token?: string;
};
export type RefreshRequest = {
    refresh_token: string;
    user_id: string;
};
export type RefreshResponse = {
    access_token: string;
};
export type Rsa = {
    keydata: string;
};
export type Login = {
    data: {
        gpg_auth: {
            keyid: string;
            /** Used for server key verification. */
            server_verify_token?: string;
            /** Used for client key verification. */
            user_token_result?: string;
        };
    };
};
export type Verify = {
    fingerprint: string;
    keydata: string;
};
export type CommentUpdate = {
    content: string;
};
export type GroupsUsersIndexAndView = {
    id: string;
    group_id: string;
    user_id: string;
    is_admin: boolean;
    created: string;
    user?: UserIndexAndView;
};
export type Gpgkey = {
    id: string;
    user_id: string;
    armored_key: string;
    bits: number;
    uid: string;
    key_id: string;
    fingerprint: string;
    "type": "RSA" | "ECC";
    expires: string;
    deleted: boolean;
    created: string;
    modified: string;
};
export type Role = {
    id: string;
    name: "admin" | "guest" | "user";
    description: string;
    created: string;
    modified: string;
};
export type UserIndexAndView = {
    is_mfa_enabled?: boolean;
    id: string;
    role_id: string;
    username: string;
    active: boolean;
    deleted: boolean;
    created: string;
    modified: string;
    disabled: string;
    profile?: {
        id: string;
        user_id: string;
        first_name: string;
        last_name: string;
        created: string;
        modified: string;
        avatar: {
            id?: string;
            profile_id?: string;
            created?: string;
            modified?: string;
            url: {
                medium: string;
                small: string;
            };
        };
    };
    groups_users?: GroupsUsersIndexAndView;
    gpgkey?: Gpgkey;
    role?: Role;
    missing_metadata_key_ids?: string[];
    last_logged_in?: string;
};
export type CommentView = {
    id: string;
    parent_id: string;
    foreign_key: string;
    foreign_model: "Resource";
    content: string;
    created: string;
    modified: string;
    created_by: string;
    modified_by: string;
    user_id: string;
    children?: CommentView[];
    modifier?: UserIndexAndView;
    creator?: UserIndexAndView;
};
export type CommentAdd = CommentUpdate & {
    parent_id?: string;
};
export type SynchronizeAndSimulate = {
    users: {
        message?: string;
        model?: string;
        data?: {
            username?: string;
            profile?: {
                first_name?: string;
                last_name?: string;
                user_id?: string;
                created?: string;
                modified?: string;
                id?: string;
            };
            role_id?: string;
            deleted?: boolean;
            created?: string;
            modified?: string;
            id?: string;
            last_logged_in?: string;
        };
        action?: string;
        status?: string;
        created?: string;
        version?: string;
    }[];
};
export type Favorite = {
    id: string;
    user_id: string;
    foreign_key: string;
    foreign_model: "Resource";
    created: string;
    modified: string;
};
export type HeaderWithPagination = {
    id: string;
    status: "success" | "error";
    servertime: number;
    action: string;
    message: string;
    url: string;
    code: number;
    pagination: {
        count: number;
        page: number;
        limit: number;
    };
};
export type PermissionLevel = 1 | 7 | 15;
export type GroupIndexAndView = {
    id: string;
    name: string;
    deleted: boolean;
    created: string;
    modified: string;
    created_by: string;
    modified_by: string;
    my_group_user?: GroupsUsersIndexAndView;
    groups_users?: GroupsUsersIndexAndView[];
    user_count?: number;
};
export type PermissionIndexAndView = {
    id: string;
    aco: "Resource" | "Folder";
    aco_foreign_key: string;
    aro: "User" | "Group";
    aro_foreign_key: string;
    "type": PermissionLevel;
    created: string;
    modified: string;
    user?: UserIndexAndView;
    group?: GroupIndexAndView;
};
export type SecretIndex = {
    id: string;
    user_id: string;
    resource_id: string;
    data: string;
    created: string;
    modified: string;
};
export type ResourceType = {
    id: string;
    /** * `password-string` - The original passbolt resource type, where the secret is a non empty string.
    * `password-and-description` - A resource with the password and the description encrypted.
    * `totp` - A resource with standalone TOTP fields.
    * `password-description-totp` - A resource with encrypted password, description and TOTP fields.
    * `v5-default-with-totp` - The new default resource type with a TOTP introduced with v5.
    * `v5-password-string (Deprecated)` - The original passbolt resource type, kept for backward compatibility reasons.
    * `v5-totp-standalone` - The new standalone TOTP resource type introduced with v5.
    * `v5-default` - The new default resource type introduced with v5.
     */
    slug: "password-string" | "password-and-description" | "totp" | "password-description-totp" | "v5-default-with-totp" | "v5-password-string (Deprecated)" | "v5-totp-standalone" | "v5-default";
    name: string;
    description: string;
    /** Schema for the expected data for this kind of resources. */
    definition: object;
    deleted: string;
    created: string;
    modified: string;
};
export type ResourceV4IndexAndView = {
    id: string;
    name: string;
    username: string;
    uri: string;
    description: string;
    deleted: boolean;
    created: string;
    created_by: string;
    modified_by: string;
    resource_type_id: string;
    expired: string;
    folder_parent_id: string;
    personal: boolean;
    favorite?: Favorite;
    modifier?: UserIndexAndView;
    creator?: UserIndexAndView;
    secrets?: SecretIndex[];
    resource_type?: ResourceType;
    permission?: PermissionIndexAndView;
    permissions?: PermissionIndexAndView[];
};
export type E2EeMetadataBased = {
    metadata: string;
    metadata_key_id: string;
    metadata_key_type: "user_key" | "shared_key";
};
export type E2EeMetadataBasedId = E2EeMetadataBased & {
    id: string;
};
export type E2EeMetadataBasedCommon = E2EeMetadataBasedId & {
    created: string;
    modified: string;
    created_by: string;
    modified_by: string;
    personal: boolean;
    folder_parent_id: string;
    modifier?: UserIndexAndView;
    creator?: UserIndexAndView;
    permission?: PermissionIndexAndView;
    permissions?: PermissionIndexAndView[];
};
export type ResourceV5IndexAndView = E2EeMetadataBasedCommon & {
    resource_type_id: string;
    expired: string;
    favorite?: Favorite;
    secrets?: string[];
    resource_type?: ResourceType;
};
export type FolderV5IndexAndView = E2EeMetadataBasedCommon & {
    children_resources?: (ResourceV4IndexAndView | ResourceV5IndexAndView)[];
    children_folders?: (FolderV4IndexAndView | FolderV5IndexAndView)[];
};
export type FolderV4IndexAndView = {
    id: string;
    name: string;
    created: string;
    modified: string;
    created_by: string;
    modified_by: string;
    folder_parent_id: string;
    personal: boolean;
    modifier?: UserIndexAndView;
    creator?: UserIndexAndView;
    permission?: PermissionIndexAndView;
    permissions?: PermissionIndexAndView[];
    children_resources?: (ResourceV4IndexAndView | ResourceV5IndexAndView)[];
    children_folders?: (FolderV4IndexAndView | FolderV5IndexAndView)[];
};
export type GroupAdd = {
    name: string;
    groups_users: {
        user_id: string;
        is_admin: boolean;
    }[];
};
export type GroupUpdate = {
    name: string;
    groups_users: {
        /** GroupUser relationship ID (required for updating existing users or marking for deletion) */
        id?: string;
        /** User ID (required for adding new users to the group) */
        user_id?: string;
        /** Whether the user is a group administrator */
        is_admin?: boolean;
        /** Whether to remove the user from the group */
        "delete"?: boolean;
    }[];
    secrets?: {
        resource_id: string;
        user_id: string;
        data: string;
    }[];
};
export type GroupUpdateDryRun = {
    "dry-run": {
        SecretsNeeded: {
            Secret: {
                resource_id: string;
                user_id: string;
            };
        }[];
        Secrets: {
            Secret: {
                id: string;
                resource_id: string;
                user_id: string;
                data: string;
            };
        }[];
    };
};
export type GroupDeleteDryRunError = {
    resources?: {
        sole_owner?: (ResourceV4IndexAndView | ResourceV5IndexAndView)[];
    };
    folders?: {
        sole_owner?: (FolderV4IndexAndView | FolderV5IndexAndView)[];
    };
};
export type Healthcheck = {
    environment: {
        gnupg: boolean;
        info: {
            phpVersion: string;
        };
        phpVersion: boolean;
        nextMinPhpVersion: boolean;
        pcre: boolean;
        mbstring: boolean;
        intl: boolean;
        image: boolean;
        tmpWritable: boolean;
        logWritable: boolean;
    };
    configFile: {
        app: boolean;
        passbolt: boolean;
    };
    core: {
        cache: boolean;
        debugDisabled: boolean;
        salt: boolean;
        info: {
            fullBaseUrl: string;
        };
        fullBaseUrl: boolean;
        validFullBaseUrl: boolean;
        fullBaseUrlReachable: boolean;
    };
    ssl: {
        info: string;
        peerValid: boolean;
        hostValid: boolean;
        notSelfSigned: boolean;
    };
    smtpSettings: {
        isEnabled: boolean;
        errorMessage: boolean;
        source: string;
        isInDb: boolean;
        areEndpointsDisabled: boolean;
        customSslOptions: boolean;
    };
    gpg: {
        lib: boolean;
        gpgHome: boolean;
        gpgHomeWritable: boolean;
        gpgKeyPublicBlock: boolean;
        gpgKeyPrivateBlock: boolean;
        gpgKeyPublicReadable: boolean;
        gpgKeyPrivateReadable: boolean;
        gpgKeyPrivateFingerprint: boolean;
        gpgKeyPublic: boolean;
        gpgKeyPrivate: boolean;
        gpgKey: boolean;
        info: {
            gpgKeyPrivate: string;
            gpgHome: string;
        };
        gpgKeyPublicFingerprint: boolean;
        gpgKeyPublicInKeyring: boolean;
        gpgKeyPublicEmail: boolean;
        canEncrypt: boolean;
        canSign: boolean;
        canEncryptSign: boolean;
        canDecrypt: boolean;
        canDecryptVerify: boolean;
        canVerify: boolean;
        isPublicServerKeyGopengpgCompatible: boolean;
        isPrivateServerKeyGopengpgCompatible: boolean;
    };
    application: {
        configPath: string;
        info: {
            remoteVersion: string;
            currentVersion: string;
        };
        latestVersion: boolean;
        sslForce: boolean;
        sslFullBaseUrl: boolean;
        seleniumDisabled: boolean;
        robotsIndexDisabled: boolean;
        registrationClosed: {
            isSelfRegistrationPluginEnabled: boolean;
            selfRegistrationProvider: string;
            isRegistrationPublicRemovedFromPassbolt: boolean;
        };
        hostAvailabilityCheckEnabled: boolean;
        jsProd: boolean;
        emailNotificationEnabled: boolean;
        schema: boolean;
    };
    database: {
        supportedBackend: boolean;
        connect: boolean;
        info: {
            tablesCount: number;
        };
        tablesCount: boolean;
        defaultContent: boolean;
    };
};
export type MetadataKeyUpdate = {
    fingerprint: string;
    armored_key: string;
    expired: string;
};
export type E2EeDataOnly = {
    data: string;
};
export type E2EeDataUserId = E2EeDataOnly & {
    user_id: string;
};
export type E2EeIdCreatedDataModifiedUserId = E2EeDataUserId & {
    id: string;
    created: string;
    modified: string;
};
export type MetadataPrivateKeysShortIndex = E2EeDataUserId & {
    created_by: string;
    modified_by: string;
    user_id?: any;
};
export type MetadataPrivateKeysIndexAndView = MetadataPrivateKeysShortIndex & {
    id: string;
    metadata_key_id: string;
    created: string;
    modified: string;
};
export type MetadataKeysIndexAndView = MetadataKeyUpdate & E2EeIdCreatedDataModifiedUserId & {
    user_id?: any;
    deleted: string;
    created_by: string;
    modified_by: string;
    metadata_private_keys?: MetadataPrivateKeysIndexAndView[];
};
export type MetadataKeyAdd = {
    armored_key: string;
    fingerprint: string;
    metadata_private_keys: E2EeDataUserId[];
};
export type E2EeDataUserIdMetadataKeyId = E2EeDataUserId & {
    metadata_key_id: string;
};
export type MetadataPrivateKeysAdd = (E2EeDataUserIdMetadataKeyId & {
    user_id?: any;
})[];
export type MetadataKeysSettingsIndex = {
    allow_usage_of_personal_keys: boolean;
    zero_knowledge_key_share: boolean;
};
export type MetadataKeysSettingsUpdate = MetadataKeysSettingsIndex & {
    metadata_private_keys?: E2EeDataUserIdMetadataKeyId[];
};
export type MetadataTypesSettingsIndexAndView = {
    default_resource_types: "v4" | "v5";
    default_folder_type: "v4" | "v5";
    default_tag_type: "v4" | "v5";
    default_comment_type: "v4" | "v5";
    allow_creation_of_v5_resources: boolean;
    allow_creation_of_v5_folders: boolean;
    allow_creation_of_v5_tags: boolean;
    allow_creation_of_v5_comments: boolean;
    allow_creation_of_v4_resources: boolean;
    allow_creation_of_v4_folders: boolean;
    allow_creation_of_v4_tags: boolean;
    allow_creation_of_v4_comments: boolean;
    allow_v5_v4_downgrade: boolean;
    allow_v4_v5_upgrade: boolean;
};
export type E2EeMetadataBasedIdModifiedModifiedBy = E2EeMetadataBasedId & {
    modified: string;
    modified_by: string;
};
export type ResourceMetadataRotateKey = E2EeMetadataBasedCommon & {
    resource_type_id: string;
};
export type Error = {
    mfa_providers: ("totp" | "yubikey")[];
};
export type MetadataSessionKeyIndexAndView = E2EeIdCreatedDataModifiedUserId & {
    user_id?: any;
};
export type E2EeDataModified = E2EeDataOnly & {
    modified: string;
};
export type TagV5MetadataRotateKey = E2EeMetadataBased & {
    id: string;
};
export type TagLegacy = {
    id: string;
    user_id?: string;
    slug: string;
    is_shared: boolean;
};
export type TagV5 = E2EeMetadataBasedId & {
    is_shared: boolean;
};
export type MfaAttempt = {
    /** One-time code for TOTP-based MFA. */
    totp: string;
    remember?: 0 | 1;
} | {
    /** One-time code for Yubikey-based MFA. */
    hotp: string;
    remember?: 0 | 1;
};
export type InvalidOtp = {
    totp: {
        numeric?: string;
        minLength?: string;
        isValidOtp?: string;
    };
} | {
    hotp: {
        isValidModhex?: string;
        isValidHotp?: string;
    };
};
export type Move = {
    folder_parent_id: string;
};
export type ResourceAddAndUpdate = E2EeMetadataBased & {
    expired: string;
    folder_parent_id: string;
    resource_type_id: string;
    secrets: string[];
};
export type ResourceTypeIndex = ResourceType & {
    "default": boolean;
    resources_count?: number;
};
export type ResourceTypeUpdate = {
    deleted?: boolean;
};
export type Index = {
    app: {
        url?: string;
        locale?: string;
    };
    passbolt: {
        legal?: {
            privacy_policy?: {
                url?: string;
            };
            terms?: {
                url?: string;
            };
        };
        edition?: string;
        plugins?: {
            jwtAuthentication?: {
                enabled?: boolean;
            };
            accountRecoveryRequestHelp?: {
                enabled?: boolean;
            };
            accountRecovery?: {
                enabled?: boolean;
            };
            selfRegistration?: {
                enabled?: boolean;
            };
            sso?: {
                enabled?: boolean;
            };
            mfaPolicies?: {
                enabled?: boolean;
            };
            ssoRecover?: {
                enabled?: boolean;
            };
            userPassphrasePolicies?: {
                enabled?: boolean;
            };
            inFormIntegration?: {
                enabled?: boolean;
            };
            metadata?: {
                version?: string;
                enabled?: boolean;
            };
            locale?: {
                options?: {
                    locale?: string;
                    label?: string;
                }[];
            };
            rememberMe?: {
                options?: {
                    "300"?: string;
                    "900"?: string;
                    "1800"?: string;
                    "3600"?: string;
                    "-1"?: string;
                };
            };
        };
    };
};
export type PermissionUpdate = {
    id?: string;
    aro?: "User" | "Group";
    aro_foreign_key?: string;
    "type"?: PermissionLevel;
    "delete"?: boolean;
    is_new?: boolean;
};
export type SecretAdd = {
    user_id?: string;
    data: string;
    resource_id?: string;
};
export type ShareUpdate = {
    permissions?: PermissionUpdate[];
    /** Not required on simulation. */
    secrets?: SecretAdd[];
};
export type ShareUpdateError = {
    permissions?: {
        aco_forein_key?: {
            permission_unique?: string;
            aco_exists?: string;
            _existsIn?: string;
        };
        aro_forein_key?: {
            aro_exists?: string;
            _existsIn?: string;
        };
    }[];
};
export type ShareAros = UserIndexAndView | GroupIndexAndView;
export type ShareUpdateDryRun = {
    added: {
        User?: {
            id?: string;
        };
    }[];
    removed: {
        User?: {
            id?: string;
        };
    }[];
};
export type TagIndexAndView = TagLegacy | TagV5;
export type TagV5Update = E2EeMetadataBased & {
    is_shared: boolean;
};
export type TagAddResource = {
    id: string;
} | TagV5Update | string;
export type UserAdd = {
    username: string;
    role_id?: string;
    profile: {
        first_name: string;
        last_name: string;
    };
};
export type UserUpdate = {
    role_id?: string;
    disabled?: boolean;
    profile?: {
        first_name?: string;
        last_name?: string;
        avatar?: {
            /** Image file in binary format. */
            file: string;
        };
    };
};
export type UserDelete = {
    errors?: {
        resources?: {
            sole_owner?: (ResourceV4IndexAndView | ResourceV5IndexAndView)[];
        };
    };
};
export type UserDeleteDryRun = {
    errors?: {
        groups?: {
            sole_manager?: GroupIndexAndView[];
        };
        folders?: {
            sole_owner?: FolderV5IndexAndView[];
        };
        resources?: {
            sole_owner?: (ResourceV4IndexAndView | ResourceV5IndexAndView)[];
        };
        groups_to_delete?: GroupIndexAndView[];
    };
};
/**
 * Check authentication status.
 */
export function viewAuthIsAuthenticated(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>("/auth/is-authenticated.json", {
        ...opts
    });
}
/**
 * Get the JWKs server information.
 */
export function viewAuthJwtJwks(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            keys: Jwk[];
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>("/auth/jwt/jwks.json", {
        ...opts
    });
}
/**
 * Login.
 */
export function authJwtLogin(loginRequest: LoginRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: LoginResponse;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    }>("/auth/jwt/login.json", oazapfts.json({
        ...opts,
        method: "POST",
        body: loginRequest
    }));
}
/**
 * Logout.
 */
export function authJwtLogout(logout: Logout, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>("/auth/jwt/logout.json", oazapfts.json({
        ...opts,
        method: "POST",
        body: logout
    }));
}
/**
 * Refresh access token.
 */
export function authJwtRefresh(refreshRequest: RefreshRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: RefreshResponse;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    }>("/auth/jwt/refresh.json", oazapfts.json({
        ...opts,
        method: "POST",
        body: refreshRequest
    }));
}
/**
 * Get the JWT RSA server information.
 */
export function viewAuthJwtRsa(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: Rsa;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>("/auth/jwt/rsa.json", {
        ...opts
    });
}
/**
 * Log in.
 */
export function authLogin(login: Login, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    }>("/auth/login.json", oazapfts.json({
        ...opts,
        method: "POST",
        body: login
    }));
}
/**
 * Log out.
 */
export function authLogout(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    }>("/auth/logout.json", {
        ...opts,
        method: "POST"
    });
}
/**
 * Get the server's public PGP key.
 */
export function viewAuthVerify(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: Verify;
        };
    }>("/auth/verify.json", {
        ...opts
    });
}
/**
 * Verify the server's identity.
 */
export function checkAuthVerify(login: Login, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    }>("/auth/verify.json", oazapfts.json({
        ...opts,
        method: "POST",
        body: login
    }));
}
/**
 * Get an avatar as an image.
 */
export function viewAvatar(avatarId: string, avatarFormat: "medium.jpg" | "small.jpg", opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/avatars/view/${encodeURIComponent(avatarId)}/${encodeURIComponent(avatarFormat)}`, {
        ...opts
    });
}
/**
 * Update a comment.
 */
export function updateComment(commentId: string, commentUpdate: CommentUpdate, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: CommentView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/comments/${encodeURIComponent(commentId)}.json`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: commentUpdate
    }));
}
/**
 * Delete a comment.
 */
export function deleteComment(commentId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/comments/${encodeURIComponent(commentId)}.json`, {
        ...opts,
        method: "DELETE"
    });
}
/**
 * Get comments for a resource.
 */
export function indexComments(resourceId: string, { containCreator, containModifier }: {
    containCreator?: 1 | 0;
    containModifier?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: CommentView[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/comments/resource/${encodeURIComponent(resourceId)}.json${QS.query(QS.explode({
        "contain[creator]": containCreator,
        "contain[modifier]": containModifier
    }))}`, {
        ...opts
    });
}
/**
 * Add a comment.
 */
export function addComment(resourceId: string, commentAdd: CommentAdd, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: CommentView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/comments/resource/${encodeURIComponent(resourceId)}.json`, oazapfts.json({
        ...opts,
        method: "POST",
        body: commentAdd
    }));
}
/**
 * Simulate directory synchronization without making changes.
 */
export function simulateSync(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: SynchronizeAndSimulate;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>("/directorysync/synchronize/dry-run.json", {
        ...opts
    });
}
/**
 * Run the directory synchronization.
 */
export function runSync(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: SynchronizeAndSimulate;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>("/directorysync/synchronize.json", {
        ...opts,
        method: "POST"
    });
}
/**
 * Unset a resource as favorite.
 */
export function deleteFavorite(favoriteId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/favorite/${encodeURIComponent(favoriteId)}.json`, {
        ...opts,
        method: "DELETE"
    });
}
/**
 * Set a resource as favorite.
 */
export function addFavorite(foreignModel: "resource", foreignId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: Favorite;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/favorite/${encodeURIComponent(foreignModel)}/${encodeURIComponent(foreignId)}.json`, {
        ...opts,
        method: "POST"
    });
}
/**
 * Get multiple folders.
 */
export function indexFolders({ containChildrenResources, containChildrenFolders, containCreator, containCreatorProfile, containModifier, containModifierProfile, containPermission, containPermissions, containPermissionsUserProfile, containPermissionsGroup, filterHasId, filterHasParent, filterSearch }: {
    containChildrenResources?: 1 | 0;
    containChildrenFolders?: 1 | 0;
    containCreator?: 1 | 0;
    containCreatorProfile?: 1 | 0;
    containModifier?: 1 | 0;
    containModifierProfile?: 1 | 0;
    containPermission?: 1 | 0;
    containPermissions?: 1 | 0;
    containPermissionsUserProfile?: 1 | 0;
    containPermissionsGroup?: 1 | 0;
    filterHasId?: string;
    filterHasParent?: string;
    filterSearch?: string;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: (FolderV4IndexAndView | FolderV5IndexAndView)[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>(`/folders.json${QS.query(QS.explode({
        "contain[children_resources]": containChildrenResources,
        "contain[children_folders]": containChildrenFolders,
        "contain[creator]": containCreator,
        "contain[creator.profile]": containCreatorProfile,
        "contain[modifier]": containModifier,
        "contain[modifier.profile]": containModifierProfile,
        "contain[permission]": containPermission,
        "contain[permissions]": containPermissions,
        "contain[permissions.user.profile]": containPermissionsUserProfile,
        "contain[permissions.group]": containPermissionsGroup,
        "filter[has-id]": filterHasId,
        "filter[has-parent]": filterHasParent,
        "filter[search]": filterSearch
    }))}`, {
        ...opts
    });
}
/**
 * Create a folder.
 */
export function addFolder(e2EeMetadataBased: E2EeMetadataBased, { containChildrenResources, containChildrenFolders, containCreator, containModifier, containPermission, containPermissions, containPermissionsUserProfile, containPermissionsGroup }: {
    containChildrenResources?: 1 | 0;
    containChildrenFolders?: 1 | 0;
    containCreator?: 1 | 0;
    containModifier?: 1 | 0;
    containPermission?: 1 | 0;
    containPermissions?: 1 | 0;
    containPermissionsUserProfile?: 1 | 0;
    containPermissionsGroup?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: FolderV5IndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>(`/folders.json${QS.query(QS.explode({
        "contain[children_resources]": containChildrenResources,
        "contain[children_folders]": containChildrenFolders,
        "contain[creator]": containCreator,
        "contain[modifier]": containModifier,
        "contain[permission]": containPermission,
        "contain[permissions]": containPermissions,
        "contain[permissions.user.profile]": containPermissionsUserProfile,
        "contain[permissions.group]": containPermissionsGroup
    }))}`, oazapfts.json({
        ...opts,
        method: "POST",
        body: e2EeMetadataBased
    }));
}
/**
 * Get a folder.
 */
export function viewFolder(folderId: string, { containChildrenResources, containChildrenFolders, containCreator, containCreatorProfile, containModifier, containModifierProfile, containPermission, containPermissions, containPermissionsUserProfile, containPermissionsGroup, filterHasId }: {
    containChildrenResources?: 1 | 0;
    containChildrenFolders?: 1 | 0;
    containCreator?: 1 | 0;
    containCreatorProfile?: 1 | 0;
    containModifier?: 1 | 0;
    containModifierProfile?: 1 | 0;
    containPermission?: 1 | 0;
    containPermissions?: 1 | 0;
    containPermissionsUserProfile?: 1 | 0;
    containPermissionsGroup?: 1 | 0;
    filterHasId?: string;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: FolderV4IndexAndView | FolderV5IndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/folders/${encodeURIComponent(folderId)}.json${QS.query(QS.explode({
        "contain[children_resources]": containChildrenResources,
        "contain[children_folders]": containChildrenFolders,
        "contain[creator]": containCreator,
        "contain[creator.profile]": containCreatorProfile,
        "contain[modifier]": containModifier,
        "contain[modifier.profile]": containModifierProfile,
        "contain[permission]": containPermission,
        "contain[permissions]": containPermissions,
        "contain[permissions.user.profile]": containPermissionsUserProfile,
        "contain[permissions.group]": containPermissionsGroup,
        "filter[has-id]": filterHasId
    }))}`, {
        ...opts
    });
}
/**
 * Update a folder.
 */
export function updateFolder(folderId: string, e2EeMetadataBased: E2EeMetadataBased, { containChildrenResources, containChildrenFolders, containCreator, containModifier, containPermission, containPermissions, containPermissionsUserProfile, containPermissionsGroup }: {
    containChildrenResources?: 1 | 0;
    containChildrenFolders?: 1 | 0;
    containCreator?: 1 | 0;
    containModifier?: 1 | 0;
    containPermission?: 1 | 0;
    containPermissions?: 1 | 0;
    containPermissionsUserProfile?: 1 | 0;
    containPermissionsGroup?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: FolderV5IndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/folders/${encodeURIComponent(folderId)}.json${QS.query(QS.explode({
        "contain[children_resources]": containChildrenResources,
        "contain[children_folders]": containChildrenFolders,
        "contain[creator]": containCreator,
        "contain[modifier]": containModifier,
        "contain[permission]": containPermission,
        "contain[permissions]": containPermissions,
        "contain[permissions.user.profile]": containPermissionsUserProfile,
        "contain[permissions.group]": containPermissionsGroup
    }))}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: e2EeMetadataBased
    }));
}
/**
 * Delete a folder.
 */
export function deleteFolder(folderId: string, { cascade }: {
    cascade?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/folders/${encodeURIComponent(folderId)}.json${QS.query(QS.explode({
        cascade
    }))}`, {
        ...opts,
        method: "DELETE"
    });
}
/**
 * Get multiple GPG keys.
 */
export function indexGpgkeys({ filterModifiedAfter, filterIsDeleted }: {
    filterModifiedAfter?: string;
    filterIsDeleted?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: Gpgkey[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>(`/gpgkeys.json${QS.query(QS.explode({
        "filter[modified-after]": filterModifiedAfter,
        "filter[is-deleted]": filterIsDeleted
    }))}`, {
        ...opts
    });
}
/**
 * Get a GPG key.
 */
export function viewGpgkey(gpgkeyId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: Gpgkey;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/gpgkeys/${encodeURIComponent(gpgkeyId)}.json`, {
        ...opts
    });
}
/**
 * Get multiple groups.
 */
export function indexGroups({ containModifier, containModifierProfile, containMyGroupUser, containGroupsUsers, containGroupsUsersUser, containGroupsUsersUserProfile, containGroupsUsersUserGpgkey, filterHasUsers, filterHasManagers }: {
    containModifier?: 1 | 0;
    containModifierProfile?: 1 | 0;
    containMyGroupUser?: 1 | 0;
    containGroupsUsers?: 1 | 0;
    containGroupsUsersUser?: 1 | 0;
    containGroupsUsersUserProfile?: 1 | 0;
    containGroupsUsersUserGpgkey?: 1 | 0;
    filterHasUsers?: string[];
    filterHasManagers?: string[];
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: GroupIndexAndView[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>(`/groups.json${QS.query(QS.explode({
        "contain[modifier]": containModifier,
        "contain[modifier.profile]": containModifierProfile,
        "contain[my_group_user]": containMyGroupUser,
        "contain[groups_users]": containGroupsUsers,
        "contain[groups_users.user]": containGroupsUsersUser,
        "contain[groups_users.user.profile]": containGroupsUsersUserProfile,
        "contain[groups_users.user.gpgkey]": containGroupsUsersUserGpgkey,
        "filter[has-users]": filterHasUsers,
        "filter[has-managers]": filterHasManagers
    }))}`, {
        ...opts
    });
}
/**
 * Create a group.
 */
export function addGroup(groupAdd: GroupAdd, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: GroupIndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>("/groups.json", oazapfts.json({
        ...opts,
        method: "POST",
        body: groupAdd
    }));
}
/**
 * Get a group.
 */
export function viewGroup(groupId: string, { containModifier, containModifierProfile, containUsers, containMyGroupUser, containGroupsUsers, containGroupsUsersUser, containGroupsUsersUserProfile, containGroupsUsersUserGpgkey }: {
    containModifier?: 1 | 0;
    containModifierProfile?: 1 | 0;
    containUsers?: 1 | 0;
    containMyGroupUser?: 1 | 0;
    containGroupsUsers?: 1 | 0;
    containGroupsUsersUser?: 1 | 0;
    containGroupsUsersUserProfile?: 1 | 0;
    containGroupsUsersUserGpgkey?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: GroupIndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/groups/${encodeURIComponent(groupId)}.json${QS.query(QS.explode({
        "contain[modifier]": containModifier,
        "contain[modifier.profile]": containModifierProfile,
        "contain[users]": containUsers,
        "contain[my_group_user]": containMyGroupUser,
        "contain[groups_users]": containGroupsUsers,
        "contain[groups_users.user]": containGroupsUsersUser,
        "contain[groups_users.user.profile]": containGroupsUsersUserProfile,
        "contain[groups_users.user.gpgkey]": containGroupsUsersUserGpgkey
    }))}`, {
        ...opts
    });
}
/**
 * Update a group.
 */
export function updateGroup(groupId: string, groupUpdate: GroupUpdate, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: GroupIndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/groups/${encodeURIComponent(groupId)}.json`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: groupUpdate
    }));
}
/**
 * Delete a group.
 */
export function deleteGroup(groupId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/groups/${encodeURIComponent(groupId)}.json`, {
        ...opts,
        method: "DELETE"
    });
}
/**
 * Dry run a group update.
 */
export function dryRunUpdateGroup(groupId: string, groupUpdate: GroupUpdate, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: GroupUpdateDryRun;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: GroupUpdateDryRun;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/groups/${encodeURIComponent(groupId)}/dry-run.json`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: groupUpdate
    }));
}
/**
 * Dry run a group deletion.
 */
export function dryRunDeleteGroup(groupId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: object[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: GroupDeleteDryRunError;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/groups/${encodeURIComponent(groupId)}/dry-run.json`, {
        ...opts,
        method: "DELETE"
    });
}
/**
 * Get healthcheck information.
 */
export function viewHealthcheck(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: Healthcheck;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    }>("/healthcheck.json", {
        ...opts
    });
}
/**
 * Check if passbolt is up.
 */
export function viewHealthcheckStatus(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: string;
        };
    }>("/healthcheck/status.json", {
        ...opts
    });
}
/**
 * Get metadata keys.
 */
export function indexMetadataKeys({ filterDeleted, filterExpired, containMetadataPrivateKeys }: {
    filterDeleted?: 1 | 0;
    filterExpired?: 1 | 0;
    containMetadataPrivateKeys?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: MetadataKeysIndexAndView[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>(`/metadata/keys.json${QS.query(QS.explode({
        "filter[deleted]": filterDeleted,
        "filter[expired]": filterExpired,
        "contain[metadata_private_keys]": containMetadataPrivateKeys
    }))}`, {
        ...opts
    });
}
/**
 * Create a metadata key.
 */
export function addMetadataKey(metadataKeyAdd: MetadataKeyAdd, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: MetadataKeysIndexAndView[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/keys.json", oazapfts.json({
        ...opts,
        method: "POST",
        body: metadataKeyAdd
    }));
}
/**
 * Mark a metadata key as expired.
 */
export function updateMetadataKey(metadataKeyId: string, metadataKeyUpdate: MetadataKeyUpdate, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/metadata/keys/${encodeURIComponent(metadataKeyId)}.json`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: metadataKeyUpdate
    }));
}
/**
 * Delete a metadata key.
 */
export function deleteMetadataKey(metadataKeyId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/metadata/keys/${encodeURIComponent(metadataKeyId)}.json`, {
        ...opts,
        method: "DELETE"
    });
}
/**
 * Create a metadata private key.
 */
export function addMetadataPrivateKey(metadataPrivateKeysAdd: MetadataPrivateKeysAdd, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: object;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/keys/privates.json", oazapfts.json({
        ...opts,
        method: "POST",
        body: metadataPrivateKeysAdd
    }));
}
/**
 * Update a metadata private key.
 */
export function updateMetadataPrivateKey(metadataPrivateKeyId: string, e2EeDataOnly: E2EeDataOnly, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: MetadataPrivateKeysShortIndex;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/metadata/keys/private/${encodeURIComponent(metadataPrivateKeyId)}.json`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: e2EeDataOnly
    }));
}
/**
 * Get metadata keys settings.
 */
export function indexMetadataKeysSettings(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: MetadataKeysSettingsIndex;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/keys/settings.json", {
        ...opts
    });
}
/**
 * Update metadata keys settings.
 */
export function updateMetadataKeysSettings(metadataKeysSettingsUpdate: MetadataKeysSettingsUpdate, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: MetadataKeysSettingsIndex;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/keys/settings.json", oazapfts.json({
        ...opts,
        method: "POST",
        body: metadataKeysSettingsUpdate
    }));
}
/**
 * Get metadata types settings
 */
export function viewMetadataTypesSettings(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: MetadataTypesSettingsIndexAndView;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/types/settings.json", {
        ...opts
    });
}
/**
 * Upgrade a resource types settings
 */
export function upgradeMetadataTypesSettings(metadataTypesSettingsIndexAndView: MetadataTypesSettingsIndexAndView, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: MetadataTypesSettingsIndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/types/settings.json", oazapfts.json({
        ...opts,
        method: "POST",
        body: metadataTypesSettingsIndexAndView
    }));
}
/**
 * Get folders with expired keys
 */
export function viewMetadataRotateKeyFolders(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: E2EeMetadataBasedCommon[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/rotate-key/folders.json", {
        ...opts
    });
}
/**
 * Rotate expired metadata keys for folders
 */
export function rotateMetadataExpiredKeysFolders(body: E2EeMetadataBasedIdModifiedModifiedBy[], opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: E2EeMetadataBasedCommon[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 409;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/rotate-key/folders.json", oazapfts.json({
        ...opts,
        method: "POST",
        body
    }));
}
/**
 * Get resources with expired keys
 */
export function viewMetadataRotateKeyResources(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: ResourceMetadataRotateKey[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/rotate-key/resources.json", {
        ...opts
    });
}
/**
 * Rotate expired metadata keys for resources
 */
export function rotateMetadataExpiredKeys(body: E2EeMetadataBasedIdModifiedModifiedBy[], opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: ResourceMetadataRotateKey[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: Error;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 409;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/rotate-key/resources.json", oazapfts.json({
        ...opts,
        method: "POST",
        body
    }));
}
/**
 * Get session keys.
 */
export function viewMetadataSessionKeys(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: MetadataSessionKeyIndexAndView[];
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/session-keys.json", {
        ...opts
    });
}
/**
 * Add a session key.
 */
export function addMetadataSessionKey(e2EeDataOnly: E2EeDataOnly, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: MetadataSessionKeyIndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/session-keys.json", oazapfts.json({
        ...opts,
        method: "POST",
        body: e2EeDataOnly
    }));
}
/**
 * Update a given session-key entry.
 */
export function updateMetadataSessionKey(sessionKeyId: string, e2EeDataModified: E2EeDataModified, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: E2EeDataModified;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 409;
        data: {
            header: Header;
            body: string;
        };
    }>(`/metadata/session-key/${encodeURIComponent(sessionKeyId)}.json`, oazapfts.json({
        ...opts,
        method: "POST",
        body: e2EeDataModified
    }));
}
/**
 * Delete a given session-key entry.
 */
export function deleteSessionKey(sessionKeyId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/metadata/session-key/${encodeURIComponent(sessionKeyId)}.json`, {
        ...opts,
        method: "DELETE"
    });
}
/**
 * Get tags with expired keys
 */
export function viewMetadataRotateKeyTags(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: TagV5MetadataRotateKey[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/rotate-key/tags.json", {
        ...opts
    });
}
/**
 * Rotate expired metadata keys for tags
 */
export function rotateMetadataKeysTags(body: TagV5MetadataRotateKey[], opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: TagV5MetadataRotateKey[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>("/metadata/rotate-key/tags.json", oazapfts.json({
        ...opts,
        method: "POST",
        body
    }));
}
/**
 * Get Upgradable Folders
 */
export function viewMetadataUpgradeFolders({ filterIsShared, containPermission }: {
    filterIsShared?: boolean;
    containPermission?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: FolderV4IndexAndView[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    }>(`/metadata/upgrade/folders.json${QS.query(QS.explode({
        "filter[is-shared]": filterIsShared,
        "contain[permission]": containPermission
    }))}`, {
        ...opts
    });
}
/**
 * Upgrade a folder
 */
export function upgradeMetadataFolders(body: E2EeMetadataBasedIdModifiedModifiedBy[], { containPermissions }: {
    containPermissions?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: FolderV4IndexAndView[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 409;
        data: {
            header: Header;
            body: string;
        };
    }>(`/metadata/upgrade/folders.json${QS.query(QS.explode({
        "contain[permissions]": containPermissions
    }))}`, oazapfts.json({
        ...opts,
        method: "POST",
        body
    }));
}
/**
 * Get Upgradable Resources
 */
export function viewMetadataUpgradeResources({ filterIsShared }: {
    filterIsShared?: boolean;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: ResourceV4IndexAndView[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    }>(`/metadata/upgrade/resources.json${QS.query(QS.explode({
        "filter[is-shared]": filterIsShared
    }))}`, {
        ...opts
    });
}
/**
 * Upgrade a Resource
 */
export function upgradeMetadataResources(body: E2EeMetadataBasedIdModifiedModifiedBy[], { filterIsShared, containPermissions }: {
    filterIsShared?: boolean;
    containPermissions?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: ResourceV4IndexAndView[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 409;
        data: {
            header: Header;
            body: string;
        };
    }>(`/metadata/upgrade/resources.json${QS.query(QS.explode({
        "filter[is-shared]": filterIsShared,
        "contain[permissions]": containPermissions
    }))}`, oazapfts.json({
        ...opts,
        method: "POST",
        body
    }));
}
/**
 * Get Upgradable Tags
 */
export function viewMetadataUpgradeTags({ filterIsShared }: {
    filterIsShared?: boolean;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: TagLegacy[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    }>(`/metadata/upgrade/tags.json${QS.query(QS.explode({
        "filter[is-shared]": filterIsShared
    }))}`, {
        ...opts
    });
}
/**
 * Upgrade a tag
 */
export function processeMetadataUpgradeTags(body: TagV5[], { filterIsShared }: {
    filterIsShared?: boolean;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: TagLegacy[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/metadata/upgrade/tags.json${QS.query(QS.explode({
        "filter[is-shared]": filterIsShared
    }))}`, oazapfts.json({
        ...opts,
        method: "POST",
        body
    }));
}
/**
 * Check multi-factor authentication.
 */
export function mfaVerifyCheck({ mfaProviderName }: {
    mfaProviderName?: "totp" | "yubikey";
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    // @ts-ignore
    }>(`/mfa/verify/${encodeURIComponent(mfaProviderName)}.json`, {
        ...opts
    });
}
/**
 * Attempt multi-factor authentication.
 */
export function mfaVerifyAttempt(mfaAttempt: MfaAttempt, { mfaProviderName }: {
    mfaProviderName?: "totp" | "yubikey";
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: InvalidOtp;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    // @ts-ignore
    }>(`/mfa/verify/${encodeURIComponent(mfaProviderName)}.json`, oazapfts.json({
        ...opts,
        method: "POST",
        body: mfaAttempt
    }));
}
/**
 * Information about MFA requirements.
 */
export function mfaVerifyError(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: Error;
        };
    }>("/mfa/verify/error.json", {
        ...opts
    });
}
/**
 * Move an element.
 */
export function moveElement(foreignModel: "resource" | "folder", foreignId: string, move: Move, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/move/${encodeURIComponent(foreignModel)}/${encodeURIComponent(foreignId)}.json`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: move
    }));
}
/**
 * Get permissions for a resource.
 */
export function indexPermissionsResource(resourceId: string, { containGroup, containUser, containUserProfile }: {
    containGroup?: 1 | 0;
    containUser?: 1 | 0;
    containUserProfile?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: PermissionIndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/permissions/resource/${encodeURIComponent(resourceId)}.json${QS.query(QS.explode({
        "contain[group]": containGroup,
        "contain[user]": containUser,
        "contain[user.profile]": containUserProfile
    }))}`, {
        ...opts
    });
}
/**
 * Get multiple resources.
 */
export function indexResources({ containCreator, containFavorite, containModifier, containSecret, containResourceType, containPermission, containPermissions, containPermissionsUserProfile, containPermissionsGroup, filterIsFavorite, filterIsSharedWithGroup, filterIsOwnedByMe, filterIsSharedWithMe, filterHasId, filterHasParent, filterMetadataKeyType }: {
    containCreator?: 1 | 0;
    containFavorite?: 1 | 0;
    containModifier?: 1 | 0;
    containSecret?: 1 | 0;
    containResourceType?: 1 | 0;
    containPermission?: 1 | 0;
    containPermissions?: 1 | 0;
    containPermissionsUserProfile?: 1 | 0;
    containPermissionsGroup?: 1 | 0;
    filterIsFavorite?: boolean;
    filterIsSharedWithGroup?: string;
    filterIsOwnedByMe?: boolean;
    filterIsSharedWithMe?: boolean;
    filterHasId?: string;
    filterHasParent?: string;
    filterMetadataKeyType?: string;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: (ResourceV4IndexAndView | ResourceV5IndexAndView)[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>(`/resources.json${QS.query(QS.explode({
        "contain[creator]": containCreator,
        "contain[favorite]": containFavorite,
        "contain[modifier]": containModifier,
        "contain[secret]": containSecret,
        "contain[resource-type]": containResourceType,
        "contain[permission]": containPermission,
        "contain[permissions]": containPermissions,
        "contain[permissions.user.profile]": containPermissionsUserProfile,
        "contain[permissions.group]": containPermissionsGroup,
        "filter[is-favorite]": filterIsFavorite,
        "filter[is-shared-with-group]": filterIsSharedWithGroup,
        "filter[is-owned-by-me]": filterIsOwnedByMe,
        "filter[is-shared-with-me]": filterIsSharedWithMe,
        "filter[has-id]": filterHasId,
        "filter[has-parent]": filterHasParent,
        "filter[metadata_key_type]": filterMetadataKeyType
    }))}`, {
        ...opts
    });
}
/**
 * Create a resource.
 */
export function addResource(resourceAddAndUpdate: ResourceAddAndUpdate, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: ResourceV4IndexAndView | ResourceV5IndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>("/resources.json", oazapfts.json({
        ...opts,
        method: "POST",
        body: resourceAddAndUpdate
    }));
}
/**
 * Get a resource.
 */
export function viewResource(resourceId: string, { containCreator, containFavorite, containModifier, containSecret, containResourceType, containPermission, containPermissions, containPermissionsUserProfile, containPermissionsGroup }: {
    containCreator?: 1 | 0;
    containFavorite?: 1 | 0;
    containModifier?: 1 | 0;
    containSecret?: 1 | 0;
    containResourceType?: 1 | 0;
    containPermission?: 1 | 0;
    containPermissions?: 1 | 0;
    containPermissionsUserProfile?: 1 | 0;
    containPermissionsGroup?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: ResourceV4IndexAndView | ResourceV5IndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/resources/${encodeURIComponent(resourceId)}.json${QS.query(QS.explode({
        "contain[creator]": containCreator,
        "contain[favorite]": containFavorite,
        "contain[modifier]": containModifier,
        "contain[secret]": containSecret,
        "contain[resource-type]": containResourceType,
        "contain[permission]": containPermission,
        "contain[permissions]": containPermissions,
        "contain[permissions.user.profile]": containPermissionsUserProfile,
        "contain[permissions.group]": containPermissionsGroup
    }))}`, {
        ...opts
    });
}
/**
 * Update a resource.
 */
export function updateResource(resourceId: string, resourceAddAndUpdate: ResourceAddAndUpdate, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: ResourceV4IndexAndView | ResourceV5IndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/resources/${encodeURIComponent(resourceId)}.json`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: resourceAddAndUpdate
    }));
}
/**
 * Delete a resource.
 */
export function deleteResource(resourceId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/resources/${encodeURIComponent(resourceId)}.json`, {
        ...opts,
        method: "DELETE"
    });
}
/**
 * Get multiple resource types.
 */
export function resourceTypesIndex({ containResourcesCount, filterIsDeleted }: {
    containResourcesCount?: 1 | 0;
    filterIsDeleted?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: ResourceTypeIndex[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>(`/resource-types.json${QS.query(QS.explode({
        "contain[resources_count]": containResourcesCount,
        "filter[is-deleted]": filterIsDeleted
    }))}`, {
        ...opts
    });
}
/**
 * Get a resource type.
 */
export function viewResourceType(resourceTypeId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: ResourceType;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/resource-types/${encodeURIComponent(resourceTypeId)}.json`, {
        ...opts
    });
}
/**
 * Delete a resource type.
 */
export function deleteResourceType(resourceTypeId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/resource-types/${encodeURIComponent(resourceTypeId)}.json`, {
        ...opts,
        method: "DELETE"
    });
}
/**
 * Update resource type.
 */
export function updateResourceType(resourceTypeId: string, resourceTypeUpdate: ResourceTypeUpdate, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/resource-types/${encodeURIComponent(resourceTypeId)}.json`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: resourceTypeUpdate
    }));
}
/**
 * Get multiple roles.
 */
export function indexRoles(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: Role[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>("/roles.json", {
        ...opts
    });
}
/**
 * View user's secret for a resource.
 */
export function viewSecret(resourceId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: SecretIndex;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/secrets/resource/${encodeURIComponent(resourceId)}.json`, {
        ...opts
    });
}
/**
 * Get the server settings.
 */
export function indexSettings(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: Index;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>("/settings.json", {
        ...opts
    });
}
/**
 * Share a resource or folder.
 */
export function updateShare(foreignModel: "resource" | "folder", foreignId: string, shareUpdate: ShareUpdate, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: ShareUpdateError;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/share/${encodeURIComponent(foreignModel)}/${encodeURIComponent(foreignId)}.json`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: shareUpdate
    }));
}
/**
 * Get AROs for sharing.
 */
export function indexShareAros({ filterSearch, containGroupsUsers, containGpgkey, containRole }: {
    filterSearch?: string;
    containGroupsUsers?: 1 | 0;
    containGpgkey?: 1 | 0;
    containRole?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: ShareAros[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/share/search-aros.json${QS.query(QS.explode({
        "filter[search]": filterSearch,
        "contain[groups_users]": containGroupsUsers,
        "contain[gpgkey]": containGpgkey,
        "contain[role]": containRole
    }))}`, {
        ...opts
    });
}
/**
 * Simulate sharing a resource or folder.
 */
export function updateShareDryRun(foreignModel: "resource" | "folder", foreignId: string, shareUpdate: ShareUpdate, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: ShareUpdateDryRun;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: ShareUpdateError;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/share/simulate/${encodeURIComponent(foreignModel)}/${encodeURIComponent(foreignId)}.json`, oazapfts.json({
        ...opts,
        method: "POST",
        body: shareUpdate
    }));
}
/**
 * Get personal tags and shared tags.
 */
export function indexTags(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: TagIndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>("/tags.json", {
        ...opts
    });
}
/**
 * Update a tag.
 */
export function updateTag(resourceOrTagId: string, tagV5Update: TagV5Update, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: TagV5;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>(`/tags/${encodeURIComponent(resourceOrTagId)}.json`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: tagV5Update
    }));
}
/**
 * Add tags to a resource.
 */
export function addTagsResource(resourceOrTagId: string, tagAddResource: TagAddResource, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: TagIndexAndView[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>(`/tags/${encodeURIComponent(resourceOrTagId)}.json`, oazapfts.json({
        ...opts,
        method: "POST",
        body: tagAddResource
    }));
}
/**
 * Get multiple users.
 */
export function indexUsers({ containLastLoggedIn, containGroupsUsers, containGpgkey, containProfile, containRole, containMissingMetadataKeyIds, filterSearch, filterHasGroups, filterHasAccess, filterIsAdmin, filterIsActive }: {
    containLastLoggedIn?: 1 | 0;
    containGroupsUsers?: 1 | 0;
    containGpgkey?: 1 | 0;
    containProfile?: 1 | 0;
    containRole?: 1 | 0;
    containMissingMetadataKeyIds?: 1 | 0;
    filterSearch?: string;
    filterHasGroups?: string[];
    filterHasAccess?: string[];
    filterIsAdmin?: boolean;
    filterIsActive?: boolean;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: HeaderWithPagination;
            body: UserIndexAndView[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    }>(`/users.json${QS.query(QS.explode({
        "contain[last_logged_in]": containLastLoggedIn,
        "contain[groups_users]": containGroupsUsers,
        "contain[gpgkey]": containGpgkey,
        "contain[profile]": containProfile,
        "contain[role]": containRole,
        "contain[missing_metadata_key_ids]": containMissingMetadataKeyIds,
        "filter[search]": filterSearch,
        "filter[has-groups]": filterHasGroups,
        "filter[has-access]": filterHasAccess,
        "filter[is-admin]": filterIsAdmin,
        "filter[is-active]": filterIsActive
    }))}`, {
        ...opts
    });
}
/**
 * Create a user.
 */
export function addUser(userAdd: UserAdd, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: UserIndexAndView[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    }>("/users.json", oazapfts.json({
        ...opts,
        method: "POST",
        body: userAdd
    }));
}
/**
 * Get a user.
 */
export function viewUser(userId: string, { containMissingMetadataKeyIds }: {
    containMissingMetadataKeyIds?: 1 | 0;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: UserIndexAndView;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 403;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/users/${encodeURIComponent(userId)}.json${QS.query(QS.explode({
        "contain[missing_metadata_key_ids]": containMissingMetadataKeyIds
    }))}`, {
        ...opts
    });
}
/**
 * Update a user.
 */
export function updateUser(userId: string, userUpdate: UserUpdate, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: UserIndexAndView[];
        };
    } | {
        status: 400;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/users/${encodeURIComponent(userId)}.json`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: userUpdate
    }));
}
/**
 * Delete a user.
 */
export function deleteUser(userId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            /** Could also be a `string` if the issue is not related to resources or groups. */
            body: UserDelete;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/users/${encodeURIComponent(userId)}.json`, {
        ...opts,
        method: "DELETE"
    });
}
/**
 * Dry run a user deletion.
 */
export function dryRunDeleteUser(userId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: {
            header: Header;
            body: null;
        };
    } | {
        status: 400;
        data: {
            header: Header;
            /** Could also be a `string` if the issue is not related to resources or groups. */
            body: UserDeleteDryRun;
        };
    } | {
        status: 401;
        data: {
            header: Header;
            body: string;
        };
    } | {
        status: 404;
        data: {
            header: Header;
            body: string;
        };
    }>(`/users/${encodeURIComponent(userId)}/dry-run.json`, {
        ...opts,
        method: "DELETE"
    });
}
