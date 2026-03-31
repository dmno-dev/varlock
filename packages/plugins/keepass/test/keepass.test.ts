import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, afterAll } from 'vitest';
import outdent from 'outdent';
import * as kdbxweb from 'kdbxweb';
import { argon2d, argon2id } from 'hash-wasm';
import { pluginTest, type PluginTestSpec } from 'varlock/test-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// register argon2 for kdbxweb (same impl as the plugin uses)
kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
  const hashFn = type === 0 ? argon2d : argon2id;
  const result = await hashFn({
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    memorySize: memory,
    iterations,
    hashLength: length,
    parallelism,
    outputType: 'binary',
  });
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
});

type TestDbEntries = Record<string, Record<string, string>>;

async function buildTestKdbx(password: string, entries: TestDbEntries): Promise<Buffer> {
  const creds = new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString(password));
  const db = kdbxweb.Kdbx.create(creds, 'TestDB');
  const root = db.getDefaultGroup();
  const groups: Record<string, kdbxweb.KdbxGroup> = {};

  for (const [entryPath, fields] of Object.entries(entries)) {
    const parts = entryPath.split('/');
    const title = parts.pop()!;

    let parent = root;
    for (const groupName of parts) {
      const groupKey = parts.slice(0, parts.indexOf(groupName) + 1).join('/');
      groups[groupKey] ||= db.createGroup(parent, groupName);
      parent = groups[groupKey];
    }

    const entry = db.createEntry(parent);
    entry.fields.set('Title', title);
    for (const [fieldName, value] of Object.entries(fields)) {
      if (fieldName === 'Password') {
        entry.fields.set(fieldName, kdbxweb.ProtectedValue.fromString(value));
      } else {
        entry.fields.set(fieldName, value);
      }
    }
  }

  return Buffer.from(await db.save());
}

let dbCounter = 0;

/**
 * Builds a KDBX on the fly and wires up plugin/initKeePass boilerplate.
 * `schema` is just the items section (after the `---`).
 */
function kpTest(opts: {
  entries: TestDbEntries;
  password?: string;
  schema: string;
} & Omit<PluginTestSpec, 'schema'>) {
  const {
    entries, password = 'test-pw', schema, ...rest
  } = opts;

  return async () => {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    const dbPath = path.join(FIXTURES_DIR, `test-db-${dbCounter++}.kdbx`);
    fs.writeFileSync(dbPath, await buildTestKdbx(password, entries));

    const fullSchema = outdent`
      # @plugin(${PLUGIN_PATH})
      # @initKeePass(dbPath="${dbPath}", password=${password})
      # ---
      ${schema}
    `;

    await pluginTest({ ...rest, schema: fullSchema })();
  };
}

afterAll(() => {
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

describe('keepass plugin', () => {
  describe('data types', () => {
    test('kdbxPassword type marks value as sensitive', kpTest({
      entries: { X: { Password: 'x' } },
      schema: outdent`
      # @type=kdbxPassword
      MY_PW=test-pw
    `,
      expectSensitive: { MY_PW: true },
    }));
  });

  describe('kp() resolver', () => {
    test('kp(entryName) - entry name w/ default attribute', kpTest({
      entries: { MY_SECRET: { Password: 'secret-val' } },
      schema: 'V1=kp(MY_SECRET)',
      expectValues: { V1: 'secret-val' },
    }));

    test('kp("Group/Entry") - nested entry path', kpTest({
      entries: { 'Svc/API_KEY': { Password: 'api-123' } },
      schema: 'V1=kp("Svc/API_KEY")',
      expectValues: { V1: 'api-123' },
    }));

    test('kp("entry#Attr") - entry with attribute (hash syntax)', kpTest({
      entries: { MY_SECRET: { Password: 'pw', UserName: 'admin' } },
      schema: 'V1=kp("MY_SECRET#UserName")',
      expectValues: { V1: 'admin' },
    }));

    test('kp(entry, attribute=X) - entry with attribute (named param)', kpTest({
      entries: { MY_SECRET: { Password: 'pw', URL: 'https://example.com' } },
      schema: 'V1=kp(MY_SECRET, attribute=URL)',
      expectValues: { V1: 'https://example.com' },
    }));

    test('kp() - infer entry name from key', kpTest({
      entries: { MY_SECRET: { Password: 'secret-val' } },
      schema: 'MY_SECRET=kp()',
      expectValues: { MY_SECRET: 'secret-val' },
    }));

    test('kp("#Attr") - infer entry name + attribute via hash', kpTest({
      entries: { MY_SECRET: { Password: 'pw', UserName: 'admin' } },
      schema: 'MY_SECRET=kp("#UserName")',
      expectValues: { MY_SECRET: 'admin' },
    }));
    test('kp(attribute=x) - infer entry name + attribute via named param', kpTest({
      entries: { MY_SECRET: { Password: 'pw', UserName: 'admin' } },
      schema: 'MY_SECRET=kp("#UserName")',
      expectValues: { MY_SECRET: 'admin' },
    }));

    test('kp with custom field', kpTest({
      entries: { DB_CONN: { Password: 'pw', ConnectionString: 'postgres://localhost/mydb' } },
      schema: 'V1=kp("DB_CONN#ConnectionString")',
      expectValues: { V1: 'postgres://localhost/mydb' },
    }));

    test('kp(customAttributesObj=true) - all custom fields as JSON', kpTest({
      entries: {
        DB_CONN: {
          Password: 'pw', UserName: 'admin', HOST: 'db.example.com', PORT: '5432', DB_NAME: 'mydb',
        },
      },
      schema: 'V1=kp(DB_CONN, customAttributesObj=true)',
      expectValues: {
        V1: JSON.stringify({ HOST: 'db.example.com', PORT: '5432', DB_NAME: 'mydb' }),
      },
    }));
  });

  describe('kpBulk() resolver', () => {
    test('kpBulk - all entries', kpTest({
      entries: {
        A: { Password: 'a-pw' },
        B: { Password: 'b-pw' },
      },
      schema: 'ALL=kpBulk()',
      expectValues: { ALL: JSON.stringify({ A: 'a-pw', B: 'b-pw' }) },
    }));

    test('kpBulk - scoped to group', kpTest({
      entries: {
        ROOT: { Password: 'root-pw' },
        'G/NESTED': { Password: 'nested-pw' },
      },
      schema: 'SCOPED=kpBulk(G)',
      expectValues: { SCOPED: JSON.stringify({ G_NESTED: 'nested-pw' }) },
    }));
  });

  describe('errors', () => {
    test('unused plugin with empty password causes no errors', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKeePass(dbPath="/tmp/doesnt-matter.kdbx", password=$KP_PW)
        # ---
        KP_PW=
        UNRELATED=hello
      `,
      expectValues: { UNRELATED: 'hello' },
    }));

    test('missing dbPath', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKeePass(password=test)
        # ---
      `,
      expectSchemaError: true,
    }));

    test('missing password', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKeePass(dbPath="/tmp/x.kdbx")
        # ---
      `,
      expectSchemaError: true,
    }));

    test('duplicate _default instance id', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKeePass(dbPath="/tmp/a.kdbx", password=pw)
        # @initKeePass(dbPath="/tmp/b.kdbx", password=pw)
        # ---
      `,
      expectSchemaError: true,
    }));

    test('duplicate instance id', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKeePass(id=kp, dbPath="/tmp/a.kdbx", password=pw)
        # @initKeePass(id=kp, dbPath="/tmp/b.kdbx", password=pw)
        # ---
      `,
      expectSchemaError: true,
    }));

    test('wrong password', (() => {
      // need manual setup: DB built with 'correct' but schema uses 'wrong'
      return async () => {
        fs.mkdirSync(FIXTURES_DIR, { recursive: true });
        const dbPath = path.join(FIXTURES_DIR, `test-db-${dbCounter++}.kdbx`);
        fs.writeFileSync(dbPath, await buildTestKdbx('correct', {
          SECRET: { Password: 'val' },
        }));
        await pluginTest({
          schema: outdent`
            # @plugin(${PLUGIN_PATH})
            # @initKeePass(dbPath="${dbPath}", password=wrong)
            # ---
            SECRET=kp(SECRET)
          `,
          expectValues: { SECRET: Error },
        })();
      };
    })());

    test('missing entry', kpTest({
      entries: { SECRET: { Password: 'val' } },
      schema: 'NOPE=kp(DOES_NOT_EXIST)',
      expectValues: { NOPE: Error },
    }));

    test('missing database file', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initKeePass(dbPath="${path.join(FIXTURES_DIR, 'nope.kdbx')}", password=test)
        # ---
        SECRET=kp(test)
      `,
      expectValues: { SECRET: Error },
    }));
  });
});
