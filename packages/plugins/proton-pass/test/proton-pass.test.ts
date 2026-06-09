import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  afterAll, beforeAll, describe, test,
} from 'vitest';
import { pluginTest } from 'varlock/test-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const FAKE_BIN_DIR = path.join(FIXTURES_DIR, 'bin');
const FAKE_PASS_CLI_SRC = path.join(__dirname, 'fake-pass-cli.cjs');
const FAKE_PASS_CLI = path.join(FAKE_BIN_DIR, 'pass-cli');
const CONFIG_PATH = path.join(FAKE_BIN_DIR, 'config.json');
const STATE_PATH = path.join(FAKE_BIN_DIR, 'state.json');

type FakePassConfig = {
  refs?: Record<string, string>;
  missingRefs?: Array<string>;
  runSkipRefs?: Array<string>;
  notLoggedMessage?: string;
  notFoundMessage?: string;
  requirePassword?: boolean;
  runErrorMessage?: string;
  itemViewErrors?: Record<string, string>;
};

function resetFakeCli(config: FakePassConfig) {
  fs.mkdirSync(FAKE_BIN_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config), 'utf8');
  fs.writeFileSync(STATE_PATH, JSON.stringify({ loggedIn: false }), 'utf8');
}

async function runProtonPassTest(opts: {
  config: FakePassConfig;
  schemaItems?: string;
  expectValues?: Record<string, string | typeof Error>;
  fullSchema?: string;
}) {
  resetFakeCli(opts.config);

  const originalPath = process.env.PATH;
  const originalFakeDir = process.env.FAKE_PASS_CLI_DIR;

  process.env.PATH = `${FAKE_BIN_DIR}:${originalPath}`;
  process.env.FAKE_PASS_CLI_DIR = FAKE_BIN_DIR;

  try {
    const fullSchema = opts.fullSchema ?? `
# @plugin(${PLUGIN_PATH})
# @initProtonPass(username=$PROTON_PASS_USERNAME, password=$PROTON_PASS_PASSWORD)
# ---
PROTON_PASS_USERNAME=test@example.com
PROTON_PASS_PASSWORD=test-password
${opts.schemaItems || ''}
`;
    await pluginTest({
      schema: fullSchema,
      ...(opts.expectValues ? { expectValues: opts.expectValues } : {}),
    })();
  } finally {
    process.env.PATH = originalPath;
    if (originalFakeDir === undefined) {
      delete process.env.FAKE_PASS_CLI_DIR;
    } else {
      process.env.FAKE_PASS_CLI_DIR = originalFakeDir;
    }
  }
}

beforeAll(() => {
  fs.mkdirSync(FAKE_BIN_DIR, { recursive: true });
  fs.writeFileSync(
    FAKE_PASS_CLI,
    `#!/usr/bin/env bash\nnode "${FAKE_PASS_CLI_SRC}" "$@"\n`,
    'utf8',
  );
  fs.chmodSync(FAKE_PASS_CLI, 0o755);
});

afterAll(() => {
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

describe('proton-pass plugin', () => {
  test('batches parallel reads into a single run invocation', async () => {
    await runProtonPassTest({
      config: {
        refs: {
          'pass://Production/Database/username': 'db-admin',
          'pass://Production/Database/password': 'db-secret',
          'pass://Production/API/key': 'api-key-123',
        },
      },
      schemaItems: `
DB_USER=protonPass(pass://Production/Database/username)
DB_PASS=protonPass(pass://Production/Database/password)
API_KEY=protonPass(pass://Production/API/key)
`,
      expectValues: {
        DB_USER: 'db-admin',
        DB_PASS: 'db-secret',
        API_KEY: 'api-key-123',
      },
    });
  });

  test('falls back to per-secret item view when batched run fails', async () => {
    await runProtonPassTest({
      config: {
        refs: {
          'pass://Production/Database/username': 'db-admin',
          'pass://Production/Database/password': 'db-secret',
        },
        runErrorMessage: 'simulated run failure',
      },
      schemaItems: `
DB_USER=protonPass(pass://Production/Database/username)
DB_PASS=protonPass(pass://Production/Database/password)
`,
      expectValues: {
        DB_USER: 'db-admin',
        DB_PASS: 'db-secret',
      },
    });
  });

  test('retries unresolved refs individually when batch omits some refs', async () => {
    await runProtonPassTest({
      config: {
        refs: {
          'pass://Production/Database/username': 'db-admin',
          'pass://Production/Database/password': 'db-secret',
        },
        runSkipRefs: ['pass://Production/Database/password'],
      },
      schemaItems: `
DB_USER=protonPass(pass://Production/Database/username)
DB_PASS=protonPass(pass://Production/Database/password)
`,
      expectValues: {
        DB_USER: 'db-admin',
        DB_PASS: 'db-secret',
      },
    });
  });

  test('missing ref without allowMissing surfaces an error', async () => {
    await runProtonPassTest({
      config: {
        refs: {
          'pass://Production/Database/username': 'db-admin',
        },
        missingRefs: ['pass://Production/Database/missing'],
        notFoundMessage: 'secret not found',
      },
      schemaItems: `
DB_USER=protonPass(pass://Production/Database/username)
MISSING=protonPass(pass://Production/Database/missing)
`,
      expectValues: {
        DB_USER: 'db-admin',
        MISSING: Error,
      },
    });
  });

  test('returns auth error when not logged in and password is missing', async () => {
    await runProtonPassTest({
      config: {
        notLoggedMessage: 'not authenticated',
      },
      fullSchema: `
# @plugin(${PLUGIN_PATH})
# @initProtonPass(username=test@example.com)
# ---
SECRET=protonPass(pass://Production/Database/password)
`,
      expectValues: {
        SECRET: Error,
      },
    });
  });
});
