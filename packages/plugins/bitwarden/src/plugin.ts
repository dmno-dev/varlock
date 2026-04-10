import { type Resolver, plugin } from 'varlock/plugin-lib';
import ky from 'ky';
import { Buffer } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { deriveKeyFromAccessToken, decryptAes256CbcHmac } from './crypto-utils.js';
import { execBwCliCommand, type BwItem } from './bw-pm-cli-helper.js';

const { subtle } = webcrypto;

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const BITWARDEN_ICON = 'simple-icons:bitwarden';

plugin.name = 'bitwarden';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = BITWARDEN_ICON;
plugin.standardVars = {
  initDecorator: '@initBitwarden',
  params: {
    accessToken: { key: 'BWS_ACCESS_TOKEN' },
  },
};

interface BitwardenSecretResponse {
  id: string;
  organizationId: string;
  key: string;
  value: string;
  note: string;
  creationDate: string;
  revisionDate: string;
}

interface IdentityTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  encrypted_payload?: string;
}

interface CachedAuth {
  jwt: string;
  orgEncKey: webcrypto.CryptoKey;
  orgMacKey: webcrypto.CryptoKey;
  expiresAt: number;
}

class BitwardenPluginInstance {
  /** Access token for Bitwarden Secrets Manager machine account */
  private accessToken?: string;
  /** API URL - defaults to https://api.bitwarden.com */
  private apiUrl: string = 'https://api.bitwarden.com';
  /** Identity URL - defaults to https://identity.bitwarden.com */
  private identityUrl: string = 'https://identity.bitwarden.com';
  /** Cached authentication */
  private cachedAuth?: CachedAuth;
  /** In-flight auth promise - prevents parallel resolution from triggering multiple auth requests (rate limit fix) */
  private authInFlight?: Promise<CachedAuth>;

  constructor(
    readonly id: string,
  ) {}

  setAuth(
    accessToken: any,
    apiUrl?: string,
    identityUrl?: string,
  ) {
    if (accessToken && typeof accessToken === 'string') this.accessToken = accessToken;
    if (apiUrl) {
      this.apiUrl = apiUrl;
    }
    if (identityUrl) {
      this.identityUrl = identityUrl;
    }
    debug('bitwarden instance', this.id, 'set auth - apiUrl:', this.apiUrl);
  }

  /**
   * Parse the access token format: 0.<client_id>.<client_secret>:<encryption_key>
   */
  private parseAccessToken(token: string): { clientId: string; clientSecret: string; encryptionKey: string } {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== '0') {
      throw new SchemaError('Invalid access token format. Expected: 0.<client_id>.<client_secret>:<encryption_key>');
    }

    // Split the last part by colon to separate client_secret from encryption_key
    const lastPart = parts[2];
    const colonIndex = lastPart.indexOf(':');
    if (colonIndex === -1) {
      throw new SchemaError('Invalid access token format. Expected: 0.<client_id>.<client_secret>:<encryption_key>');
    }

    return {
      clientId: parts[1],
      clientSecret: lastPart.substring(0, colonIndex),
      encryptionKey: lastPart.substring(colonIndex + 1),
    };
  }


  /**
   * Authenticate and get JWT + organization key
   * Uses authInFlight to prevent parallel secret resolution
   * from triggering multiple auth requests & getting rate limited
   */
  private async authenticate(): Promise<CachedAuth> {
    if (!this.accessToken) {
      throw new ResolutionError('Access token not configured');
    }

    // Check cache
    if (this.cachedAuth && this.cachedAuth.expiresAt > Date.now()) {
      debug('Using cached authentication');
      return this.cachedAuth;
    }

    // If auth is already in progress, wait for it
    if (this.authInFlight) {
      await this.authInFlight;
      if (this.cachedAuth && this.cachedAuth.expiresAt > Date.now()) {
        return this.cachedAuth;
      }
    }

    this.authInFlight = this._doAuthenticate();
    try {
      const result = await this.authInFlight;
      this.cachedAuth = result;
      return result;
    } finally {
      this.authInFlight = undefined;
    }
  }

  private async _doAuthenticate(): Promise<CachedAuth> {
    const { clientId, clientSecret, encryptionKey } = this.parseAccessToken(this.accessToken!);

    // Step 1: Exchange access token for JWT
    debug('Exchanging access token for JWT at:', this.identityUrl);
    const tokenResponse = await ky.post(`${this.identityUrl}/connect/token`, {
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'api.secrets',
        client_id: clientId,
        client_secret: clientSecret,
      }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }).json<IdentityTokenResponse>();

    const jwt = tokenResponse.access_token;
    debug('Received JWT token');

    if (!tokenResponse.encrypted_payload) {
      throw new ResolutionError('No encrypted_payload in identity response');
    }

    // Step 2: Derive key from encryption key (produces 64 bytes: 32 for enc, 32 for mac)
    debug('Deriving key from encryption key (length:', Buffer.from(encryptionKey, 'base64').length, 'bytes)');
    const { encKey, macKey } = await deriveKeyFromAccessToken(encryptionKey);
    debug('Derived encryption and MAC keys');

    // Step 3: Decrypt the organization key
    debug('Decrypting organization key from encrypted_payload');
    const decryptedPayload = await decryptAes256CbcHmac(tokenResponse.encrypted_payload, encKey, macKey);
    const payload = JSON.parse(decryptedPayload);
    debug('Decrypted payload:', Object.keys(payload));

    if (!payload.encryptionKey) {
      throw new ResolutionError('No encryptionKey in decrypted payload');
    }

    // The organization key is 64 bytes (32 enc + 32 mac)
    const orgKeyBytes = Buffer.from(payload.encryptionKey, 'base64');
    debug('Organization key bytes:', orgKeyBytes.length);

    if (orgKeyBytes.length !== 64) {
      throw new ResolutionError(`Expected 64-byte organization key, got ${orgKeyBytes.length} bytes`);
    }

    // Split into encryption and MAC keys
    const orgEncKey = await subtle.importKey(
      'raw',
      orgKeyBytes.subarray(0, 32),
      { name: 'AES-CBC' },
      false,
      ['decrypt'],
    );

    const orgMacKey = await subtle.importKey(
      'raw',
      orgKeyBytes.subarray(32, 64),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    debug('Successfully authenticated and derived organization keys');

    // Cache for reuse (subtract 60s for safety margin)
    const authCache: CachedAuth = {
      jwt,
      orgEncKey,
      orgMacKey,
      expiresAt: Date.now() + (tokenResponse.expires_in - 60) * 1000,
    };

    return authCache;
  }

  async getSecret(secretId: string): Promise<string> {
    const auth = await this.authenticate();

    try {
      const url = `${this.apiUrl}/secrets/${secretId}`;
      debug('Fetching secret from:', url);

      const response = await ky.get(url, {
        headers: {
          Authorization: `Bearer ${auth.jwt}`,
        },
        timeout: 30000,
      }).json<BitwardenSecretResponse>();

      debug('Successfully fetched encrypted secret:', secretId);

      // Decrypt the secret value
      if (!response?.value) {
        throw new ResolutionError(`Secret "${secretId}" has no value`);
      }

      const decryptedValue = await decryptAes256CbcHmac(response.value, auth.orgEncKey, auth.orgMacKey);
      debug('Successfully decrypted secret value');

      return decryptedValue;
    } catch (err: any) {
      return this.handleBitwardenError(err, secretId);
    }
  }

  private handleBitwardenError(err: any, secretId: string): never {
    const statusCode = err?.response?.status;
    const errorMsg = err?.message || String(err);

    debug('Bitwarden API error:', {
      statusCode,
      errorMsg,
      secretId,
      apiUrl: this.apiUrl,
    });

    if (statusCode === 404 || errorMsg.includes('not found') || errorMsg.includes('NotFound')) {
      throw new ResolutionError(`Secret "${secretId}" not found`, {
        tip: [
          'Verify the secret ID is correct (must be a valid UUID)',
          'Check if the secret exists in your Bitwarden Secrets Manager',
          'Ensure your machine account has access to this secret or its project',
        ].join('\n'),
      });
    }

    if (statusCode === 401 || statusCode === 403 || errorMsg.includes('Unauthorized') || errorMsg.includes('Forbidden')) {
      throw new ResolutionError(`Access denied for secret "${secretId}"`, {
        tip: [
          'Verify your machine account has "Can read" or "Can read, write" permissions',
          'Check that the machine account has access to this secret or its project',
          'Review the role assignments in Bitwarden Secrets Manager',
        ].join('\n'),
      });
    }

    if (errorMsg.includes('auth') || errorMsg.includes('credential') || errorMsg.includes('token')) {
      throw new ResolutionError(`Authentication failed: ${errorMsg}`, {
        tip: [
          'Verify accessToken is correct',
          'Check if the access token has expired or been revoked',
          'Ensure the machine account is not disabled',
        ].join('\n'),
      });
    }

    // Generic error
    throw new ResolutionError(`Failed to fetch secret "${secretId}": ${errorMsg}`, {
      tip: 'Check Bitwarden service status and your network connection',
    });
  }
}

const pluginInstances: Record<string, BitwardenPluginInstance> = {};

plugin.registerRootDecorator({
  name: 'initBitwarden',
  description: 'Initialize a Bitwarden Secrets Manager plugin instance for bitwarden() resolver',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    if (!objArgs) throw new SchemaError('Expected configuration arguments');

    // Validate id (must be static if provided)
    if (objArgs.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');

    if (pluginInstances[id]) {
      throw new SchemaError(`Instance with id "${id}" already initialized`);
    }

    // Validate required fields
    if (!objArgs.accessToken) {
      throw new SchemaError('accessToken is required', {
        tip: 'Add accessToken parameter: @initBitwarden(accessToken=$BWS_ACCESS_TOKEN)',
      });
    }

    // Validate apiUrl is static if provided
    if (objArgs.apiUrl && !objArgs.apiUrl.isStatic) {
      throw new SchemaError('Expected apiUrl to be static');
    }
    const apiUrl: string | undefined = objArgs.apiUrl ? String(objArgs.apiUrl.staticValue) : undefined;

    // Validate identityUrl is static if provided
    if (objArgs.identityUrl && !objArgs.identityUrl.isStatic) {
      throw new SchemaError('Expected identityUrl to be static');
    }
    const identityUrl: string | undefined = objArgs.identityUrl ? String(objArgs.identityUrl.staticValue) : undefined;

    // Create instance
    pluginInstances[id] = new BitwardenPluginInstance(id);

    return {
      id,
      apiUrl,
      identityUrl,
      accessTokenResolver: objArgs.accessToken,
    };
  },
  async execute({
    id,
    apiUrl,
    identityUrl,
    accessTokenResolver,
  }) {
    // even if the token is empty, we can't throw errors yet
    // in case the instance is never actually used
    const accessTokenValue = await accessTokenResolver?.resolve();

    pluginInstances[id].setAuth(
      accessTokenValue,
      apiUrl,
      identityUrl,
    );
  },
});

plugin.registerDataType({
  name: 'bitwardenAccessToken',
  sensitive: true,
  typeDescription: 'Access token for a Bitwarden Secrets Manager machine account',
  icon: BITWARDEN_ICON,
  docs: [
    {
      description: 'Bitwarden Machine Accounts',
      url: 'https://bitwarden.com/help/secrets-manager-machine-accounts/',
    },
  ],
  async validate(val) {
    // Validate format: 0.<client_id>.<client_secret>:<encryption_key>
    const parts = val.split('.');
    if (parts.length !== 3 || parts[0] !== '0') {
      throw new ValidationError('Access token must be in format: 0.<client_id>.<client_secret>:<encryption_key>');
    }
    if (!parts[2].includes(':')) {
      throw new ValidationError('Access token must be in format: 0.<client_id>.<client_secret>:<encryption_key>');
    }
  },
});

plugin.registerDataType({
  name: 'bitwardenSecretId',
  sensitive: false,
  typeDescription: 'UUID that identifies a secret in Bitwarden Secrets Manager',
  icon: BITWARDEN_ICON,
  docs: [
    {
      description: 'Bitwarden Secrets Manager',
      url: 'https://bitwarden.com/products/secrets-manager/',
    },
  ],
  async validate(val) {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(val)) {
      throw new ValidationError('Secret ID must be a valid UUID');
    }
  },
});

plugin.registerDataType({
  name: 'bitwardenOrganizationId',
  sensitive: false,
  typeDescription: 'UUID that identifies an organization in Bitwarden',
  icon: BITWARDEN_ICON,
  docs: [
    {
      description: 'Bitwarden Organizations',
      url: 'https://bitwarden.com/help/about-organizations/',
    },
  ],
  async validate(val) {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(val)) {
      throw new ValidationError('Organization ID must be a valid UUID');
    }
  },
});

plugin.registerResolverFunction({
  name: 'bitwarden',
  label: 'Fetch secret value from Bitwarden Secrets Manager',
  icon: BITWARDEN_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    let instanceId = '_default';
    let secretIdResolver: Resolver | undefined;

    if (this.arrArgs!.length === 1) {
      secretIdResolver = this.arrArgs![0];
    } else if (this.arrArgs!.length === 2) {
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      secretIdResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 1-2 arguments');
    }

    // Validate instance exists
    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No Bitwarden plugin instances found', {
        tip: 'Initialize at least one Bitwarden plugin instance using @initBitwarden() decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Bitwarden plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initBitwarden call',
            'or use `bitwarden(id, secretId)` to select an instance by id',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Bitwarden plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return { instanceId, secretIdResolver };
  },
  async resolve({ instanceId, secretIdResolver }) {
    const selectedInstance = pluginInstances[instanceId];

    // Resolve secret ID
    const secretId = await secretIdResolver.resolve();
    if (typeof secretId !== 'string') {
      throw new SchemaError('Expected secret ID to resolve to a string');
    }

    // Validate UUID format
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(secretId)) {
      throw new SchemaError(`Invalid secret ID format: "${secretId}"`, {
        tip: 'Secret ID must be a valid UUID (e.g., "12345678-1234-1234-1234-123456789abc")',
      });
    }

    const secretValue = await selectedInstance.getSecret(secretId);
    return secretValue;
  },
});

// ──────────────────────────────────────────────────────────────
// Bitwarden Password Manager / Vaultwarden  (bwp)
// CLI-based access via the `bw` command-line tool.
// ──────────────────────────────────────────────────────────────

/**
 * Extract a named field from a Bitwarden vault item JSON object.
 * Standard fields: password, username, notes, totp, uri
 * Falls back to searching the `fields` array for custom fields.
 */
function extractBwItemField(item: BwItem, field: string): string {
  switch (field) {
    case 'password':
      if (item.login?.password != null) return item.login.password;
      throw new ResolutionError(`Item "${item.name}" has no password field`);
    case 'username':
      if (item.login?.username != null) return item.login.username;
      throw new ResolutionError(`Item "${item.name}" has no username field`);
    case 'notes':
      if (item.notes != null) return item.notes;
      throw new ResolutionError(`Item "${item.name}" has no notes`);
    case 'totp':
      if (item.login?.totp != null) return item.login.totp;
      throw new ResolutionError(`Item "${item.name}" has no TOTP field`);
    case 'uri':
      if (item.login?.uris?.[0]?.uri != null) return item.login.uris[0].uri;
      throw new ResolutionError(`Item "${item.name}" has no URI field`);
    default: {
      // Try custom fields (case-insensitive match)
      const customField = item.fields?.find(
        (f) => f.name.toLowerCase() === field.toLowerCase(),
      );
      if (customField != null) return customField.value ?? '';
      throw new ResolutionError(`Field "${field}" not found in item "${item.name}"`, {
        tip: [
          'Available standard fields: password, username, notes, totp, uri',
          `Custom fields on this item: ${item.fields?.map((f) => f.name).join(', ') || 'none'}`,
        ].join('\n'),
      });
    }
  }
}

class BitwardenPasswordManagerInstance {
  private sessionToken?: string;

  constructor(readonly id: string) {}

  setAuth(sessionToken: unknown) {
    if (sessionToken && typeof sessionToken === 'string') this.sessionToken = sessionToken;
    debug('bwp instance', this.id, 'set auth');
  }

  async getSecret(itemQuery: string, field: string = 'password'): Promise<string> {
    if (!this.sessionToken) {
      throw new ResolutionError('No session token configured for Bitwarden Password Manager', {
        tip: [
          'Unlock your vault and capture the session token: bw unlock',
          'Set BWP_SESSION (or your configured env var) to the returned token',
        ].join('\n'),
      });
    }

    const raw = await execBwCliCommand(['get', 'item', itemQuery, '--nointeraction'], this.sessionToken);

    let item: BwItem;
    try {
      item = JSON.parse(raw);
    } catch {
      throw new ResolutionError(`Failed to parse Bitwarden CLI response for item "${itemQuery}"`, {
        tip: 'Make sure your session token is valid and the `bw` CLI is working correctly',
      });
    }

    return extractBwItemField(item, field);
  }
}

const bwpPluginInstances: Record<string, BitwardenPasswordManagerInstance> = {};

plugin.registerRootDecorator({
  name: 'initBwp',
  description: 'Initialize a Bitwarden Password Manager (or Vaultwarden) plugin instance via the `bw` CLI',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    if (!objArgs) throw new SchemaError('Expected configuration arguments');

    // id (optional, static)
    if (objArgs.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');

    if (bwpPluginInstances[id]) {
      throw new SchemaError(`Bitwarden PM instance with id "${id}" already initialized`);
    }

    if (!objArgs.sessionToken) {
      throw new SchemaError('sessionToken is required', {
        tip: [
          'Unlock your vault to obtain a session token: bw unlock',
          'Then pass it as: @initBwp(sessionToken=$BWP_SESSION)',
        ].join('\n'),
      });
    }

    bwpPluginInstances[id] = new BitwardenPasswordManagerInstance(id);

    return {
      id,
      sessionTokenResolver: objArgs.sessionToken,
    };
  },
  async execute({ id, sessionTokenResolver }) {
    const sessionTokenValue = await sessionTokenResolver?.resolve();
    bwpPluginInstances[id].setAuth(sessionTokenValue);
  },
});

plugin.registerDataType({
  name: 'bwSessionToken',
  sensitive: true,
  typeDescription: 'Bitwarden CLI session token (output of `bw unlock`)',
  icon: BITWARDEN_ICON,
  docs: [
    {
      description: 'Bitwarden CLI authentication',
      url: 'https://bitwarden.com/help/cli/#unlock',
    },
  ],
  async validate(val) {
    if (typeof val !== 'string' || val.length === 0) {
      throw new ValidationError('Bitwarden session token must be a non-empty string');
    }
  },
});

plugin.registerResolverFunction({
  name: 'bwp',
  label: 'Fetch a field from a Bitwarden Password Manager / Vaultwarden vault item via the `bw` CLI',
  icon: BITWARDEN_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    let instanceId = '_default';
    let itemQueryResolver: Resolver | undefined;
    const fieldResolver = this.objArgs?.field;

    const arrArgs = this.arrArgs ?? [];
    const argCount = arrArgs.length;

    if (argCount === 1) {
      itemQueryResolver = arrArgs[0];
    } else if (argCount === 2) {
      if (!arrArgs[0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(arrArgs[0].staticValue);
      itemQueryResolver = arrArgs[1];
    } else {
      throw new SchemaError('Expected 1 or 2 positional arguments: bwp("item") or bwp(instanceId, "item")');
    }

    if (!Object.keys(bwpPluginInstances).length) {
      throw new SchemaError('No Bitwarden PM plugin instances found', {
        tip: 'Initialize at least one instance using the @initBwp() root decorator',
      });
    }

    const selectedInstance = bwpPluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Bitwarden PM plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initBwp call',
            'or use `bwp(id, "item")` to select an instance by id',
            `Available ids: ${Object.keys(bwpPluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Bitwarden PM plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(bwpPluginInstances).join(', ')}`,
        });
      }
    }

    return { instanceId, itemQueryResolver, fieldResolver };
  },
  async resolve({ instanceId, itemQueryResolver, fieldResolver }) {
    const selectedInstance = bwpPluginInstances[instanceId];

    const itemQuery = await itemQueryResolver.resolve();
    if (typeof itemQuery !== 'string' || !itemQuery) {
      throw new SchemaError('Expected item name/id to resolve to a non-empty string');
    }

    let field = 'password';
    if (fieldResolver) {
      const resolvedField = await fieldResolver.resolve();
      if (typeof resolvedField === 'string' && resolvedField) field = resolvedField;
    }

    return await selectedInstance.getSecret(itemQuery, field);
  },
});
