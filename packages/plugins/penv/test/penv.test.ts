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
const TOKEN = 'pck_test_token';

type Env = { keys: Array<{ path?: string, name: string, value?: string }> };
type FakePenv = { url: string, requests: Array<{ pathname: string, auth?: string }>, close: () => Promise<void> };

const servers: Array<FakePenv> = [];

/** A fake penv.cloud: GET /api/v1/envs/{org}/{project}/{environment}, bearer auth. */
async function startFakePenv(envs: Record<string, Env>): Promise<FakePenv> {
  const requests: FakePenv['requests'] = [];
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url!, 'http://localhost');
    requests.push({ pathname, auth: req.headers.authorization });
    if (pathname.startsWith('/redirect/')) {
      res.writeHead(302, { location: 'http://evil.test/' });
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401);
      res.end('{"error":"unauthorized"}');
      return;
    }
    const match = pathname.match(/^\/api\/v1\/envs\/(.+)$/);
    const body = match && envs[decodeURIComponent(match[1])];
    if (!body) {
      res.writeHead(404);
      res.end('{"error":"not_found"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const fake = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
  servers.push(fake);
  return fake;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const ENVS: Record<string, Env> = {
  'acme/api/development': {
    keys: [
      { path: '', name: 'DATABASE_URL', value: 'postgres://dev' },
      { path: '', name: 'NO_VALUE' },
    ],
  },
  'acme/api/production': {
    keys: [
      { path: '', name: 'DATABASE_URL', value: 'postgres://prod' },
      { path: '', name: 'STRIPE_KEY', value: 'sk_live_test' },
    ],
  },
  'acme/billing/production': { keys: [{ path: '', name: 'API_TOKEN', value: 'billing-token' }] },
  'other/shared/production': { keys: [{ path: '', name: 'SENTRY_DSN', value: 'https://sentry' }] },
};

function header(url: string, extra = '') {
  return outdent`
    # @plugin(${PLUGIN_PATH})
    # @penv=acme/api
    # @initPenv(environment=$APP_ENV, token=$PENV_TOKEN, url="${url}"${extra})
    # @currentEnv=$APP_ENV
    # ---
    # @type=enum(development, production) @sensitive=false
    APP_ENV=development
    # @type=penvToken
    PENV_TOKEN=
  `;
}

describe('penv plugin', () => {
  test('penv() reads the item key in the current environment', async () => {
    const fake = await startFakePenv(ENVS);
    await pluginTest({
      injectValues: { PENV_TOKEN: TOKEN },
      schema: `${header(fake.url)}\nDATABASE_URL=penv()`,
      expectValues: { DATABASE_URL: 'postgres://dev' },
      expectSensitive: { PENV_TOKEN: true },
    })();
  });

  test('@currentEnv picks the environment', async () => {
    const fake = await startFakePenv(ENVS);
    await pluginTest({
      injectValues: { PENV_TOKEN: TOKEN, APP_ENV: 'production' },
      schema: `${header(fake.url)}\nDATABASE_URL=penv()`,
      expectValues: { DATABASE_URL: 'postgres://prod' },
    })();
  });

  test('addresses reach another key, environment, project and org', async () => {
    const fake = await startFakePenv(ENVS);
    await pluginTest({
      injectValues: { PENV_TOKEN: TOKEN },
      schema: outdent`
        ${header(fake.url)}
        STRIPE=penv(production/STRIPE_KEY)
        BILLING=penv(billing/production/API_TOKEN)
        SENTRY=penv(other/shared/production/SENTRY_DSN)
        RENAMED=penv(DATABASE_URL)
      `,
      expectValues: {
        STRIPE: 'sk_live_test', BILLING: 'billing-token', SENTRY: 'https://sentry', RENAMED: 'postgres://dev',
      },
    })();
  });

  test('one request per environment, shared by every item', async () => {
    const fake = await startFakePenv(ENVS);
    await pluginTest({
      injectValues: { PENV_TOKEN: TOKEN },
      schema: outdent`
        ${header(fake.url)}
        A=penv(production/DATABASE_URL)
        B=penv(production/STRIPE_KEY)
        DATABASE_URL=penv()
      `,
      expectValues: { A: 'postgres://prod', B: 'sk_live_test', DATABASE_URL: 'postgres://dev' },
    })();
    expect(fake.requests.map((r) => r.pathname).sort()).toEqual([
      '/api/v1/envs/acme/api/development',
      '/api/v1/envs/acme/api/production',
    ]);
    expect(fake.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  test('penvBulk() fills every item for @setValuesBulk', async () => {
    const fake = await startFakePenv(ENVS);
    await pluginTest({
      injectValues: { PENV_TOKEN: TOKEN },
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @penv=acme/api
        # @initPenv(token=$PENV_TOKEN, url="${fake.url}")
        # @setValuesBulk(penvBulk(production))
        # ---
        # @type=penvToken
        PENV_TOKEN=
        DATABASE_URL=
        STRIPE_KEY=
      `,
      expectValues: { DATABASE_URL: 'postgres://prod', STRIPE_KEY: 'sk_live_test' },
    })();
  });

  test('@penv=penv:org/project reads like org/project', async () => {
    const fake = await startFakePenv(ENVS);
    await pluginTest({
      injectValues: { PENV_TOKEN: TOKEN },
      schema: `${header(fake.url).replace('@penv=acme/api', '@penv=penv:acme/api')}\nDATABASE_URL=penv()`,
      expectValues: { DATABASE_URL: 'postgres://dev' },
    })();
  });

  test('a missing key, a key with no value and a rejected token are errors', async () => {
    const fake = await startFakePenv(ENVS);
    await pluginTest({
      injectValues: { PENV_TOKEN: TOKEN },
      schema: `${header(fake.url)}\nMISSING=penv()\nNO_VALUE=penv()`,
      expectValues: { MISSING: Error, NO_VALUE: Error },
    })();
    await pluginTest({
      injectValues: { PENV_TOKEN: 'pck_wrong' },
      schema: `${header(fake.url)}\nDATABASE_URL=penv()`,
      expectValues: { DATABASE_URL: Error },
    })();
  });

  test('a redirect is refused, not followed', async () => {
    const fake = await startFakePenv(ENVS);
    await pluginTest({
      injectValues: { PENV_TOKEN: TOKEN },
      schema: `${header(`${fake.url}/redirect`)}\nDATABASE_URL=penv()`,
      expectValues: { DATABASE_URL: Error },
    })();
    expect(fake.requests).toHaveLength(1);
  });

  test('plain http to a remote host, and a URL with a user, are refused', async () => {
    for (const url of ['http://example.com', 'https://user:pw@example.com']) {
      await pluginTest({
        injectValues: { PENV_TOKEN: TOKEN },
        schema: `${header(url)}\nDATABASE_URL=penv()`,
        expectSchemaError: true,
      })();
    }
  });

  test('another provider in @penv= is a schema error', async () => {
    await pluginTest({
      injectValues: { PENV_TOKEN: TOKEN },
      schema: `${header('https://penv.cloud').replace('@penv=acme/api', '@penv=doppler:acme/api')}\nDATABASE_URL=penv()`,
      expectSchemaError: true,
    })();
  });
});
