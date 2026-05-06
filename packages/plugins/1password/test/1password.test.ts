import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  describe, test, beforeAll, afterAll,
} from 'vitest';
import outdent from 'outdent';
import { pluginTest } from 'varlock/test-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Fake `op` CLI script — reads canned responses from a JSON config file
// located next to the script itself (op-config.json in the same directory).
const FAKE_OP_SRC = path.join(__dirname, 'fake-op.sh');
const FAKE_BIN_DIR = path.join(FIXTURES_DIR, 'bin');
const FAKE_OP = path.join(FAKE_BIN_DIR, 'op');
const OP_CONFIG_PATH = path.join(FAKE_BIN_DIR, 'op-config.json');

// ── SDK mock setup ───────────────────────────────────────────────────
// The test build (dist-test/plugin.cjs) externalizes @1password/sdk so
// we can pre-populate Node's require cache with a mock before the plugin loads.

const SDK_TEST_PLUGIN_PATH = path.join(__dirname, '..', 'dist-test');
const SDK_TEST_PLUGIN_CJS = path.join(SDK_TEST_PLUGIN_PATH, 'plugin.cjs');

/** Mutable state the mock SDK reads from — updated per test */
const sdkMockState = {
  responses: {} as Record<string, string>,
  /** Per-ref errors (NOT_FOUND, etc.) */
  itemErrors: {} as Record<string, string>,
  /** If set, resolveAll throws this string (simulates SDK-level crash) */
  sdkThrow: undefined as string | undefined,
  /** Map of environment ID → array of { name, value } */
  environments: {} as Record<string, Array<{ name: string; value: string }>>,
  /** If set, getVariables throws with this message */
  envThrow: undefined as string | undefined,
};

function resetSdkMockState() {
  sdkMockState.responses = {};
  sdkMockState.itemErrors = {};
  sdkMockState.sdkThrow = undefined;
  sdkMockState.environments = {};
  sdkMockState.envThrow = undefined;
}

const mockSdkClient = {
  secrets: {
    async resolveAll(refs: Array<string>) {
      if (sdkMockState.sdkThrow) throw sdkMockState.sdkThrow;
      const individualResponses: Record<string, any> = {};
      for (const ref of refs) {
        if (sdkMockState.itemErrors[ref]) {
          individualResponses[ref] = { error: { message: sdkMockState.itemErrors[ref] } };
        } else if (ref in sdkMockState.responses) {
          individualResponses[ref] = { content: { secret: sdkMockState.responses[ref] } };
        }
        // refs not in responses/errors → no entry (triggers "no response returned" error)
      }
      return { individualResponses };
    },
  },
  environments: {
    async getVariables(envId: string) {
      if (sdkMockState.envThrow) throw new Error(sdkMockState.envThrow);
      const vars = sdkMockState.environments[envId];
      if (!vars) throw new Error(`environment "${envId}" not found`);
      return { variables: vars };
    },
  },
};

const mockSdkExports = {
  createClient: async () => mockSdkClient,
  Client: class {},
};

beforeAll(() => {
  fs.mkdirSync(FAKE_BIN_DIR, { recursive: true });
  fs.copyFileSync(FAKE_OP_SRC, FAKE_OP);
  fs.chmodSync(FAKE_OP, 0o755);

  // Write a minimal package.json so the env graph can resolve the test plugin
  fs.writeFileSync(
    path.join(SDK_TEST_PLUGIN_PATH, 'package.json'),
    JSON.stringify({ exports: { './plugin': './plugin.cjs' } }),
  );

  // Pre-populate require.cache so the test build's `require('@1password/sdk')`
  // returns our mock instead of loading the real WASM-based SDK.
  const testRequire = createRequire(SDK_TEST_PLUGIN_CJS);
  const sdkResolvedPath = testRequire.resolve('@1password/sdk');
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
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  // Clean up the test package.json
  try {
    fs.unlinkSync(path.join(SDK_TEST_PLUGIN_PATH, 'package.json'));
  } catch { /* may not exist */ }
});

// ── Test helper ──────────────────────────────────────────────────────

type OpConfig = {
  /** Map of op:// references to their resolved values */
  responses?: Record<string, string>;
  /**
   * Map of op:// references to error messages.
   * When any ref in a batch matches, the entire batch fails with this message
   * (matching real `op` behaviour). The plugin then retries the remaining refs.
   */
  errors?: Record<string, string>;
  /** Map of environment ID to raw env-format output (KEY=value lines) */
  environments?: Record<string, string>;
};

type OpTestOpts = {
  opConfig?: OpConfig;
  /** Items section of the schema (after `---`). Auto-wrapped with plugin/init boilerplate. */
  schema?: string;
  /** Auth mode: 'serviceAccountCli' uses token + CLI, 'appAuth' uses desktop app auth */
  authMode?: 'serviceAccountCli' | 'appAuth';
  /** Extra @initOp params (e.g. `account="my-acct"`) */
  initParams?: string;
  /** Full schema override (skips auto-generated boilerplate) */
  fullSchema?: string;
} & Omit<Parameters<typeof pluginTest>[0], 'schema'>;

/**
 * Build a test case that wires up plugin/initOp boilerplate and
 * creates a fake op config with the expected responses.
 */
function opTest(opts: OpTestOpts) {
  const {
    opConfig = {},
    schema,
    authMode = 'serviceAccountCli',
    initParams = '',
    fullSchema: fullSchemaOverride,
    ...rest
  } = opts;

  return async () => {
    // Write the op config for this test
    fs.writeFileSync(OP_CONFIG_PATH, JSON.stringify(opConfig));

    const origPath = process.env.PATH;
    process.env.PATH = `${FAKE_BIN_DIR}:${origPath}`;

    try {
      let initLine: string;
      let tokenLine = '';

      if (authMode === 'serviceAccountCli') {
        initLine = `# @initOp(token=$OP_SA_TOKEN, useCliWithServiceAccount=true${initParams ? `, ${initParams}` : ''})`;
        tokenLine = outdent`
          # @type=string @sensitive
          OP_SA_TOKEN=
        `;
      } else {
        initLine = `# @initOp(allowAppAuth=true${initParams ? `, ${initParams}` : ''})`;
      }

      const fullSchema = fullSchemaOverride ?? outdent`
        # @plugin(${PLUGIN_PATH})
        ${initLine}
        # ---
        ${tokenLine}
        ${schema}
      `;

      await pluginTest({
        ...rest,
        schema: fullSchema,
        ...(authMode === 'serviceAccountCli'
          ? { injectValues: { OP_SA_TOKEN: 'ops_fake_test_token', ...rest.injectValues } }
          : {}),
      })();
    } finally {
      process.env.PATH = origPath;
    }
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('1password plugin', () => {
  // ── Service account CLI path ──────────────────────────────
  describe('service account CLI path (useCliWithServiceAccount)', () => {
    test('resolves a single secret', opTest({
      opConfig: {
        responses: { 'op://vault/item/field': 'my-secret-value' },
      },
      schema: 'SECRET=op("op://vault/item/field")',
      expectValues: { SECRET: 'my-secret-value' },
    }));

    test('resolves multiple secrets in a batch', opTest({
      opConfig: {
        responses: {
          'op://vault/item/username': 'admin',
          'op://vault/item/password': 's3cret',
          'op://vault/other/api-key': 'ak-12345',
        },
      },
      schema: outdent`
        DB_USER=op("op://vault/item/username")
        DB_PASS=op("op://vault/item/password")
        API_KEY=op("op://vault/other/api-key")
      `,
      expectValues: { DB_USER: 'admin', DB_PASS: 's3cret', API_KEY: 'ak-12345' },
    }));

    test('handles values containing special characters', opTest({
      opConfig: {
        responses: { 'op://vault/item/field': 'p@ss=w0rd&foo' },
      },
      schema: 'SECRET=op("op://vault/item/field")',
      expectValues: { SECRET: 'p@ss=w0rd&foo' },
    }));

    test('bad vault reference rejects that item and retries the rest', opTest({
      opConfig: {
        responses: { 'op://good-vault/item/field': 'good-value' },
        errors: { 'op://bad-vault/item/field': '"bad-vault" isn\'t a vault in this account. Specify the vault' },
      },
      schema: outdent`
        GOOD=op("op://good-vault/item/field")
        BAD=op("op://bad-vault/item/field")
      `,
      expectValues: { GOOD: 'good-value', BAD: Error },
    }));

    test('bad item reference rejects that item and retries the rest', opTest({
      opConfig: {
        responses: { 'op://vault/good-item/field': 'good-value' },
        errors: { 'op://vault/bad-item/field': 'could not find item bad-item in vault vault' },
      },
      schema: outdent`
        GOOD=op("op://vault/good-item/field")
        BAD=op("op://vault/bad-item/field")
      `,
      expectValues: { GOOD: 'good-value', BAD: Error },
    }));

    test('bad field reference rejects that item and retries the rest', opTest({
      opConfig: {
        responses: { 'op://vault/item/good-field': 'good-value' },
        errors: { 'op://vault/item/bad-field': "item 'vault/item' does not have a field 'bad-field'" },
      },
      schema: outdent`
        GOOD=op("op://vault/item/good-field")
        BAD=op("op://vault/item/bad-field")
      `,
      expectValues: { GOOD: 'good-value', BAD: Error },
    }));
  });

  // ── App auth CLI path ─────────────────────────────────────
  describe('app auth CLI path (allowAppAuth)', () => {
    test('resolves a single secret', opTest({
      authMode: 'appAuth',
      opConfig: {
        responses: { 'op://vault/item/field': 'app-auth-secret' },
      },
      schema: 'SECRET=op("op://vault/item/field")',
      expectValues: { SECRET: 'app-auth-secret' },
    }));

    test('resolves multiple secrets in a batch', opTest({
      authMode: 'appAuth',
      opConfig: {
        responses: {
          'op://vault/item/user': 'admin',
          'op://vault/item/pass': 'hunter2',
        },
      },
      schema: outdent`
        DB_USER=op("op://vault/item/user")
        DB_PASS=op("op://vault/item/pass")
      `,
      expectValues: { DB_USER: 'admin', DB_PASS: 'hunter2' },
    }));

    test('bad vault reference rejects that item and retries the rest', opTest({
      authMode: 'appAuth',
      opConfig: {
        responses: { 'op://good-vault/item/field': 'good-value' },
        errors: { 'op://bad-vault/item/field': '"bad-vault" isn\'t a vault in this account. Specify the vault' },
      },
      schema: outdent`
        GOOD=op("op://good-vault/item/field")
        BAD=op("op://bad-vault/item/field")
      `,
      expectValues: { GOOD: 'good-value', BAD: Error },
    }));
  });

  // ── opLoadEnvironment ─────────────────────────────────────
  describe('opLoadEnvironment', () => {
    test('loads environment via service account CLI', opTest({
      opConfig: {
        environments: { 'env-abc123': 'DB_HOST=localhost\nDB_PORT=5432\n' },
      },
      schema: 'ALL=opLoadEnvironment("env-abc123")',
      expectValues: { ALL: JSON.stringify({ DB_HOST: 'localhost', DB_PORT: '5432' }) },
    }));

    test('loads environment via app auth', opTest({
      authMode: 'appAuth',
      opConfig: {
        environments: { 'env-xyz789': 'API_URL=https://api.example.com\nAPI_KEY=key123\n' },
      },
      schema: 'ALL=opLoadEnvironment("env-xyz789")',
      expectValues: { ALL: JSON.stringify({ API_URL: 'https://api.example.com', API_KEY: 'key123' }) },
    }));

    test('invalid environment ID returns error', opTest({
      opConfig: {},
      schema: 'ALL=opLoadEnvironment("bad-env-id")',
      expectValues: { ALL: Error },
    }));
  });

  // ── Named instances ───────────────────────────────────────
  describe('named instances', () => {
    test('resolves from a named instance', opTest({
      opConfig: {
        responses: { 'op://vault/item/field': 'named-value' },
      },
      fullSchema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initOp(id=prod, token=$OP_SA_TOKEN, useCliWithServiceAccount=true)
        # ---
        # @type=string @sensitive
        OP_SA_TOKEN=
        SECRET=op(prod, "op://vault/item/field")
      `,
      injectValues: { OP_SA_TOKEN: 'ops_fake_test_token' },
      expectValues: { SECRET: 'named-value' },
    }));
  });

  // ── Data types ────────────────────────────────────────────
  describe('data types', () => {
    test('opServiceAccountToken validates ops_ prefix', opTest({
      opConfig: {},
      schema: outdent`
        # @type=opServiceAccountToken
        MY_TOKEN=ops_valid_token_12345
      `,
      expectValues: { MY_TOKEN: 'ops_valid_token_12345' },
    }));

    test('opServiceAccountToken rejects invalid prefix', opTest({
      opConfig: {},
      schema: outdent`
        # @type=opServiceAccountToken
        MY_TOKEN=invalid_token
      `,
      expectValues: { MY_TOKEN: Error },
    }));

    test('opServiceAccountToken is marked sensitive', opTest({
      opConfig: {},
      schema: outdent`
        # @type=opServiceAccountToken
        MY_TOKEN=ops_valid_token_12345
      `,
      expectSensitive: { MY_TOKEN: true },
    }));

    test('opConnectToken is marked sensitive', opTest({
      opConfig: {},
      schema: outdent`
        # @type=opConnectToken
        MY_TOKEN=some_connect_token
      `,
      expectSensitive: { MY_TOKEN: true },
    }));
  });

  // ── SDK path (service account token, no useCliWithServiceAccount) ──
  describe('SDK path (service account token)', () => {
    /**
     * Helper for SDK-path tests. Uses the test build (dist-test/) which
     * externalizes @1password/sdk so it can be mocked via require.cache.
     */
    type SdkTestOpts = {
      /** Mock responses: op:// ref → resolved secret value */
      mockResponses?: Record<string, string>;
      /** Mock per-ref errors: op:// ref → error message */
      mockItemErrors?: Record<string, string>;
      /** If set, resolveAll() throws this string (simulates SDK-level crash) */
      mockSdkThrow?: string;
      /** Mock environments: envId → array of { name, value } */
      mockEnvironments?: Record<string, Array<{ name: string; value: string }>>;
      /** If set, getVariables() throws with this message */
      mockEnvThrow?: string;
    } & Omit<OpTestOpts, 'authMode' | 'opConfig'>;

    function sdkTest(opts: SdkTestOpts) {
      const {
        mockResponses = {},
        mockItemErrors = {},
        mockSdkThrow,
        mockEnvironments = {},
        mockEnvThrow,
        schema,
        initParams = '',
        fullSchema: fullSchemaOverride,
        ...rest
      } = opts;

      return async () => {
        // Set up mock state before plugin loads
        sdkMockState.responses = mockResponses;
        sdkMockState.itemErrors = mockItemErrors;
        sdkMockState.sdkThrow = mockSdkThrow;
        sdkMockState.environments = mockEnvironments;
        sdkMockState.envThrow = mockEnvThrow;

        const initLine = `# @initOp(token=$OP_SA_TOKEN${initParams ? `, ${initParams}` : ''})`;

        const fullSchema = fullSchemaOverride ?? outdent`
          # @plugin(${SDK_TEST_PLUGIN_PATH})
          ${initLine}
          # ---
          # @type=string @sensitive
          OP_SA_TOKEN=
          ${schema}
        `;

        try {
          await pluginTest({
            ...rest,
            schema: fullSchema,
            injectValues: { OP_SA_TOKEN: 'ops_fake_test_token', ...rest.injectValues },
          })();
        } finally {
          resetSdkMockState();
        }
      };
    }

    test('resolves a single secret', sdkTest({
      mockResponses: { 'op://vault/item/field': 'sdk-secret-value' },
      schema: 'SECRET=op("op://vault/item/field")',
      expectValues: { SECRET: 'sdk-secret-value' },
    }));

    test('resolves multiple secrets in a batch', sdkTest({
      mockResponses: {
        'op://vault/item/username': 'admin',
        'op://vault/item/password': 's3cret',
      },
      schema: outdent`
        DB_USER=op("op://vault/item/username")
        DB_PASS=op("op://vault/item/password")
      `,
      expectValues: { DB_USER: 'admin', DB_PASS: 's3cret' },
    }));

    test('per-ref error marks only that item as failed', sdkTest({
      mockResponses: { 'op://vault/item/field': 'good-value' },
      mockItemErrors: { 'op://vault/missing/field': 'item not found' },
      schema: outdent`
        GOOD=op("op://vault/item/field")
        BAD=op("op://vault/missing/field")
      `,
      expectValues: { GOOD: 'good-value', BAD: Error },
    }));

    test('ref with no response entry returns error', sdkTest({
      mockResponses: {},
      schema: 'MISSING=op("op://vault/no-response/field")',
      expectValues: { MISSING: Error },
    }));

    test('SDK-level throw rejects all items', sdkTest({
      mockSdkThrow: 'SDK authentication failed',
      schema: outdent`
        A=op("op://vault/item/a")
        B=op("op://vault/item/b")
      `,
      expectValues: { A: Error, B: Error },
    }));

    test('loads environment via SDK', sdkTest({
      mockEnvironments: {
        'env-sdk-123': [
          { name: 'API_URL', value: 'https://api.test' },
          { name: 'API_KEY', value: 'key-abc' },
        ],
      },
      schema: 'ALL=opLoadEnvironment("env-sdk-123")',
      expectValues: { ALL: JSON.stringify({ API_URL: 'https://api.test', API_KEY: 'key-abc' }) },
    }));

    test('invalid environment ID via SDK returns error', sdkTest({
      schema: 'ALL=opLoadEnvironment("bad-env-id")',
      expectValues: { ALL: Error },
    }));
  });

  // ── Schema errors ─────────────────────────────────────────
  describe('schema errors', () => {
    test('missing auth config', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initOp()
        # ---
      `,
      expectSchemaError: true,
    }));

    test('duplicate default instance id', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initOp(allowAppAuth=true)
        # @initOp(allowAppAuth=true)
        # ---
      `,
      expectSchemaError: true,
    }));

    test('duplicate named instance id', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initOp(id=prod, allowAppAuth=true)
        # @initOp(id=prod, allowAppAuth=true)
        # ---
      `,
      expectSchemaError: true,
    }));

    test('unused plugin with no op calls causes no errors', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initOp(allowAppAuth=true)
        # ---
        UNRELATED=hello
      `,
      expectValues: { UNRELATED: 'hello' },
    }));
  });
});
