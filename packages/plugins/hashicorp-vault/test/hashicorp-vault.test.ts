import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describe, expect, test,
} from 'vitest';
import outdent from 'outdent';
import { pluginTest } from 'varlock/test-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..');

type FakeVaultApi = {
  url: string;
  requests: Array<{ method?: string; url?: string; vaultToken?: string }>;
  close: () => Promise<void>;
};

async function startFakeVaultApi(opts?: {
  clientToken?: string;
  leaseDuration?: number;
}): Promise<FakeVaultApi> {
  const clientToken = opts?.clientToken ?? 'hvs.fake-client-token';
  const leaseDuration = opts?.leaseDuration ?? 3600;
  const requests: FakeVaultApi['requests'] = [];

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({
      method: req.method,
      url: requestUrl.pathname,
      vaultToken: req.headers['x-vault-token'] as string | undefined,
    });

    const sendJson = (statusCode: number, body: Record<string, unknown>) => {
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && requestUrl.pathname === '/v1/auth/approle/login') {
      sendJson(200, {
        auth: {
          client_token: clientToken,
          lease_duration: leaseDuration,
        },
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/v1/auth/jwt/login') {
      sendJson(200, {
        auth: {
          client_token: clientToken,
          lease_duration: leaseDuration,
        },
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/v1/auth/gitlab/login') {
      sendJson(200, {
        auth: {
          client_token: clientToken,
          lease_duration: leaseDuration,
        },
      });
      return;
    }

    sendJson(404, {
      errors: [`${requestUrl.pathname} not found`],
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

describe('hashicorp-vault vaultToken()', () => {
  test('returns an explicitly configured token', async () => {
    await pluginTest({
      injectValues: {
        VAULT_ADDR: 'http://127.0.0.1:8200',
        VAULT_TOKEN: 'hvs.explicit-token',
      },
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initHcpVault(url=$VAULT_ADDR, token=$VAULT_TOKEN)
        # ---
        VAULT_ADDR=
        # @type=vaultToken
        VAULT_TOKEN=
        # @sensitive
        BAO_TOKEN=vaultToken()
      `,
      expectValues: { BAO_TOKEN: 'hvs.explicit-token' },
      expectSensitive: { BAO_TOKEN: true },
    })();
  });

  test('returns AppRole client token and reuses the cached login', async () => {
    const api = await startFakeVaultApi({ clientToken: 'hvs.approle-token' });
    try {
      await pluginTest({
        injectValues: {
          VAULT_ADDR: api.url,
          VAULT_ROLE_ID: 'role-id',
          VAULT_SECRET_ID: 'secret-id',
        },
        schema: outdent`
          # @plugin(${PLUGIN_PATH})
          # @initHcpVault(url=$VAULT_ADDR, roleId=$VAULT_ROLE_ID, secretId=$VAULT_SECRET_ID)
          # ---
          VAULT_ADDR=
          VAULT_ROLE_ID=
          # @sensitive @internal
          VAULT_SECRET_ID=
          # @sensitive
          TOKEN_A=vaultToken()
          # @sensitive
          TOKEN_B=vaultToken()
        `,
        expectValues: {
          TOKEN_A: 'hvs.approle-token',
          TOKEN_B: 'hvs.approle-token',
        },
      })();

      const loginRequests = api.requests.filter((r) => r.url === '/v1/auth/approle/login');
      expect(loginRequests).toHaveLength(1);
    } finally {
      await api.close();
    }
  });

  test('returns JWT client token', async () => {
    const api = await startFakeVaultApi({ clientToken: 'hvs.jwt-token' });
    try {
      await pluginTest({
        injectValues: {
          VAULT_ADDR: api.url,
          GITLAB_OIDC: 'fake-oidc-jwt',
        },
        schema: outdent`
          # @plugin(${PLUGIN_PATH})
          # @initHcpVault(url=$VAULT_ADDR, jwtRole=ci-role, jwtAuthPath="gitlab", oidcToken=$GITLAB_OIDC)
          # ---
          VAULT_ADDR=
          # @sensitive @internal
          GITLAB_OIDC=
          # @sensitive
          BAO_TOKEN=vaultToken()
        `,
        expectValues: { BAO_TOKEN: 'hvs.jwt-token' },
      })();

      expect(api.requests).toContainEqual(expect.objectContaining({
        method: 'POST',
        url: '/v1/auth/gitlab/login',
      }));
    } finally {
      await api.close();
    }
  });

  test('selects a named instance by id', async () => {
    await pluginTest({
      injectValues: {
        VAULT_ADDR: 'http://127.0.0.1:8200',
        DEV_TOKEN: 'hvs.dev-token',
        PROD_TOKEN: 'hvs.prod-token',
      },
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initHcpVault(id=dev, url=$VAULT_ADDR, token=$DEV_TOKEN)
        # @initHcpVault(id=prod, url=$VAULT_ADDR, token=$PROD_TOKEN)
        # ---
        VAULT_ADDR=
        # @type=vaultToken
        DEV_TOKEN=
        # @type=vaultToken
        PROD_TOKEN=
        # @sensitive
        DEV_CLIENT=vaultToken(dev)
        # @sensitive
        PROD_CLIENT=vaultToken(prod)
      `,
      expectValues: {
        DEV_CLIENT: 'hvs.dev-token',
        PROD_CLIENT: 'hvs.prod-token',
      },
    })();
  });

  test('unknown instance id produces an error', pluginTest({
    injectValues: {
      VAULT_ADDR: 'http://127.0.0.1:8200',
      VAULT_TOKEN: 'hvs.explicit-token',
    },
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @initHcpVault(url=$VAULT_ADDR, token=$VAULT_TOKEN)
      # ---
      VAULT_ADDR=
      # @type=vaultToken
      VAULT_TOKEN=
      BAO_TOKEN=vaultToken(missing)
    `,
    expectValues: { BAO_TOKEN: Error },
  }));

  test('no init produces an error', pluginTest({
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # ---
      BAO_TOKEN=vaultToken()
    `,
    expectValues: { BAO_TOKEN: Error },
  }));

  test('implies sensitive even when defaultSensitive is false', pluginTest({
    injectValues: {
      VAULT_ADDR: 'http://127.0.0.1:8200',
      VAULT_TOKEN: 'hvs.explicit-token',
    },
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @defaultSensitive=false
      # @initHcpVault(url=$VAULT_ADDR, token=$VAULT_TOKEN)
      # ---
      VAULT_ADDR=
      # @type=vaultToken
      VAULT_TOKEN=
      BAO_TOKEN=vaultToken()
    `,
    expectSensitive: { BAO_TOKEN: true },
  }));
});
