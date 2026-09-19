import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach, describe, expect, test,
} from 'vitest';
import outdent from 'outdent';
import { pluginTest } from 'varlock/test-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..');

const ACCESS_KEY_ID = 'test-key-id';
const ACCESS_KEY_SECRET = Buffer.alloc(32, 7).toString('base64');
const TENANT_ID = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = '66666666-7777-8888-9999-000000000000';
const CLIENT_SECRET = 'sp-client-secret';
const ENTRA_TOKEN = 'fake-entra-access-token';

type Setting = {
  key: string;
  value: string;
  label?: string;
  contentType?: string;
};
type RecordedRequest = {
  method?: string;
  pathname: string;
  searchParams: URLSearchParams;
  authMode: 'hmac' | 'bearer' | 'none';
  scope?: string;
};
type FakeAzure = {
  url: string;
  connectionString: string;
  requests: Array<RecordedRequest>;
  close: () => Promise<void>;
};

const servers: Array<FakeAzure> = [];

/**
 * One fake server standing in for three Azure endpoints:
 * - the App Configuration data plane (/kv and /kv/{key})
 * - a Key Vault (/secrets/{name})
 * - the Entra token endpoint (/{tenant}/oauth2/v2.0/token)
 */
async function startFakeAzure(opts: {
  settings?: Array<Setting>;
  vaultSecrets?: Record<string, string>;
  pageSize?: number;
} = {}): Promise<FakeAzure> {
  const settings = opts.settings ?? [];
  const vaultSecrets = opts.vaultSecrets ?? {};
  const pageSize = opts.pageSize ?? 100;
  const requests: Array<RecordedRequest> = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const requestUrl = new URL(req.url || '/', `http://${req.headers.host}`);
      const authHeader = req.headers.authorization || '';
      let authMode: RecordedRequest['authMode'] = 'none';
      if (authHeader.startsWith('HMAC-SHA256')) authMode = 'hmac';
      else if (authHeader.startsWith('Bearer')) authMode = 'bearer';
      const recorded: RecordedRequest = {
        method: req.method,
        pathname: requestUrl.pathname,
        searchParams: requestUrl.searchParams,
        authMode,
      };
      requests.push(recorded);

      const sendJson = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Entra token endpoint (service principal client_credentials)
      if (req.method === 'POST' && requestUrl.pathname.endsWith('/oauth2/v2.0/token')) {
        const form = new URLSearchParams(body);
        recorded.scope = form.get('scope') || undefined;
        if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
          sendJson(401, { error: 'invalid_client', error_description: 'bad credentials' });
          return;
        }
        sendJson(200, { access_token: ENTRA_TOKEN, expires_in: 3600, token_type: 'Bearer' });
        return;
      }

      // Key Vault secrets
      if (requestUrl.pathname.startsWith('/secrets/')) {
        if (authHeader !== `Bearer ${ENTRA_TOKEN}`) {
          sendJson(401, { error: { code: 'Unauthorized', message: 'bad token' } });
          return;
        }
        const [name] = requestUrl.pathname.slice('/secrets/'.length).split('/');
        if (!(name in vaultSecrets)) {
          sendJson(404, { error: { code: 'SecretNotFound', message: `${name} not found` } });
          return;
        }
        sendJson(200, { value: vaultSecrets[name], id: `${requestUrl.origin}${requestUrl.pathname}` });
        return;
      }

      // App Configuration: check auth
      if (recorded.authMode === 'hmac') {
        const date = req.headers['x-ms-date'] as string;
        const contentHash = req.headers['x-ms-content-sha256'] as string;
        const expectedHash = createHash('sha256').update(body).digest('base64');
        const stringToSign = `${req.method}\n${requestUrl.pathname}${requestUrl.search}\n${date};${req.headers.host};${contentHash}`;
        const expectedSig = createHmac('sha256', Buffer.from(ACCESS_KEY_SECRET, 'base64')).update(stringToSign).digest('base64');
        const expectedAuth = `HMAC-SHA256 Credential=${ACCESS_KEY_ID}&SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${expectedSig}`;
        if (contentHash !== expectedHash || authHeader !== expectedAuth) {
          sendJson(401, { title: 'Unauthorized', detail: 'bad HMAC signature' });
          return;
        }
      } else if (authHeader !== `Bearer ${ENTRA_TOKEN}`) {
        sendJson(401, { title: 'Unauthorized', detail: 'bad token' });
        return;
      }

      const toItem = (setting: Setting) => ({
        etag: 'test-etag',
        key: setting.key,
        label: setting.label ?? null,
        content_type: setting.contentType ?? null,
        value: setting.value,
        tags: {},
        locked: false,
        last_modified: '2026-01-01T00:00:00+00:00',
      });

      if (requestUrl.pathname.startsWith('/kv/')) {
        const key = decodeURIComponent(requestUrl.pathname.slice('/kv/'.length));
        const requestedLabel = requestUrl.searchParams.get('label') ?? undefined;
        const setting = settings.find((s) => s.key === key && s.label === requestedLabel);
        if (!setting) {
          sendJson(404, { type: 'https://azconfig.io/errors/key-not-found', title: 'The key was not found.' });
          return;
        }
        sendJson(200, toItem(setting));
        return;
      }

      if (requestUrl.pathname === '/kv') {
        const keyFilter = requestUrl.searchParams.get('key') || '*';
        const labelFilter = requestUrl.searchParams.get('label');
        const after = Number(requestUrl.searchParams.get('after') || 0);
        const keyPrefix = keyFilter.endsWith('*') ? keyFilter.slice(0, -1) : undefined;
        // label filter grammar: `*` wildcard, `\` escapes, `,` separates alternatives
        const labelMatcher = (label: string | undefined): boolean => {
          if (labelFilter === null || labelFilter === '*') return true;
          if (labelFilter === '\0') return label === undefined;
          return labelFilter.split(/(?<!\\),/).some((alt) => {
            const pattern = alt.replace(/\\(.)|(\*)|([.+?^${}()|[\]])/g, (_m, esc, star, special) => {
              if (esc !== undefined) return esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              if (star !== undefined) return '.*';
              return `\\${special}`;
            });
            return label !== undefined && new RegExp(`^${pattern}$`).test(label);
          });
        };
        const matching = settings.filter((s) => {
          const keyMatches = keyPrefix !== undefined ? s.key.startsWith(keyPrefix) : s.key === keyFilter;
          return keyMatches && labelMatcher(s.label);
        });
        const page = matching.slice(after, after + pageSize);
        const payload: Record<string, unknown> = { items: page.map(toItem) };
        if (after + pageSize < matching.length) {
          const nextParams = new URLSearchParams(requestUrl.searchParams);
          nextParams.set('after', String(after + pageSize));
          payload['@nextLink'] = `/kv?${nextParams}`;
        }
        sendJson(200, payload);
        return;
      }

      sendJson(404, { title: 'Not found' });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const fake: FakeAzure = {
    url,
    connectionString: `Endpoint=${url};Id=${ACCESS_KEY_ID};Secret=${ACCESS_KEY_SECRET}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
  servers.push(fake);
  return fake;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** schema preamble for an instance authenticated with an access-key connection string */
function connectionStringSchema(extraInitArgs = '') {
  return outdent`
    # @plugin(${PLUGIN_PATH})
    # @initAzure(appConfigConnectionString=$AZURE_APPCONFIG_CONNECTION_STRING${extraInitArgs})
    # ---
    # @type=azureAppConfigConnectionString
    AZURE_APPCONFIG_CONNECTION_STRING=
  `;
}

/** schema preamble for an instance authenticated with a service principal against the fake token endpoint */
function servicePrincipalSchema(fake: FakeAzure, extraInitArgs = '') {
  return outdent`
    # @plugin(${PLUGIN_PATH})
    # @initAzure(
    #   authorityHost="${fake.url}",
    #   tenantId=$AZURE_TENANT_ID,
    #   clientId=$AZURE_CLIENT_ID,
    #   clientSecret=$AZURE_CLIENT_SECRET${extraInitArgs}
    # )
    # ---
    # @type=azureTenantId
    AZURE_TENANT_ID=
    # @type=azureClientId
    AZURE_CLIENT_ID=
    # @type=azureClientSecret @internal
    AZURE_CLIENT_SECRET=
  `;
}

const spInjectValues = {
  AZURE_TENANT_ID: TENANT_ID,
  AZURE_CLIENT_ID: CLIENT_ID,
  AZURE_CLIENT_SECRET: CLIENT_SECRET,
};

describe('azureAppConfig()', () => {
  test('loads an unlabeled setting using the config item key verbatim', async () => {
    const fake = await startFakeAzure({ settings: [{ key: 'DATABASE_URL', value: 'postgres://example' }] });

    await pluginTest({
      injectValues: { AZURE_APPCONFIG_CONNECTION_STRING: fake.connectionString },
      schema: outdent`
        ${connectionStringSchema()}
        DATABASE_URL=azureAppConfig()
      `,
      expectValues: { DATABASE_URL: 'postgres://example' },
    })();

    const kvRequests = fake.requests.filter((r) => r.pathname === '/kv/DATABASE_URL');
    expect(kvRequests).toHaveLength(1);
    expect(kvRequests[0].searchParams.get('label')).toBeNull();
    expect(kvRequests[0].searchParams.get('api-version')).toBe('2023-11-01');
  });

  test('authenticates with an HMAC-SHA256 signed request when using a connection string', async () => {
    const fake = await startFakeAzure({ settings: [{ key: 'API_HOST', value: 'api.example.com' }] });

    await pluginTest({
      injectValues: { AZURE_APPCONFIG_CONNECTION_STRING: fake.connectionString },
      schema: outdent`
        ${connectionStringSchema()}
        API_HOST=azureAppConfig()
      `,
      expectValues: { API_HOST: 'api.example.com' },
    })();

    // the fake server rejects any request whose signature does not verify, so a
    // successful resolve plus an hmac auth mode means the signing path is correct
    expect(fake.requests.map((r) => r.authMode)).toEqual(['hmac']);
  });

  test('rejects an invalid connection string signature', async () => {
    const fake = await startFakeAzure({ settings: [{ key: 'API_HOST', value: 'api.example.com' }] });
    const badConnectionString = fake.connectionString.replace(ACCESS_KEY_SECRET, Buffer.alloc(32, 9).toString('base64'));

    await pluginTest({
      injectValues: { AZURE_APPCONFIG_CONNECTION_STRING: badConnectionString },
      schema: outdent`
        ${connectionStringSchema()}
        API_HOST=azureAppConfig()
      `,
      expectValues: { API_HOST: Error },
    })();
  });

  test('loads a setting with an explicit key and label', async () => {
    const fake = await startFakeAzure({
      settings: [
        { key: 'services:api:url', value: 'https://dev.example.com' },
        { key: 'services:api:url', label: 'production', value: 'https://api.example.com' },
      ],
    });

    await pluginTest({
      injectValues: { AZURE_APPCONFIG_CONNECTION_STRING: fake.connectionString },
      schema: outdent`
        ${connectionStringSchema()}
        API_URL=azureAppConfig("services:api:url", label=production)
      `,
      expectValues: { API_URL: 'https://api.example.com' },
    })();

    const kvRequest = fake.requests.find((r) => r.pathname.startsWith('/kv/'));
    expect(kvRequest?.pathname).toBe('/kv/services%3Aapi%3Aurl');
    expect(kvRequest?.searchParams.get('label')).toBe('production');
  });

  test('uses defaultLabel unless label= overrides it', async () => {
    const fake = await startFakeAzure({
      settings: [
        { key: 'FEATURE_X', value: 'unlabeled' },
        { key: 'FEATURE_X', label: 'staging', value: 'staging-value' },
        { key: 'FEATURE_X', label: 'production', value: 'production-value' },
      ],
    });

    await pluginTest({
      injectValues: { AZURE_APPCONFIG_CONNECTION_STRING: fake.connectionString },
      schema: outdent`
        ${connectionStringSchema(', defaultLabel=staging')}
        FEATURE_X=azureAppConfig()
        FEATURE_X_PROD=azureAppConfig("FEATURE_X", label=production)
        FEATURE_X_UNLABELED=azureAppConfig("FEATURE_X", label="")
      `,
      expectValues: {
        FEATURE_X: 'staging-value',
        FEATURE_X_PROD: 'production-value',
        FEATURE_X_UNLABELED: 'unlabeled',
      },
    })();
  });

  test('reports a missing setting', async () => {
    const fake = await startFakeAzure();

    await pluginTest({
      injectValues: { AZURE_APPCONFIG_CONNECTION_STRING: fake.connectionString },
      schema: outdent`
        ${connectionStringSchema()}
        MISSING=azureAppConfig()
      `,
      expectValues: { MISSING: Error },
    })();
  });

  test('returns feature flags as their JSON string', async () => {
    const flag = JSON.stringify({ id: 'beta', enabled: true, conditions: { client_filters: [] } });
    const fake = await startFakeAzure({
      settings: [
        {
          key: '.appconfig.featureflag/beta',
          value: flag,
          contentType: 'application/vnd.microsoft.appconfig.ff+json;charset=utf-8',
        },
      ],
    });

    await pluginTest({
      injectValues: { AZURE_APPCONFIG_CONNECTION_STRING: fake.connectionString },
      schema: outdent`
        ${connectionStringSchema()}
        BETA_FLAG=azureAppConfig(".appconfig.featureflag/beta")
      `,
      expectValues: { BETA_FLAG: flag },
    })();
  });

  test('authenticates with a service principal using the azconfig.io scope', async () => {
    const fake = await startFakeAzure({ settings: [{ key: 'API_HOST', value: 'api.example.com' }] });

    await pluginTest({
      injectValues: spInjectValues,
      schema: outdent`
        ${servicePrincipalSchema(fake, `,\n#   appConfigEndpoint="${fake.url}/"`)}
        API_HOST=azureAppConfig()
      `,
      expectValues: { API_HOST: 'api.example.com' },
    })();

    const tokenRequests = fake.requests.filter((r) => r.pathname.endsWith('/oauth2/v2.0/token'));
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].pathname).toBe(`/${TENANT_ID}/oauth2/v2.0/token`);
    expect(tokenRequests[0].scope).toBe('https://azconfig.io/.default');
    expect(fake.requests.find((r) => r.pathname === '/kv/API_HOST')?.authMode).toBe('bearer');
  });

  test('dereferences Key Vault references using a vault-scoped token', async () => {
    // one fake stands in for the vault (and the token endpoint), another for the store
    const vault = await startFakeAzure({ vaultSecrets: { 'db-password': 'super-secret' } });
    const store = await startFakeAzure({
      settings: [
        {
          key: 'DB_PASSWORD',
          value: JSON.stringify({ uri: `${vault.url}/secrets/db-password` }),
          contentType: 'application/vnd.microsoft.appconfig.keyvaultref+json;charset=utf-8',
        },
      ],
    });

    await pluginTest({
      injectValues: spInjectValues,
      schema: outdent`
        ${servicePrincipalSchema(vault, `,\n#   appConfigEndpoint="${store.url}",\n#   vaultUrl="${vault.url}"`)}
        # @sensitive
        DB_PASSWORD=azureAppConfig()
      `,
      expectValues: { DB_PASSWORD: 'super-secret' },
    })();

    const scopes = vault.requests.filter((r) => r.scope).map((r) => r.scope).sort();
    expect(scopes).toEqual(['https://azconfig.io/.default', 'https://vault.azure.net/.default']);
    expect(vault.requests.some((r) => r.pathname === '/secrets/db-password' && r.authMode === 'bearer')).toBe(true);
  });

  test('refuses Key Vault references that point outside the configured vault or cloud suffix', async () => {
    const vault = await startFakeAzure({ vaultSecrets: { 'db-password': 'super-secret' } });
    // a second server plays the attacker-controlled origin named by the reference
    const attacker = await startFakeAzure({ vaultSecrets: { 'db-password': 'stolen' } });
    const store = await startFakeAzure({
      settings: [
        {
          key: 'OTHER_ORIGIN',
          value: JSON.stringify({ uri: `${attacker.url}/secrets/db-password` }),
          contentType: 'application/vnd.microsoft.appconfig.keyvaultref+json',
        },
        {
          key: 'PLAIN_HTTP_PUBLIC',
          value: JSON.stringify({ uri: 'http://my-vault.vault.azure.net/secrets/db-password' }),
          contentType: 'application/vnd.microsoft.appconfig.keyvaultref+json',
        },
        {
          key: 'LOOKALIKE_HOST',
          value: JSON.stringify({ uri: 'https://my-vault.vault.azure.net.evil.example/secrets/db-password' }),
          contentType: 'application/vnd.microsoft.appconfig.keyvaultref+json',
        },
        {
          key: 'TRUSTED',
          value: JSON.stringify({ uri: `${vault.url}/secrets/db-password` }),
          contentType: 'application/vnd.microsoft.appconfig.keyvaultref+json',
        },
      ],
    });

    await pluginTest({
      injectValues: spInjectValues,
      schema: outdent`
        ${servicePrincipalSchema(vault, `,\n#   appConfigEndpoint="${store.url}",\n#   vaultUrl="${vault.url}"`)}
        OTHER_ORIGIN=azureAppConfig()
        PLAIN_HTTP_PUBLIC=azureAppConfig()
        LOOKALIKE_HOST=azureAppConfig()
        TRUSTED=azureAppConfig()
      `,
      expectValues: {
        OTHER_ORIGIN: Error,
        PLAIN_HTTP_PUBLIC: Error,
        LOOKALIKE_HOST: Error,
        TRUSTED: 'super-secret',
      },
    })();

    // the attacker origin never sees a request, let alone a bearer token
    expect(attacker.requests).toHaveLength(0);
  });

  test('uses sovereign-cloud token audiences when cloud= is set', async () => {
    const fake = await startFakeAzure({
      settings: [{ key: 'API_HOST', value: 'api.example.us' }],
      vaultSecrets: { 'database-url': 'postgres://gov' },
    });

    await pluginTest({
      injectValues: spInjectValues,
      schema: outdent`
        ${servicePrincipalSchema(fake, `,\n#   cloud=usgov,\n#   appConfigEndpoint="${fake.url}",\n#   vaultUrl="${fake.url}"`)}
        API_HOST=azureAppConfig()
        # @sensitive
        DATABASE_URL=azureSecret()
      `,
      expectValues: { API_HOST: 'api.example.us', DATABASE_URL: 'postgres://gov' },
    })();

    const scopes = fake.requests.filter((r) => r.scope).map((r) => r.scope).sort();
    expect(scopes).toEqual(['https://azconfig.azure.us/.default', 'https://vault.usgovcloudapi.net/.default']);
  });

  test('errors when the instance has no App Configuration store configured', async () => {
    const fake = await startFakeAzure();

    await pluginTest({
      injectValues: spInjectValues,
      schema: outdent`
        ${servicePrincipalSchema(fake, `,\n#   vaultUrl="${fake.url}"`)}
        SETTING=azureAppConfig()
      `,
      expectValues: { SETTING: Error },
    })();
  });
});

describe('azureAppConfigBulk()', () => {
  test('bulk loads filtered settings, trims a key prefix, and follows pagination', async () => {
    const fake = await startFakeAzure({
      pageSize: 1,
      settings: [
        { key: 'app:DATABASE_URL', label: 'production', value: 'postgres://prod' },
        { key: 'app:API_HOST', label: 'production', value: 'api.example.com' },
        { key: 'app:API_HOST', label: 'staging', value: 'staging.example.com' },
        { key: 'other:IGNORED', label: 'production', value: 'ignored' },
      ],
    });

    await pluginTest({
      injectValues: { AZURE_APPCONFIG_CONNECTION_STRING: fake.connectionString },
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initAzure(appConfigConnectionString=$AZURE_APPCONFIG_CONNECTION_STRING)
        # @setValuesBulk(azureAppConfigBulk(keyFilter="app:*", labelFilter=production, trimKeyPrefix="app:"), format=json)
        # ---
        # @type=azureAppConfigConnectionString
        AZURE_APPCONFIG_CONNECTION_STRING=
        DATABASE_URL=
        API_HOST=
      `,
      expectValues: {
        DATABASE_URL: 'postgres://prod',
        API_HOST: 'api.example.com',
      },
    })();

    const listRequests = fake.requests.filter((r) => r.pathname === '/kv');
    expect(listRequests).toHaveLength(2);
    expect(listRequests[0].searchParams.get('key')).toBe('app:*');
    expect(listRequests[0].searchParams.get('label')).toBe('production');
    expect(listRequests[1].searchParams.get('after')).toBe('1');
    expect(listRequests.every((r) => r.authMode === 'hmac')).toBe(true);
  });

  test('defaults to unlabeled settings (NUL label filter) and every key', async () => {
    const fake = await startFakeAzure({
      settings: [
        { key: 'UNLABELED', value: 'yes' },
        { key: 'LABELED', label: 'production', value: 'no' },
      ],
    });

    await pluginTest({
      injectValues: { AZURE_APPCONFIG_CONNECTION_STRING: fake.connectionString },
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initAzure(appConfigConnectionString=$AZURE_APPCONFIG_CONNECTION_STRING)
        # @setValuesBulk(azureAppConfigBulk(), format=json)
        # ---
        # @type=azureAppConfigConnectionString
        AZURE_APPCONFIG_CONNECTION_STRING=
        UNLABELED=
        # @optional
        LABELED=
      `,
      expectValues: { UNLABELED: 'yes', LABELED: undefined },
    })();

    const listRequest = fake.requests.find((r) => r.pathname === '/kv');
    expect(listRequest?.searchParams.get('key')).toBe('*');
    expect(listRequest?.searchParams.get('label')).toBe('\0');
  });

  test('escapes defaultLabel when it becomes the bulk label filter', async () => {
    const fake = await startFakeAzure({
      settings: [
        { key: 'A', label: 'release*candidate', value: 'literal' },
        { key: 'B', label: 'release-1-candidate', value: 'wildcard-only' },
      ],
    });

    await pluginTest({
      injectValues: { AZURE_APPCONFIG_CONNECTION_STRING: fake.connectionString },
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initAzure(appConfigConnectionString=$AZURE_APPCONFIG_CONNECTION_STRING, defaultLabel="release*candidate")
        # @setValuesBulk(azureAppConfigBulk(), format=json)
        # ---
        # @type=azureAppConfigConnectionString
        AZURE_APPCONFIG_CONNECTION_STRING=
        A=
        # @optional
        B=
      `,
      expectValues: { A: 'literal', B: undefined },
    })();

    const listRequest = fake.requests.find((r) => r.pathname === '/kv');
    expect(listRequest?.searchParams.get('label')).toBe('release\\*candidate');
  });

  test('dereferences Key Vault references in bulk results', async () => {
    const vault = await startFakeAzure({ vaultSecrets: { 'api-key': 'kv-api-key' } });
    const store = await startFakeAzure({
      settings: [
        { key: 'PLAIN', value: 'plain-value' },
        {
          key: 'API_KEY',
          value: JSON.stringify({ uri: `${vault.url}/secrets/api-key/abc123` }),
          contentType: 'application/vnd.microsoft.appconfig.keyvaultref+json',
        },
      ],
    });

    await pluginTest({
      injectValues: spInjectValues,
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initAzure(
        #   authorityHost="${vault.url}",
        #   appConfigEndpoint="${store.url}",
        #   vaultUrl="${vault.url}",
        #   tenantId=$AZURE_TENANT_ID,
        #   clientId=$AZURE_CLIENT_ID,
        #   clientSecret=$AZURE_CLIENT_SECRET
        # )
        # @setValuesBulk(azureAppConfigBulk(), format=json)
        # ---
        # @type=azureTenantId
        AZURE_TENANT_ID=
        # @type=azureClientId
        AZURE_CLIENT_ID=
        # @type=azureClientSecret @internal
        AZURE_CLIENT_SECRET=
        PLAIN=
        # @sensitive
        API_KEY=
      `,
      expectValues: { PLAIN: 'plain-value', API_KEY: 'kv-api-key' },
    })();

    expect(vault.requests.some((r) => r.pathname === '/secrets/api-key/abc123')).toBe(true);
  });
});

describe('azureSecret()', () => {
  test('fetches a Key Vault secret with a vault-scoped service principal token', async () => {
    const fake = await startFakeAzure({ vaultSecrets: { 'database-url': 'postgres://vault' } });

    await pluginTest({
      injectValues: spInjectValues,
      schema: outdent`
        ${servicePrincipalSchema(fake, `,\n#   vaultUrl="${fake.url}/"`)}
        # @sensitive
        DATABASE_URL=azureSecret()
      `,
      expectValues: { DATABASE_URL: 'postgres://vault' },
    })();

    const tokenRequest = fake.requests.find((r) => r.pathname.endsWith('/oauth2/v2.0/token'));
    expect(tokenRequest?.scope).toBe('https://vault.azure.net/.default');
    expect(fake.requests.some((r) => r.pathname === '/secrets/database-url')).toBe(true);
  });

  test('errors when the instance has no vaultUrl configured', async () => {
    const fake = await startFakeAzure({ settings: [{ key: 'X', value: 'y' }] });

    await pluginTest({
      injectValues: { AZURE_APPCONFIG_CONNECTION_STRING: fake.connectionString },
      schema: outdent`
        ${connectionStringSchema()}
        SECRET=azureSecret("some-secret")
      `,
      expectValues: { SECRET: Error },
    })();
  });
});

describe('@initAzure()', () => {
  test('requires at least one service to be configured', async () => {
    await pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initAzure(tenantId="${TENANT_ID}")
        # ---
        FOO=bar
      `,
      expectSchemaError: true,
    })();
  });
});
