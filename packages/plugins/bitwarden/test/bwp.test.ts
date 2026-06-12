import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  describe, test, beforeAll, afterAll,
} from 'vitest';
import outdent from 'outdent';
import { pluginTest, type PluginTestSpec } from 'varlock/test-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const FAKE_BIN_DIR = path.join(FIXTURES_DIR, 'bin');
const FAKE_BW = path.join(FAKE_BIN_DIR, 'bw');
const BW_CONFIG_PATH = path.join(FAKE_BIN_DIR, 'bw-config.json');

// canned vault items the fake `bw get item <query>` returns
const ITEMS = {
  'Production DB': {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Production DB',
    type: 1,
    notes: 'primary db creds',
    login: {
      username: 'db_user',
      password: 'super-secret-pw',
      totp: '123456',
      uris: [{ uri: 'https://db.example.com' }],
    },
    fields: [{ name: 'api-key', value: 'cf-12345', type: 0 }],
  },
};

type BwConfig = {
  sessionToken?: string;
  unlockError?: string;
  lockedUntilReunlock?: boolean;
  items?: Record<string, unknown>;
};

function writeBwConfig(cfg: BwConfig) {
  // reset the "stale session" marker so each test starts fresh
  fs.rmSync(`${BW_CONFIG_PATH}.unlocked`, { force: true });
  fs.writeFileSync(BW_CONFIG_PATH, JSON.stringify({ items: ITEMS, ...cfg }));
}

/** run a pluginTest spec with the fake `bw` on PATH and a given fake-CLI config */
function bwpTest(cfg: BwConfig, spec: PluginTestSpec) {
  return async () => {
    writeBwConfig(cfg);
    const origPath = process.env.PATH;
    process.env.PATH = `${FAKE_BIN_DIR}:${origPath}`;
    try {
      await pluginTest({ ...spec, resolveDir: FIXTURES_DIR })();
    } finally {
      process.env.PATH = origPath;
    }
  };
}

beforeAll(() => {
  fs.mkdirSync(FAKE_BIN_DIR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fake-bw.sh'), FAKE_BW);
  fs.chmodSync(FAKE_BW, 0o755);
});

afterAll(() => {
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

describe('Bitwarden Password Manager (bwp)', () => {
  // NOTE: the plugin module re-executes per load, so module-level state
  // (instances, in-flight unlock) is reset between every test.

  test('errors when no token/master-password is available and stdin is not a TTY', bwpTest({}, {
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @initBwp()
      # ---
      DB_PASSWORD=bwp("Production DB")
    `,
    expectValues: { DB_PASSWORD: Error },
  }));

  test('auto-unlocks non-interactively with a master password and resolves a field', bwpTest({}, {
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @initBwp(masterPassword=$BW_PW)
      # ---
      # @sensitive
      BW_PW=hunter2
      DB_PASSWORD=bwp("Production DB")
    `,
    expectValues: { DB_PASSWORD: 'super-secret-pw' },
  }));

  test('defaults to the password field', bwpTest({}, {
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @initBwp(sessionToken=$BWP_SESSION)
      # ---
      # @type=bwSessionToken @sensitive
      BWP_SESSION=preset-token
      DB_PASSWORD=bwp("Production DB")
    `,
    expectValues: { DB_PASSWORD: 'super-secret-pw' },
  }));

  test('selects standard fields via field=', bwpTest({}, {
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @initBwp(sessionToken=$BWP_SESSION)
      # ---
      # @type=bwSessionToken @sensitive
      BWP_SESSION=preset-token
      DB_USER=bwp("Production DB", field=username)
      DB_TOTP=bwp("Production DB", field=totp)
      DB_URI=bwp("Production DB", field=uri)
      DB_NOTES=bwp("Production DB", field=notes)
    `,
    expectValues: {
      DB_USER: 'db_user',
      DB_TOTP: '123456',
      DB_URI: 'https://db.example.com',
      DB_NOTES: 'primary db creds',
    },
  }));

  test('resolves custom fields (case-insensitive)', bwpTest({}, {
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @initBwp(sessionToken=$BWP_SESSION)
      # ---
      # @type=bwSessionToken @sensitive
      BWP_SESSION=preset-token
      API_KEY=bwp("Production DB", field="API-KEY")
    `,
    expectValues: { API_KEY: 'cf-12345' },
  }));

  test('errors for an unknown field', bwpTest({}, {
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @initBwp(sessionToken=$BWP_SESSION)
      # ---
      # @type=bwSessionToken @sensitive
      BWP_SESSION=preset-token
      MISSING=bwp("Production DB", field=doesnotexist)
    `,
    expectValues: { MISSING: Error },
  }));

  test('errors when the item is not found', bwpTest({}, {
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @initBwp(sessionToken=$BWP_SESSION)
      # ---
      # @type=bwSessionToken @sensitive
      BWP_SESSION=preset-token
      NOPE=bwp("Nonexistent Item")
    `,
    expectValues: { NOPE: Error },
  }));

  test('re-unlocks once when the cached session is stale ("Vault is locked.")', bwpTest({ lockedUntilReunlock: true }, {
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @initBwp(masterPassword=$BW_PW)
      # ---
      # @sensitive
      BW_PW=hunter2
      DB_PASSWORD=bwp("Production DB")
    `,
    expectValues: { DB_PASSWORD: 'super-secret-pw' },
  }));

  test('supports multiple named instances', bwpTest({}, {
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @initBwp(id=work, sessionToken=$BWP_SESSION)
      # ---
      # @type=bwSessionToken @sensitive
      BWP_SESSION=preset-token
      WORK_DB=bwp(work, "Production DB", field=username)
    `,
    expectValues: { WORK_DB: 'db_user' },
  }));
});
