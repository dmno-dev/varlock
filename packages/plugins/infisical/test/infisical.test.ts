import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  afterAll, beforeAll, describe, test,
} from 'vitest';
import outdent from 'outdent';
import { pluginTest } from 'varlock/test-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_TEST_PLUGIN_PATH = path.join(__dirname, '..', 'dist-test');
const SDK_TEST_PLUGIN_CJS = path.join(SDK_TEST_PLUGIN_PATH, 'plugin.cjs');

const sdkMockState = {
  secrets: {} as Record<string, string>,
  secretErrors: {} as Record<string, any>,
  listSecrets: [] as Array<{ secretKey: string; secretValue: string }>,
};

function resetSdkMockState() {
  sdkMockState.secrets = {};
  sdkMockState.secretErrors = {};
  sdkMockState.listSecrets = [];
}

const mockSdkClient = {
  auth: () => ({
    universalAuth: {
      login: async () => undefined,
    },
    accessToken: () => undefined,
  }),
  secrets: () => ({
    async getSecret(opts: { secretName: string }) {
      const { secretName } = opts;
      if (sdkMockState.secretErrors[secretName]) {
        throw sdkMockState.secretErrors[secretName];
      }
      if (!(secretName in sdkMockState.secrets)) {
        const err = new Error('Secret not found');
        (err as any).statusCode = 404;
        throw err;
      }
      return { secretValue: sdkMockState.secrets[secretName] };
    },
    async listSecretsWithImports() {
      return sdkMockState.listSecrets;
    },
  }),
};

const mockSdkExports = {
  InfisicalSDK: class {
    auth() {
      return mockSdkClient.auth();
    }

    secrets() {
      return mockSdkClient.secrets();
    }
  },
};

beforeAll(() => {
  fs.writeFileSync(
    path.join(SDK_TEST_PLUGIN_PATH, 'package.json'),
    JSON.stringify({ exports: { './plugin': './plugin.cjs' } }),
  );

  const testRequire = createRequire(SDK_TEST_PLUGIN_CJS);
  const sdkResolvedPath = testRequire.resolve('@infisical/sdk');
  testRequire.cache[sdkResolvedPath] = {
    id: sdkResolvedPath,
    filename: sdkResolvedPath,
    loaded: true,
    exports: mockSdkExports,
    children: [],
    paths: [],
    path: path.dirname(sdkResolvedPath),
  } as any;
});

afterAll(() => {
  try {
    fs.unlinkSync(path.join(SDK_TEST_PLUGIN_PATH, 'package.json'));
  } catch { /* may not exist */ }
});

type InfisicalTestOpts = {
  mockSecrets?: Record<string, string>;
  mockSecretErrors?: Record<string, any>;
  schema?: string;
  initParams?: string;
  fullSchema?: string;
} & Omit<Parameters<typeof pluginTest>[0], 'schema'>;

function infisicalTest(opts: InfisicalTestOpts) {
  const {
    mockSecrets = {},
    mockSecretErrors = {},
    schema,
    initParams = '',
    fullSchema: fullSchemaOverride,
    ...rest
  } = opts;

  return async () => {
    sdkMockState.secrets = mockSecrets;
    sdkMockState.secretErrors = mockSecretErrors;

    const initLine = `# @initInfisical(projectId=test-project, environment=dev, clientId=$INFISICAL_CLIENT_ID, clientSecret=$INFISICAL_CLIENT_SECRET${initParams ? `, ${initParams}` : ''})`;

    const fullSchema = fullSchemaOverride ?? outdent`
      # @plugin(${SDK_TEST_PLUGIN_PATH})
      ${initLine}
      # ---
      # @type=infisicalClientId
      INFISICAL_CLIENT_ID=
      # @type=infisicalClientSecret @sensitive @internal
      INFISICAL_CLIENT_SECRET=
      ${schema}
    `;

    try {
      await pluginTest({
        ...rest,
        schema: fullSchema,
        injectValues: {
          INFISICAL_CLIENT_ID: 'test-client-id',
          INFISICAL_CLIENT_SECRET: 'test-client-secret',
          ...rest.injectValues,
        },
      })();
    } finally {
      resetSdkMockState();
    }
  };
}

describe('infisical plugin', () => {
  test('resolves an existing secret', infisicalTest({
    mockSecrets: { API_KEY: 'secret-value' },
    schema: 'API_KEY=infisical("API_KEY")',
    expectValues: { API_KEY: 'secret-value' },
  }));

  test('throws when a secret is missing', infisicalTest({
    mockSecrets: { API_KEY: 'secret-value' },
    schema: outdent`
      API_KEY=infisical("API_KEY")
      MISSING=infisical("MISSING")
    `,
    expectValues: {
      API_KEY: 'secret-value',
      MISSING: Error,
    },
  }));

  test('returns undefined for missing secrets when allowMissing is set per call', infisicalTest({
    mockSecrets: { API_KEY: 'secret-value' },
    schema: outdent`
      API_KEY=infisical("API_KEY")
      # @required=false
      MISSING=infisical("MISSING", allowMissing=true)
    `,
    expectValues: {
      API_KEY: 'secret-value',
      MISSING: undefined,
    },
  }));

  test('returns undefined for missing secrets when allowMissing is set on init', infisicalTest({
    mockSecrets: { API_KEY: 'secret-value' },
    initParams: 'allowMissing=true',
    schema: outdent`
      API_KEY=infisical("API_KEY")
      # @required=false
      MISSING=infisical("MISSING")
    `,
    expectValues: {
      API_KEY: 'secret-value',
      MISSING: undefined,
    },
  }));

  test('still throws auth errors when allowMissing is enabled', infisicalTest({
    mockSecretErrors: {
      API_KEY: Object.assign(new Error('Unauthorized'), { statusCode: 401 }),
    },
    schema: outdent`
      # @required=false
      API_KEY=infisical("API_KEY", allowMissing=true)
    `,
    expectValues: {
      API_KEY: Error,
    },
  }));
});
