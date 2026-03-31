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
const RES_V5_CUSTOM = '33333333-3333-4333-b333-333333333333';
const FOLDER_ID = '22222222-2222-4222-b222-222222222222';
const METADATA_KEY_ID = '44444444-4444-4444-a444-444444444444';

// will be populated in beforeAll
let userPrivateKeyArmored: string;
let userPublicKeyArmored: string;
let serverPrivateKeyArmored: string;
let serverPublicKeyArmored: string;
let accountKitBase64: string;
let metadataPrivateKeyArmored: string;
let metadataPublicKeyArmored: string;

async function encryptForKey(data: Record<string, any>, publicKeyArmored: string): Promise<string> {
  const pub = await readKey({ armoredKey: publicKeyArmored });
  const message = await createMessage({ text: JSON.stringify(data) });
  return await encrypt({ message, encryptionKeys: pub }) as string;
}

async function encryptForUser(data: Record<string, any>): Promise<string> {
  return encryptForKey(data, userPublicKeyArmored);
}

beforeAll(async () => {
  const { decryptKey, readPrivateKey } = await import('openpgp');

  // generate user keypair (with passphrase — matches real Passbolt flow)
  const userKey = await generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
    userIDs: [{ name: 'Test User', email: 'test@passbolt.test' }],
    passphrase: TEST_PASSPHRASE,
    format: 'armored',
  });
  userPrivateKeyArmored = userKey.privateKey;
  userPublicKeyArmored = userKey.publicKey;

  // generate server keypair (no passphrase)
  const serverKey = await generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
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

  // generate metadata keypair (no passphrase) for V5 resources
  const metadataKey = await generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
    userIDs: [{ name: 'Metadata Key', email: 'metadata@passbolt.test' }],
    format: 'armored',
  });
  metadataPrivateKeyArmored = metadataKey.privateKey;
  metadataPublicKeyArmored = metadataKey.publicKey;
});


// ── MSW Server ───────────────────────────────────────────────────────

type TestResource = {
  name: string;
  username: string;
  uri: string;
  password: string;
  v5?: boolean; // if true, use V5 format with encrypted metadata
  customFields?: Record<string, string>; // custom field name → value
};

const TEST_RESOURCES: Record<string, TestResource> = {
  [RES_SIMPLE]: {
    name: 'Simple Secret', username: 'admin', uri: 'https://example.com', password: 'super-secret-pw',
  },
  [RES_WITH_FIELDS]: {
    name: 'DB Connection', username: 'dbuser', uri: 'postgres://localhost/mydb', password: 'db-password',
  },
  [RES_V5_CUSTOM]: {
    name: 'Custom Resource',
    username: 'customuser',
    uri: 'https://custom.example.com',
    password: 'custom-pw',
    v5: true,
    customFields: { API_KEY: 'key-123', DB_HOST: 'db.internal' },
  },
};

const FOLDER_RESOURCES = [RES_SIMPLE, RES_WITH_FIELDS];

async function buildApiResource(id: string, res: TestResource) {
  // build encrypted secret
  const secret: Record<string, any> = { password: res.password };
  if (res.customFields) {
    // V5 custom fields: values go in the secret, keyed by id
    secret.custom_fields = Object.entries(res.customFields).map(([_name, value], i) => ({
      id: `cf-${i}`,
      type: 'text',
      secret_value: value,
    }));
  }
  const encryptedSecret = await encryptForUser(secret);

  const secretEntry = {
    id: randomUUID(),
    user_id: TEST_USER_ID,
    resource_id: id,
    data: encryptedSecret,
    created: '2024-01-01T00:00:00Z',
    modified: '2024-01-01T00:00:00Z',
  };

  if (res.v5) {
    // V5 format: metadata is encrypted with metadata key
    const metadata: Record<string, any> = {
      object_type: 'PASSBOLT_RESOURCE_METADATA',
      resource_type_id: 'test-type',
      name: res.name,
      username: res.username,
      uris: [res.uri],
    };
    if (res.customFields) {
      // custom field keys go in metadata, matched by id
      metadata.custom_fields = Object.keys(res.customFields).map((name, i) => ({
        id: `cf-${i}`,
        type: 'text',
        metadata_key: name,
      }));
    }
    const encryptedMetadata = await encryptForKey(metadata, metadataPublicKeyArmored);

    return {
      id,
      metadata: encryptedMetadata,
      metadata_key_id: METADATA_KEY_ID,
      metadata_key_type: 'shared_key',
      created: '2024-01-01T00:00:00Z',
      modified: '2024-01-01T00:00:00Z',
      created_by: TEST_USER_ID,
      modified_by: TEST_USER_ID,
      personal: false,
      folder_parent_id: FOLDER_ID,
      resource_type_id: 'test-type',
      expired: '',
      secrets: [secretEntry],
    };
  }

  // V4 format: plaintext metadata
  return {
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
    secrets: [secretEntry],
  };
}

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

  // GET /metadata/keys.json - return metadata key encrypted for user
  http.get(`${TEST_SERVER_URL}/metadata/keys.json`, async () => {
    const { origin } = new URL(TEST_SERVER_URL);
    const encryptedMetadataKey = await encryptForUser({
      object_type: 'PASSBOLT_METADATA_PRIVATE_KEY',
      domain: origin,
      fingerprint: 'META1234',
      armored_key: metadataPrivateKeyArmored,
      passphrase: '',
    });

    return HttpResponse.json({
      body: [
        {
          metadata_private_keys: [
            {
              user_id: TEST_USER_ID,
              metadata_key_id: METADATA_KEY_ID,
              data: encryptedMetadataKey,
            },
          ],
        },
      ],
    });
  }),

  // GET /resources/:id.json - single resource
  http.get(`${TEST_SERVER_URL}/resources/:id.json`, async ({ params }) => {
    const id = decodeURIComponent(params.id as string);
    const res = TEST_RESOURCES[id];
    if (!res) {
      return HttpResponse.json({ header: { message: 'Not found' } }, { status: 404 });
    }

    return HttpResponse.json({ body: await buildApiResource(id, res) });
  }),

  // GET /resources.json - resources in folder
  http.get(`${TEST_SERVER_URL}/resources.json`, async () => {
    const resources = [];
    for (const resId of FOLDER_RESOURCES) {
      const res = TEST_RESOURCES[resId];
      if (!res) continue;
      resources.push(await buildApiResource(resId, res));
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

  describe('passboltBulk() resolver', () => {
    test('bulk load folder by path', pbTest({
      schema: 'ALL=passboltBulk(folderPath="TestFolder")',
      expectValues: {
        ALL: JSON.stringify({
          'Simple Secret': 'super-secret-pw',
          'DB Connection': 'db-password',
        }),
      },
    }));
  });

  describe('passbolt() with custom fields', () => {
    test('fetch custom field by name via hash syntax', pbTest({
      schema: `SECRET=passbolt("${RES_V5_CUSTOM}#API_KEY")`,
      expectValues: { SECRET: 'key-123' },
    }));

    test('fetch custom field via named parameter', pbTest({
      schema: `SECRET=passbolt("${RES_V5_CUSTOM}", field="DB_HOST")`,
      expectValues: { SECRET: 'db.internal' },
    }));
  });

  describe('passboltCustomFieldsObj() resolver', () => {
    test('fetch all custom fields as JSON object', pbTest({
      schema: `ALL=passboltCustomFieldsObj("${RES_V5_CUSTOM}")`,
      expectValues: {
        ALL: JSON.stringify({ API_KEY: 'key-123', DB_HOST: 'db.internal' }),
      },
    }));

    test('resource without custom fields returns error', pbTest({
      schema: `ALL=passboltCustomFieldsObj("${RES_SIMPLE}")`,
      expectValues: { ALL: Error },
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

    test('invalid totp field returns error', pbTest({
      schema: `SECRET=passbolt("${RES_SIMPLE}#totp.xyz")`,
      expectValues: { SECRET: Error },
    }));
  });
});
