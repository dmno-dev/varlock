export type SecretIndex = {
  id: string;
  user_id: string;
  resource_id: string;
  data: string;
  created: string;
  modified: string;
};

export type FolderV5IndexAndView = {
  id: string;
  metadata: string;
  metadata_key_id: string;
  metadata_key_type: 'user_key' | 'shared_key';
  created: string;
  modified: string;
  created_by: string;
  modified_by: string;
  personal: boolean;
  folder_parent_id: string;
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
  secrets?: Array<SecretIndex>;
};

export type ResourceV5IndexAndView = {
  id: string;
  metadata: string;
  metadata_key_id: string;
  metadata_key_type: 'user_key' | 'shared_key';
  created: string;
  modified: string;
  created_by: string;
  modified_by: string;
  personal: boolean;
  folder_parent_id: string;
  resource_type_id: string;
  expired: string;
  secrets?: Array<string>;
};

export type MetadataKeysIndexAndView = {
  metadata_private_keys?: Array<{
    user_id: string;
    metadata_key_id: string;
    data: string;
  }>;
};

export type ApiFolder = FolderV4IndexAndView | FolderV5IndexAndView;
export type ApiResource = ResourceV4IndexAndView | ResourceV5IndexAndView;

type ApiResponse<T> = { body: T };
export type VerifyResponse = ApiResponse<{ fingerprint: string, keydata: string }>;
export type LoginResponse = ApiResponse<{ challenge: string }>;
export type RefreshResponse = ApiResponse<{ access_token: string }>;
export type LogoutResponse = ApiResponse<null>;
export type ResourceResponse = ApiResponse<ApiResource>;
export type ResourcesResponse = ApiResponse<Array<ApiResource>>;
export type FoldersResponse = ApiResponse<Array<ApiFolder>>;
export type MetadataKeyResponse = ApiResponse<Array<MetadataKeysIndexAndView>>;

export type UUIDv4String = `${string}${string}${string}${string}${string}${string}${string}${string}${string
}-${string}${string}${string}${string}${string}-4${string}${string}${string}${string
}-${'8' | '9' | 'A' | 'B' | 'a' | 'b'}${string}${string}${string}${string
}-${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}`;

export type ClientOptions = {
  passphrase: string
  privateKey: string
  serverUrl: string
  userId: UUIDv4String
  duration?: number
};

export type Folder = {
  id: string
  name: string
  parent: string | null
};

export type Resource = {
  id: string
  name: string
  username: string
  uri?: string
  password?: string
  totp?: {
    secretKey: string
    period: number
    digits: number
    algorithm: string
    code?: string
  }
  customFields?: Record<string, string>
};

type CustomField = { id: string, type: string };
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
  uris: Array<string>
  custom_fields?: Array<{
    id: string
    type: string
    metadata_key: string
  }>
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
  custom_fields?: Array<{
    id: string
    type: string
    secret_value: string
  }>
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
};

export type GpgChallengeResponse = GpgChallengeRequest & { access_token: string, refresh_token: string };
