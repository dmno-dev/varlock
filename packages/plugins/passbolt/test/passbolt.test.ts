import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  describe, test, beforeAll, afterAll, afterEach,
} from 'vitest';
import outdent from 'outdent';
import {
  generateKey, createMessage, encrypt, readKey, sign, createCleartextMessage,
} from 'openpgp';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { pluginTest } from 'varlock/test-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..');

// ── Crypto fixtures ──────────────────────────────────────────────────

const TEST_PASSPHRASE = 'test-passphrase';
const TEST_USER_ID = randomUUID();
const TEST_SERVER_URL = 'https://passbolt.test';

// resource UUIDs (valid v4)
const RES_SIMPLE = '01234567-0123-4567-890a-bcdef0123456';
const RES_WITH_FIELDS = '11111111-1111-4111-a111-111111111111';
const FOLDER_ID = '22222222-2222-4222-b222-222222222222';

// will be populated in beforeAll
let userPrivateKeyArmored: string;
let userPublicKeyArmored: string;
let serverPrivateKeyArmored: string;
let serverPublicKeyArmored: string;
let accountKitBase64: string;

async function encryptForUser(data: Record<string, any>): Promise<string> {
  const pub = await readKey({ armoredKey: userPublicKeyArmored });
  const message = await createMessage({ text: JSON.stringify(data) });
  return await encrypt({ message, encryptionKeys: pub }) as string;
}

beforeAll(async () => {
  const { decryptKey, readPrivateKey } = await import('openpgp');

  // generate user keypair (with passphrase — matches real Passbolt flow)
  const userKey = await generateKey({
    type: 'ecc',
    curve: 'curve25519',
    userIDs: [{ name: 'Test User', email: 'test@passbolt.test' }],
    passphrase: TEST_PASSPHRASE,
    format: 'armored',
  });
  userPrivateKeyArmored = userKey.privateKey;
  userPublicKeyArmored = userKey.publicKey;

  // generate server keypair (no passphrase)
  const serverKey = await generateKey({
    type: 'ecc',
    curve: 'curve25519',
    userIDs: [{ name: 'Passbolt Server', email: 'server@passbolt.test' }],
    format: 'armored',
  });
  serverPrivateKeyArmored = serverKey.privateKey;
  serverPublicKeyArmored = serverKey.publicKey;

  // build account kit: cleartext-signed JSON, base64 encoded
  // the account kit embeds the user's keys and is signed by the user's private key
  const accountKitData = {
    domain: TEST_SERVER_URL,
    user_id: TEST_USER_ID,
    username: 'test@passbolt.test',
    first_name: 'Test',
    last_name: 'User',
    user_private_armored_key: userPrivateKeyArmored,
    user_public_armored_key: userPublicKeyArmored,
    server_public_armored_key: serverPublicKeyArmored,
    security_token: { code: 'TST', color: '#000000', textcolor: '#ffffff' },
  };

  // sign the account kit with the user's private key (decrypted)
  const userPrivKey = await readPrivateKey({ armoredKey: userPrivateKeyArmored });
  const decryptedUserKey = await decryptKey({ privateKey: userPrivKey, passphrase: TEST_PASSPHRASE });

  const cleartextMessage = await createCleartextMessage({ text: JSON.stringify(accountKitData) });
  const signedMessage = await sign({
    message: cleartextMessage,
    signingKeys: decryptedUserKey,
  });

  accountKitBase64 = Buffer.from(signedMessage as string).toString('base64');
});


// ── MSW Server ───────────────────────────────────────────────────────

// Test resources (V4 format - plaintext metadata, encrypted secret)
const TEST_RESOURCES: Record<string, { name: string; username: string; uri: string; password: string }> = {
  [RES_SIMPLE]: {
    name: 'Simple Secret', username: 'admin', uri: 'https://example.com', password: 'super-secret-pw',
  },
  [RES_WITH_FIELDS]: {
    name: 'DB Connection', username: 'dbuser', uri: 'postgres://localhost/mydb', password: 'db-password',
  },
};

const FOLDER_RESOURCES = [RES_SIMPLE, RES_WITH_FIELDS];

const server = setupServer(
  // GET /auth/verify.json - return server public key
  http.get(`${TEST_SERVER_URL}/auth/verify.json`, () => {
    return HttpResponse.json({
      body: {
        fingerprint: 'ABCD1234',
        keydata: serverPublicKeyArmored,
      },
    });
  }),

  // POST /auth/jwt/login.json - handle GPG challenge auth
  http.post(`${TEST_SERVER_URL}/auth/jwt/login.json`, async ({ request }) => {
    const body = await request.json() as { user_id: string; challenge: string };

    // decrypt the challenge from the client using server private key
    const {
      readMessage, decrypt, readPrivateKey,
    } = await import('openpgp');
    const serverPrivKey = await readPrivateKey({ armoredKey: serverPrivateKeyArmored });
    // server key has no passphrase
    const msg = await readMessage({ armoredMessage: body.challenge });
    const { data } = await decrypt({ message: msg, decryptionKeys: serverPrivKey });
    const challenge = JSON.parse(data);

    // build challenge response with tokens
    const challengeResponse = {
      ...challenge,
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
    };

    // encrypt response for user
    const encryptedResponse = await encryptForUser(challengeResponse);

    return HttpResponse.json({
      body: { challenge: encryptedResponse },
    });
  }),

  // POST /auth/jwt/logout.json
  http.post(`${TEST_SERVER_URL}/auth/jwt/logout.json`, () => {
    return HttpResponse.json({ body: null });
  }),

  // GET /metadata/keys.json - no v5 metadata keys for our tests
  http.get(`${TEST_SERVER_URL}/metadata/keys.json`, () => {
    return HttpResponse.json({ body: [] });
  }),

  // GET /resources/:id.json - single resource
  http.get(`${TEST_SERVER_URL}/resources/:id.json`, async ({ params }) => {
    const id = decodeURIComponent(params.id as string);
    const res = TEST_RESOURCES[id];
    if (!res) {
      return HttpResponse.json({ header: { message: 'Not found' } }, { status: 404 });
    }

    const secret: Record<string, any> = { password: res.password };
    const encryptedSecret = await encryptForUser(secret);

    return HttpResponse.json({
      body: {
        id,
        name: res.name,
        username: res.username,
        uri: res.uri,
        description: '',
        deleted: false,
        created: '2024-01-01T00:00:00Z',
        created_by: TEST_USER_ID,
        modified_by: TEST_USER_ID,
        resource_type_id: 'test-type',
        expired: '',
        folder_parent_id: FOLDER_ID,
        personal: false,
        secrets: [
          {
            id: randomUUID(),
            user_id: TEST_USER_ID,
            resource_id: id,
            data: encryptedSecret,
            created: '2024-01-01T00:00:00Z',
            modified: '2024-01-01T00:00:00Z',
          },
        ],
      },
    });
  }),

  // GET /resources.json - resources in folder
  http.get(`${TEST_SERVER_URL}/resources.json`, async ({ request }) => {
    const url = new URL(request.url);
    const parentId = url.searchParams.get('filter[has-parent]');

    const resources = [];
    for (const resId of FOLDER_RESOURCES) {
      const res = TEST_RESOURCES[resId];
      if (!res) continue;

      const secret: Record<string, any> = { password: res.password };
      const encryptedSecret = await encryptForUser(secret);

      resources.push({
        id: resId,
        name: res.name,
        username: res.username,
        uri: res.uri,
        description: '',
        deleted: false,
        created: '2024-01-01T00:00:00Z',
        created_by: TEST_USER_ID,
        modified_by: TEST_USER_ID,
        resource_type_id: 'test-type',
        expired: '',
        folder_parent_id: parentId,
        personal: false,
        secrets: [
          {
            id: randomUUID(),
            user_id: TEST_USER_ID,
            resource_id: resId,
            data: encryptedSecret,
            created: '2024-01-01T00:00:00Z',
            modified: '2024-01-01T00:00:00Z',
          },
        ],
      });
    }

    return HttpResponse.json({ body: resources });
  }),

  // GET /folders.json
  http.get(`${TEST_SERVER_URL}/folders.json`, () => {
    return HttpResponse.json({
      body: [
        {
          id: FOLDER_ID,
          name: 'TestFolder',
          created: '2024-01-01T00:00:00Z',
          modified: '2024-01-01T00:00:00Z',
          created_by: TEST_USER_ID,
          modified_by: TEST_USER_ID,
          folder_parent_id: null,
          personal: false,
        },
      ],
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());


// ── Test helper ──────────────────────────────────────────────────────

function pbTest(opts: {
  schema: string;
  injectAccountKit?: boolean;
} & Omit<Parameters<typeof pluginTest>[0], 'schema'>) {
  const { schema, injectAccountKit = true, ...rest } = opts;

  return async () => {
    const fullSchema = outdent`
      # @plugin(${PLUGIN_PATH})
      # @initPassbolt(accountKit=$PB_ACCOUNT_KIT, passphrase=$PB_PASSPHRASE)
      # ---
      # @type=string @sensitive
      PB_ACCOUNT_KIT=
      # @type=string @sensitive
      PB_PASSPHRASE=
      ${schema}
    `;

    await pluginTest({
      ...rest,
      schema: fullSchema,
      injectValues: {
        ...(injectAccountKit ? {
          PB_ACCOUNT_KIT: accountKitBase64,
          PB_PASSPHRASE: TEST_PASSPHRASE,
        } : {}),
        ...rest.injectValues,
      },
    })();
  };
}


// ── Tests ────────────────────────────────────────────────────────────

describe('passbolt plugin', () => {
  describe('passbolt() resolver', () => {
    test('fetch password by resource UUID', pbTest({
      schema: `SECRET=passbolt("${RES_SIMPLE}")`,
      expectValues: { SECRET: 'super-secret-pw' },
    }));

    test('fetch username via hash syntax', pbTest({
      schema: `PB_USER=passbolt("${RES_SIMPLE}#username")`,
      expectValues: { PB_USER: 'admin' },
    }));

    test('fetch uri via hash syntax', pbTest({
      schema: `PB_URI=passbolt("${RES_SIMPLE}#uri")`,
      expectValues: { PB_URI: 'https://example.com' },
    }));

    test('fetch field via named parameter', pbTest({
      schema: `PB_USER=passbolt("${RES_SIMPLE}", field="username")`,
      expectValues: { PB_USER: 'admin' },
    }));
  });

  describe('passboltFolder() resolver', () => {
    test('bulk load folder by name', pbTest({
      schema: 'ALL=passboltFolder("TestFolder")',
      expectValues: {
        ALL: JSON.stringify({
          'Simple Secret': 'super-secret-pw',
          'DB Connection': 'db-password',
        }),
      },
    }));

    test('bulk load folder with field=username', pbTest({
      schema: 'ALL=passboltFolder("TestFolder", field="username")',
      expectValues: {
        ALL: JSON.stringify({
          'Simple Secret': 'admin',
          'DB Connection': 'dbuser',
        }),
      },
    }));
  });

  describe('errors', () => {
    test('missing accountKit param', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initPassbolt(passphrase=$PB_PASSPHRASE)
        # ---
        # @type=string @sensitive
        PB_PASSPHRASE=
      `,
      expectSchemaError: true,
    }));

    test('missing passphrase param', pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @initPassbolt(accountKit=$PB_ACCOUNT_KIT)
        # ---
        # @type=string @sensitive
        PB_ACCOUNT_KIT=
      `,
      expectSchemaError: true,
    }));

    test('invalid resource UUID format', pbTest({
      schema: 'SECRET=passbolt("not-a-uuid")',
      expectValues: { SECRET: Error },
    }));

    test('resource not found returns error', pbTest({
      schema: 'SECRET=passbolt("99999999-9999-4999-a999-999999999999")',
      expectValues: { SECRET: Error },
    }));
  });
});
