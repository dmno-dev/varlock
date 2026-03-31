import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  describe, test, beforeAll, afterAll,
} from 'vitest';
import outdent from 'outdent';
import { pluginTest } from 'varlock/test-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// The fake dcli script is copied into a temp bin dir so we can prepend it to PATH.
// It reads expected responses from a JSON config file (FAKE_DCLI_CONFIG env var).
// This approach is necessary because the plugin is loaded via CJS in a separate
// module scope, so vitest's vi.mock() cannot intercept its spawnAsync calls.
const FAKE_DCLI_SRC = path.join(__dirname, 'fake-dcli.sh');
const FAKE_BIN_DIR = path.join(FIXTURES_DIR, 'bin');
const FAKE_DCLI = path.join(FAKE_BIN_DIR, 'dcli');
const DCLI_CONFIG_PATH = path.join(FIXTURES_DIR, 'dcli-config.json');

beforeAll(() => {
  fs.mkdirSync(FAKE_BIN_DIR, { recursive: true });
  fs.copyFileSync(FAKE_DCLI_SRC, FAKE_DCLI);
  fs.chmodSync(FAKE_DCLI, 0o755);
});

afterAll(() => {
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

// ── Test helper ──────────────────────────────────────────────────────

type DlTestOpts = {
  /** Map of dl:// references to their resolved values */
  dcliResponses?: Record<string, string>;
  /** Schema items section (after ---). Required unless fullSchema is provided. */
  schema?: string;
  /** Extra @initDashlane params (e.g., `autoSync=true`) */
  initParams?: string;
  /** Whether to use headless mode with service device keys */
  headless?: boolean;
  /** Full schema override (skips auto-generated boilerplate) */
  fullSchema?: string;
} & Omit<Parameters<typeof pluginTest>[0], 'schema'>;

/**
 * Build a test case that wires up plugin/initDashlane boilerplate and
 * creates a fake dcli config with the expected responses.
 */
function dlTest(opts: DlTestOpts) {
  const {
    dcliResponses = {},
    schema,
    initParams = '',
    headless = false,
    fullSchema: fullSchemaOverride,
    ...rest
  } = opts;

  return async () => {
    // Write the dcli config for this test and point the fake script at it
    fs.writeFileSync(DCLI_CONFIG_PATH, JSON.stringify({ responses: dcliResponses }));

    const origPath = process.env.PATH;
    process.env.PATH = `${FAKE_BIN_DIR}:${origPath}`;
    process.env.FAKE_DCLI_CONFIG = DCLI_CONFIG_PATH;

    try {
      const initLine = headless
        ? `# @initDashlane(serviceDeviceKeys=$DL_SERVICE_KEYS${initParams ? `, ${initParams}` : ''})`
        : `# @initDashlane(${initParams})`;

      const fullSchema = fullSchemaOverride ?? outdent`
        # @plugin(${PLUGIN_PATH})
        ${initLine}
        # ---
        ${headless ? outdent`
          # @type=string @sensitive
          DL_SERVICE_KEYS=
        ` : ''}
        ${schema}
      `;

      await pluginTest({
        ...rest,
        schema: fullSchema,
        ...(headless ? { injectValues: { DL_SERVICE_KEYS: 'dls_test_key_data_1234', ...rest.injectValues } } : {}),
      })();
    } finally {
      process.env.PATH = origPath;
      delete process.env.FAKE_DCLI_CONFIG;
    }
  };
}


// ── Tests ────────────────────────────────────────────────────────────

describe('dashlane plugin', () => {
  describe('dashlane() resolver', () => {
    test('fetch password by dl:// reference', dlTest({
      dcliResponses: { 'dl://abc123/password': 'my-secret' },
      schema: 'SECRET=dashlane("dl://abc123/password")',
      expectValues: { SECRET: 'my-secret' },
    }));

    test('fetch login field', dlTest({
      dcliResponses: { 'dl://abc123/login': 'admin' },
      schema: 'DL_USER=dashlane("dl://abc123/login")',
      expectValues: { DL_USER: 'admin' },
    }));

    test('strips trailing newline from dcli output', dlTest({
      dcliResponses: { 'dl://abc123/password': '  spaced-value  ' },
      schema: 'SECRET=dashlane("dl://abc123/password")',
      expectValues: { SECRET: '  spaced-value  ' },
    }));

    test('multiple secrets in one schema', dlTest({
      dcliResponses: {
        'dl://abc/password': 'pw1',
        'dl://def/password': 'pw2',
      },
      schema: outdent`
        A=dashlane("dl://abc/password")
        B=dashlane("dl://def/password")
      `,
      expectValues: { A: 'pw1', B: 'pw2' },
    }));
  });

  describe('named instances', () => {
    test('resolve from named instance', dlTest({
      dcliResponses: { 'dl://abc/password': 'named-secret' },
      fullSchema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initDashlane(id=prod)
        # ---
        SECRET=dashlane(prod, "dl://abc/password")
      `,
      expectValues: { SECRET: 'named-secret' },
    }));

    test('multiple named instances', dlTest({
      dcliResponses: {
        'dl://abc/password': 'prod-pw',
        'dl://def/password': 'dev-pw',
      },
      fullSchema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initDashlane(id=prod)
        # @initDashlane(id=dev)
        # ---
        PROD_SECRET=dashlane(prod, "dl://abc/password")
        DEV_SECRET=dashlane(dev, "dl://def/password")
      `,
      expectValues: { PROD_SECRET: 'prod-pw', DEV_SECRET: 'dev-pw' },
    }));
  });

  describe('headless mode (service device keys)', () => {
    test('resolves secrets with service device keys', dlTest({
      headless: true,
      dcliResponses: { 'dl://abc/password': 'headless-secret' },
      schema: 'SECRET=dashlane("dl://abc/password")',
      expectValues: { SECRET: 'headless-secret' },
    }));
  });

  describe('autoSync', () => {
    test('resolves after sync when autoSync=true', dlTest({
      initParams: 'autoSync=true',
      dcliResponses: { 'dl://abc/password': 'synced-secret' },
      schema: 'SECRET=dashlane("dl://abc/password")',
      expectValues: { SECRET: 'synced-secret' },
    }));
  });

  describe('data types', () => {
    test('dashlaneDeviceKeys validates dls_ prefix', dlTest({
      schema: outdent`
        # @type=dashlaneDeviceKeys
        DL_KEYS=dls_valid_key_data_12345
      `,
      expectValues: { DL_KEYS: 'dls_valid_key_data_12345' },
    }));

    test('dashlaneDeviceKeys rejects invalid prefix', dlTest({
      schema: outdent`
        # @type=dashlaneDeviceKeys
        DL_KEYS=invalid_key_data
      `,
      expectValues: { DL_KEYS: Error },
    }));

    test('dashlaneDeviceKeys is marked sensitive', dlTest({
      schema: outdent`
        # @type=dashlaneDeviceKeys
        DL_KEYS=dls_valid_key_data_12345
      `,
      expectSensitive: { DL_KEYS: true },
    }));
  });

  describe('errors', () => {
    test('entry not found returns error', dlTest({
      dcliResponses: {},
      schema: 'SECRET=dashlane("dl://does-not-exist/password")',
      expectValues: { SECRET: Error },
    }));

    test('unused plugin with missing dcli causes no errors', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initDashlane()
        # ---
        UNRELATED=hello
      `,
      expectValues: { UNRELATED: 'hello' },
    }));

    test('duplicate default instance id', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initDashlane()
        # @initDashlane()
        # ---
      `,
      expectSchemaError: true,
    }));

    test('duplicate named instance id', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initDashlane(id=prod)
        # @initDashlane(id=prod)
        # ---
      `,
      expectSchemaError: true,
    }));
  });
});
