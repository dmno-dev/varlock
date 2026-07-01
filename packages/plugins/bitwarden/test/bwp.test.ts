import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  describe, test, beforeAll, afterAll, expect,
} from 'vitest';
import outdent from 'outdent';
import { pluginTest, type PluginTestSpec } from 'varlock/test-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const FAKE_BIN_DIR = path.join(FIXTURES_DIR, 'bin');
const FAKE_BW = path.join(FAKE_BIN_DIR, 'bw');
const BW_CONFIG_PATH = path.join(FAKE_BIN_DIR, 'bw-config.json');
const UNLOCKS_DIR = path.join(FAKE_BIN_DIR, 'unlocks');

/**
 * how many times the fake `bw unlock` has run (one file per invocation).
 * Pass `account` to count only unlocks for a given BITWARDENCLI_APPDATA_DIR basename.
 */
function countUnlocks(account?: string): number {
  try {
    const files = fs.readdirSync(UNLOCKS_DIR);
    return account ? files.filter((f) => f.endsWith(`-${account}`)).length : files.length;
  } catch {
    return 0;
  }
}

// canned vault items the fake `bw get item <query>` returns
const ITEMS = {
  'Production DB': {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Production DB',
    type: 1,
    notes: 'primary db creds',
    login: {
      username: 'db_user',
      // `bw get item` stores the TOTP secret/seed (base32 key or otpauth:// URI),
      // not a generated 6-digit code — field=totp returns this verbatim
      totp: 'JBSWY3DPEHPK3PXP',
      password: 'super-secret-pw',
      uris: [{ uri: 'https://db.example.com' }],
    },
    fields: [{ name: 'api-key', value: 'cf-12345', type: 0 }],
  },
};

type BwConfig = {
  sessionToken?: string;
  unlockError?: string;
  lockedUntilReunlock?: boolean;
  /** `bw get` stays "Vault is locked." until a second unlock has run (count-based, concurrency-safe) */
  staleFirstSession?: boolean;
  items?: Record<string, unknown>;
};

function writeBwConfig(cfg: BwConfig) {
  // reset the "stale session" marker and unlock counter so each test starts fresh
  fs.rmSync(`${BW_CONFIG_PATH}.unlocked`, { force: true });
  fs.rmSync(UNLOCKS_DIR, { recursive: true, force: true });
  fs.writeFileSync(BW_CONFIG_PATH, JSON.stringify({ items: ITEMS, ...cfg }));
}

/** run a pluginTest spec with the fake `bw` on PATH and a given fake-CLI config */
function bwpTest(cfg: BwConfig, spec: PluginTestSpec, opts: { afterResolve?: () => void } = {}) {
  return async () => {
    writeBwConfig(cfg);
    const origPath = process.env.PATH;
    process.env.PATH = `${FAKE_BIN_DIR}:${origPath}`;
    try {
      await pluginTest({ ...spec, resolveDir: FIXTURES_DIR })();
      opts.afterResolve?.();
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
      // field=totp returns the stored secret/seed verbatim, not a generated code
      DB_TOTP: 'JBSWY3DPEHPK3PXP',
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

  // Regression: when many fields resolve in parallel against a stale session, the
  // re-unlock must be deduped into a SINGLE `bw unlock`. Each `bw unlock` invalidates
  // prior session keys, so racing re-unlocks would invalidate each other's tokens and
  // produce spurious failures. (The earlier `forceFresh` implementation reset the
  // in-flight guard per-caller, allowing one `bw unlock` per resolving field.)
  test('dedupes concurrent re-unlocks into a single bw unlock', bwpTest({ staleFirstSession: true }, {
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @initBwp(masterPassword=$BW_PW)
      # ---
      # @sensitive
      BW_PW=hunter2
      DB_A=bwp("Production DB", field=username)
      DB_B=bwp("Production DB", field=password)
      DB_C=bwp("Production DB", field=uri)
      DB_D=bwp("Production DB", field=notes)
    `,
    expectValues: {
      DB_A: 'db_user',
      DB_B: 'super-secret-pw',
      DB_C: 'https://db.example.com',
      DB_D: 'primary db creds',
    },
  }, { afterResolve: () => expect(countUnlocks()).toBe(2) })); // 1 initial + 1 deduped re-unlock

  // Regression: with a real (storing) cache, a stale cached token must be refreshed by
  // producing a fresh token and overwriting the cache entry — not by reading it back
  // through a not-yet-completed async delete (which could re-surface the stale token).
  test('heals a stale cached session with a real cache store', bwpTest({ staleFirstSession: true }, {
    schema: outdent`
      # @plugin(${PLUGIN_PATH})
      # @cache=memory
      # @initBwp(masterPassword=$BW_PW)
      # ---
      # @sensitive
      BW_PW=hunter2
      DB_PASSWORD=bwp("Production DB")
    `,
    expectValues: { DB_PASSWORD: 'super-secret-pw' },
  }, { afterResolve: () => expect(countUnlocks()).toBe(2) })); // 1 initial + 1 re-unlock

  // Multiple instances target different accounts/servers by pointing each at its own
  // bw data dir (BITWARDENCLI_APPDATA_DIR). Verify the instances read from different
  // vaults AND that each account unlocks independently exactly once (per-account
  // single-flight) — i.e. they don't share/invalidate one global session.
  test('isolates instances by appDataDir (separate accounts)', async () => {
    writeBwConfig({}); // clears the unlock counter; default config is unused here
    const dirPersonal = path.join(FIXTURES_DIR, 'acct-personal');
    const dirWork = path.join(FIXTURES_DIR, 'acct-work');
    fs.mkdirSync(dirPersonal, { recursive: true });
    fs.mkdirSync(dirWork, { recursive: true });
    fs.writeFileSync(path.join(dirPersonal, 'bw-config.json'), JSON.stringify({
      items: {
        Shared: {
          id: 'p', name: 'Shared', type: 1, login: { password: 'pw-from-personal' },
        },
      },
    }));
    fs.writeFileSync(path.join(dirWork, 'bw-config.json'), JSON.stringify({
      items: {
        Shared: {
          id: 'w', name: 'Shared', type: 1, login: { password: 'pw-from-work' },
        },
      },
    }));

    const origPath = process.env.PATH;
    process.env.PATH = `${FAKE_BIN_DIR}:${origPath}`;
    try {
      await pluginTest({
        resolveDir: FIXTURES_DIR,
        schema: outdent`
          # @plugin(${PLUGIN_PATH})
          # @initBwp(id=personal, masterPassword=$BW_PW, appDataDir="${dirPersonal}")
          # @initBwp(id=work, masterPassword=$BW_PW, appDataDir="${dirWork}")
          # ---
          # @sensitive
          BW_PW=hunter2
          PERSONAL_PW=bwp(personal, "Shared")
          WORK_PW=bwp(work, "Shared")
        `,
        expectValues: {
          PERSONAL_PW: 'pw-from-personal',
          WORK_PW: 'pw-from-work',
        },
      })();
      // each account unlocked on its own (not one shared/colliding session)
      expect(countUnlocks('acct-personal')).toBe(1);
      expect(countUnlocks('acct-work')).toBe(1);
    } finally {
      process.env.PATH = origPath;
    }
  });
});
