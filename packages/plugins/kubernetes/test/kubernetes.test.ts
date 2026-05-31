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

type FakeKubeApi = {
  url: string;
  requests: Array<{ method?: string; url?: string; authorization?: string }>;
  close: () => Promise<void>;
};

function b64(value: string): string {
  return Buffer.from(value).toString('base64');
}

async function startFakeKubeApi(): Promise<FakeKubeApi> {
  const requests: FakeKubeApi['requests'] = [];

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({
      method: req.method,
      url: requestUrl.pathname,
      authorization: req.headers.authorization,
    });

    const sendJson = (statusCode: number, body: Record<string, unknown>) => {
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.headers.authorization !== 'Bearer test-token') {
      sendJson(401, {
        kind: 'Status',
        status: 'Failure',
        reason: 'Unauthorized',
        message: 'missing test token',
      });
      return;
    }

    if (requestUrl.pathname === '/api/v1/namespaces/test/secrets/app-secrets') {
      sendJson(200, {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'app-secrets', namespace: 'test' },
        data: {
          DATABASE_URL: b64('postgres://example'),
          API_KEY: b64('secret-api-key'),
        },
      });
      return;
    }

    if (requestUrl.pathname === '/api/v1/namespaces/test/configmaps/app-config') {
      sendJson(200, {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'app-config', namespace: 'test' },
        data: {
          PUBLIC_API_HOST: 'api.example.com',
        },
        binaryData: {
          CERT: b64('cert-data'),
        },
      });
      return;
    }

    if (requestUrl.pathname === '/api/v1/namespaces/prod/secrets/app-secrets') {
      sendJson(200, {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'app-secrets', namespace: 'prod' },
        data: {
          DATABASE_URL: b64('postgres://prod'),
        },
      });
      return;
    }

    sendJson(404, {
      kind: 'Status',
      status: 'Failure',
      reason: 'NotFound',
      message: `${requestUrl.pathname} not found`,
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

type KubernetesTestOpts = {
  schema: string;
  header?: string;
  initParams?: string;
} & Omit<Parameters<typeof pluginTest>[0], 'schema'>;

async function runKubernetesTest(api: FakeKubeApi, opts: KubernetesTestOpts) {
  const {
    schema,
    header = '',
    initParams = '',
    injectValues,
    ...rest
  } = opts;

  const extraParams = initParams ? `, ${initParams}` : '';
  await pluginTest({
    ...rest,
    injectValues: {
      K8S_SERVER: api.url,
      K8S_TOKEN: 'test-token',
      ...injectValues,
    },
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @initKubernetes(namespace=test, clusterServer=$K8S_SERVER, token=$K8S_TOKEN, skipTlsVerify=true${extraParams})
      ${header}
      # ---
      K8S_SERVER=
      # @type=kubernetesBearerToken
      K8S_TOKEN=
      ${schema}
    `,
  })();
}

describe('kubernetes plugin', () => {
  test('reads a Secret key using the config item name', async () => {
    const api = await startFakeKubeApi();
    try {
      await runKubernetesTest(api, {
        schema: 'DATABASE_URL=k8sSecret(app-secrets)',
        expectValues: { DATABASE_URL: 'postgres://example' },
      });

      expect(api.requests).toContainEqual(expect.objectContaining({
        url: '/api/v1/namespaces/test/secrets/app-secrets',
        authorization: 'Bearer test-token',
      }));
    } finally {
      await api.close();
    }
  });

  test('reads explicit Secret and ConfigMap keys', async () => {
    const api = await startFakeKubeApi();
    try {
      await runKubernetesTest(api, {
        schema: outdent`
          SECRET_KEY=k8sSecret(app-secrets, API_KEY)
          API_HOST=k8sConfigMap(app-config, PUBLIC_API_HOST)
          CERT=k8sConfigMap(app-config, CERT)
        `,
        expectValues: {
          SECRET_KEY: 'secret-api-key',
          API_HOST: 'api.example.com',
          CERT: 'cert-data',
        },
      });
    } finally {
      await api.close();
    }
  });

  test('bulk loads Secret and ConfigMap data', async () => {
    const api = await startFakeKubeApi();
    try {
      await runKubernetesTest(api, {
        header: outdent`
          # @setValuesBulk(k8sSecretBulk(app-secrets), format=json)
          # @setValuesBulk(k8sConfigMapBulk(app-config), format=json)
        `,
        schema: outdent`
          DATABASE_URL=
          API_KEY=
          PUBLIC_API_HOST=
          CERT=
        `,
        expectValues: {
          DATABASE_URL: 'postgres://example',
          API_KEY: 'secret-api-key',
          PUBLIC_API_HOST: 'api.example.com',
          CERT: 'cert-data',
        },
      });
    } finally {
      await api.close();
    }
  });

  test('supports named instances', async () => {
    const api = await startFakeKubeApi();
    try {
      await pluginTest({
        injectValues: {
          K8S_SERVER: api.url,
          K8S_TOKEN: 'test-token',
        },
        schema: outdent`
          # @plugin(${PLUGIN_PATH})
          # @initKubernetes(id=dev, namespace=test, clusterServer=$K8S_SERVER, token=$K8S_TOKEN, skipTlsVerify=true)
          # @initKubernetes(id=prod, namespace=prod, clusterServer=$K8S_SERVER, token=$K8S_TOKEN, skipTlsVerify=true)
          # ---
          K8S_SERVER=
          # @type=kubernetesBearerToken
          K8S_TOKEN=
          DEV_DATABASE_URL=k8sSecret(dev, app-secrets, DATABASE_URL)
          PROD_DATABASE_URL=k8sSecret(prod, app-secrets, DATABASE_URL)
        `,
        expectValues: {
          DEV_DATABASE_URL: 'postgres://example',
          PROD_DATABASE_URL: 'postgres://prod',
        },
      })();
    } finally {
      await api.close();
    }
  });

  test('reports missing keys unless allowMissing is enabled', async () => {
    const api = await startFakeKubeApi();
    try {
      await runKubernetesTest(api, {
        schema: 'MISSING=k8sSecret(app-secrets, NOT_THERE)',
        expectValues: { MISSING: Error },
      });

      await runKubernetesTest(api, {
        initParams: 'allowMissing=true',
        schema: outdent`
          # @required=false
          MISSING=k8sSecret(app-secrets, NOT_THERE)
        `,
        expectValues: { MISSING: undefined },
      });
    } finally {
      await api.close();
    }
  });

  test('validates init and token schema', async () => {
    await pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKubernetes(id=$DYNAMIC_ID)
        # ---
        DYNAMIC_ID=prod
      `,
      expectSchemaError: true,
    })();

    await pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKubernetes(clusterServer="https://127.0.0.1", token="valid-token")
        # ---
        # @type=kubernetesBearerToken
        K8S_TOKEN=
      `,
      expectValues: { K8S_TOKEN: Error },
      expectSensitive: { K8S_TOKEN: true },
    })();
  });
});
