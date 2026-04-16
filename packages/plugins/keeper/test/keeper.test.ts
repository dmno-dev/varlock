import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describe, test,
} from 'vitest';
import outdent from 'outdent';
import { pluginTest } from 'varlock/test-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..');

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a fake base64-encoded KSM config token */
function fakeKsmToken(overrides: Record<string, string> = {}): string {
  const config = {
    hostname: 'keepersecurity.com',
    clientId: 'fake-client-id',
    privateKey: 'fake-private-key',
    appKey: 'fake-app-key',
    serverPublicKeyId: '7',
    ...overrides,
  };
  return Buffer.from(JSON.stringify(config)).toString('base64');
}

type KeeperTestOpts = {
  /** Schema items section (after ---). Required unless fullSchema is provided. */
  schema?: string;
  /** Full schema override (skips auto-generated boilerplate) */
  fullSchema?: string;
  /** Extra @initKeeper params */
  initParams?: string;
} & Omit<Parameters<typeof pluginTest>[0], 'schema'>;

function keeperTest(opts: KeeperTestOpts) {
  const {
    schema,
    initParams = '',
    fullSchema: fullSchemaOverride,
    ...rest
  } = opts;

  const initLine = initParams
    ? `# @initKeeper(token=$KSM_CONFIG, ${initParams})`
    : '# @initKeeper(token=$KSM_CONFIG)';

  const fullSchema = fullSchemaOverride ?? outdent`
    # @plugin(${PLUGIN_PATH})
    ${initLine}
    # ---
    # @type=keeperSmToken
    KSM_CONFIG=
    ${schema}
  `;

  return {
    ...rest,
    schema: fullSchema,
    injectValues: {
      KSM_CONFIG: fakeKsmToken(),
      ...rest.injectValues,
    },
  };
}


// ── Tests ────────────────────────────────────────────────────────────

describe('keeper plugin', () => {
  describe('data types', () => {
    test('keeperSmToken accepts valid base64 JSON', pluginTest(keeperTest({
      schema: outdent`
        # @type=keeperSmToken
        MY_TOKEN=${fakeKsmToken()}
      `,
      expectValues: { MY_TOKEN: fakeKsmToken() },
    })));

    test('keeperSmToken rejects non-base64 string', pluginTest(keeperTest({
      schema: outdent`
        # @type=keeperSmToken
        MY_TOKEN=not-valid-base64!!!
      `,
      expectValues: { MY_TOKEN: Error },
    })));

    test('keeperSmToken rejects base64 non-JSON', pluginTest(keeperTest({
      schema: outdent`
        # @type=keeperSmToken
        MY_TOKEN=${Buffer.from('not-json').toString('base64')}
      `,
      expectValues: { MY_TOKEN: Error },
    })));

    test('keeperSmToken is marked sensitive', pluginTest(keeperTest({
      schema: outdent`
        # @type=keeperSmToken
        MY_TOKEN=${fakeKsmToken()}
      `,
      expectSensitive: { MY_TOKEN: true },
    })));
  });

  describe('@initKeeper decorator', () => {
    test('missing token param', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKeeper()
        # ---
      `,
      expectSchemaError: true,
    }));

    test('duplicate default instance id', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKeeper(token=$KSM_CONFIG)
        # @initKeeper(token=$KSM_CONFIG)
        # ---
        # @type=keeperSmToken
        KSM_CONFIG=
      `,
      expectSchemaError: true,
    }));

    test('duplicate named instance id', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKeeper(token=$KSM_TOKEN_1, id=prod)
        # @initKeeper(token=$KSM_TOKEN_2, id=prod)
        # ---
        # @type=keeperSmToken
        KSM_TOKEN_1=
        # @type=keeperSmToken
        KSM_TOKEN_2=
      `,
      expectSchemaError: true,
    }));

    test('unused plugin with valid init causes no errors', pluginTest(keeperTest({
      schema: 'UNRELATED=hello',
      expectValues: { UNRELATED: 'hello' },
    })));
  });

  describe('keeper() resolver schema validation', () => {
    test('no args produces an error', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKeeper(token=$T)
        # ---
        # @type=keeperSmToken
        T=
        SECRET=keeper()
      `,
      injectValues: { T: fakeKsmToken() },
      expectValues: { SECRET: Error },
    }));

    test('valid single arg does not produce schema errors', pluginTest(keeperTest({
      schema: 'SECRET=keeper("some-uid/field/password")',
    })));

    test('valid two args (instance, notation) does not produce schema errors', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKeeper(token=$T, id=myinst)
        # ---
        # @type=keeperSmToken
        T=
        SECRET=keeper(myinst, "some-uid/field/password")
      `,
      injectValues: { T: fakeKsmToken() },
    }));

    test('non-static instance id produces an error', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKeeper(token=$T)
        # ---
        # @type=keeperSmToken
        T=
        MY_ID=dynamic
        SECRET=keeper($MY_ID, "some-uid")
      `,
      injectValues: { T: fakeKsmToken() },
      expectValues: { SECRET: Error },
    }));

    test('unknown instance id produces an error', pluginTest(keeperTest({
      schema: 'SECRET=keeper(nonexistent, "some-uid")',
      expectValues: { SECRET: Error },
    })));
  });

  describe('named instances', () => {
    test('multiple named instances do not produce schema errors', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKeeper(token=$T1, id=prod)
        # @initKeeper(token=$T2, id=staging)
        # ---
        # @type=keeperSmToken
        T1=
        # @type=keeperSmToken
        T2=
        SECRET_A=keeper(prod, "uid-a")
        SECRET_B=keeper(staging, "uid-b")
      `,
      injectValues: {
        T1: fakeKsmToken(),
        T2: fakeKsmToken({ hostname: 'keepersecurity.eu' }),
      },
    }));
  });
});
