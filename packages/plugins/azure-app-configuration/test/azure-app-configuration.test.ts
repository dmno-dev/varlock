import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach, describe, expect, test,
} from 'vitest';
import outdent from 'outdent';
import { pluginTest } from 'varlock/test-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..');
const APP_CONFIG_SECRET = Buffer.alloc(32, 1).toString('base64');

type Setting = { key: string; value: string; label?: string };
type FakeAppConfiguration = {
  connectionString: string;
  requests: Array<URL>;
  close: () => Promise<void>;
};

const servers: Array<FakeAppConfiguration> = [];

async function startFakeAppConfiguration(settings: Array<Setting>): Promise<FakeAppConfiguration> {
  const requests: Array<URL> = [];
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push(requestUrl);

    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, {
        'content-type': 'application/vnd.microsoft.appconfig.kv+json',
        etag: '"test-etag"',
      });
      res.end(JSON.stringify(body));
    };

    if (requestUrl.pathname.startsWith('/kv/')) {
      const key = decodeURIComponent(requestUrl.pathname.slice('/kv/'.length));
      const requestedLabel = requestUrl.searchParams.get('label') ?? undefined;
      const setting = settings.find((candidate) => (
        candidate.key === key && candidate.label === requestedLabel
      ));
      if (!setting) {
        sendJson(404, { type: 'https://azconfig.io/errors/key-not-found', title: 'Key not found' });
        return;
      }
      sendJson(200, {
        etag: 'test-etag',
        key: setting.key,
        label: setting.label,
        value: setting.value,
        locked: false,
      });
      return;
    }

    if (requestUrl.pathname === '/kv') {
      const keyFilter = requestUrl.searchParams.get('key') || '*';
      const rawLabelFilter = requestUrl.searchParams.get('label') ?? undefined;
      const labelFilter = rawLabelFilter === '\0' ? undefined : rawLabelFilter;
      const prefix = keyFilter.endsWith('*') ? keyFilter.slice(0, -1) : undefined;
      const matching = settings.filter((setting) => {
        const keyMatches = prefix !== undefined ? setting.key.startsWith(prefix) : setting.key === keyFilter;
        return keyMatches && (labelFilter === undefined || setting.label === labelFilter);
      });
      sendJson(200, {
        items: matching.map((setting) => ({
          etag: 'test-etag',
          key: setting.key,
          label: setting.label,
          value: setting.value,
          locked: false,
        })),
      });
      return;
    }

    sendJson(404, { title: 'Not found' });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const fake = {
    connectionString: `Endpoint=http://127.0.0.1:${address.port};Id=test-id;Secret=${APP_CONFIG_SECRET}`,
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

function runPluginTest(
  connectionString: string,
  schema: string,
  expectValues: NonNullable<Parameters<typeof pluginTest>[0]['expectValues']>,
) {
  return pluginTest({
    injectValues: { AZURE_APPCONFIG_CONNECTION_STRING: connectionString },
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @initAzureAppConfiguration(connectionString=$AZURE_APPCONFIG_CONNECTION_STRING, allowInsecureConnection=true)
      # ---
      # @type=azureAppConfigurationConnectionString
      AZURE_APPCONFIG_CONNECTION_STRING=
      ${schema}
    `,
    expectValues,
  })();
}

describe('azure app configuration plugin', () => {
  test('loads an unlabeled setting using the config item key', async () => {
    const api = await startFakeAppConfiguration([{ key: 'DATABASE_URL', value: 'postgres://example' }]);

    await runPluginTest(
      api.connectionString,
      'DATABASE_URL=azureAppConfig()',
      { DATABASE_URL: 'postgres://example' },
    );

    expect(api.requests.some((request) => request.pathname === '/kv/DATABASE_URL')).toBe(true);
  });

  test('loads a setting with an explicit key and label', async () => {
    const api = await startFakeAppConfiguration([{ key: 'services:api:url', label: 'production', value: 'https://api.example.com' }]);

    await runPluginTest(
      api.connectionString,
      'API_URL=azureAppConfig("services:api:url", label=production)',
      { API_URL: 'https://api.example.com' },
    );

    expect(api.requests.some((request) => request.searchParams.get('label') === 'production')).toBe(true);
  });

  test('bulk loads filtered settings and trims a key prefix', async () => {
    const api = await startFakeAppConfiguration([
      { key: 'app:DATABASE_URL', label: 'production', value: 'postgres://prod' },
      { key: 'app:API_HOST', label: 'production', value: 'api.example.com' },
      { key: 'other:IGNORED', label: 'production', value: 'ignored' },
    ]);

    await pluginTest({
      injectValues: { AZURE_APPCONFIG_CONNECTION_STRING: api.connectionString },
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initAzureAppConfiguration(connectionString=$AZURE_APPCONFIG_CONNECTION_STRING, allowInsecureConnection=true)
        # @setValuesBulk(azureAppConfigBulk(keyFilter="app:*", labelFilter=production, trimKeyPrefix="app:"), format=json)
        # ---
        # @type=azureAppConfigurationConnectionString
        AZURE_APPCONFIG_CONNECTION_STRING=
        DATABASE_URL=
        API_HOST=
      `,
      expectValues: {
        DATABASE_URL: 'postgres://prod',
        API_HOST: 'api.example.com',
      },
    })();
  });

  test('reports a missing setting', async () => {
    const api = await startFakeAppConfiguration([]);

    await runPluginTest(
      api.connectionString,
      'MISSING=azureAppConfig()',
      { MISSING: Error },
    );
  });
});
