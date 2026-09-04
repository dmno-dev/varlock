import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import {
  describe, test, beforeAll, afterAll, beforeEach, afterEach, expect, vi,
} from 'vitest';
import outdent from 'outdent';
import { pluginTest } from 'varlock/test-helpers';
import { InMemoryCacheStore } from '../../../varlock/src/lib/cache/in-memory-cache-store';
import { generateTotp } from '../../../varlock/src/lib/otp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const MFA_SECRET_B32 = 'JBSWY3DPEHPK3PXP';
const MFA_SERIAL = 'arn:aws:iam::123456789012:mfa/test-user';
const ASSUMED_CREDS = {
  accessKeyId: 'ASIAFAKEFAKEFAKEFAKE',
  secretAccessKey: 'assumed-secret-access-key-fake-fake-fake',
  sessionToken: 'assumed-session-token-fake',
};
const SECRET_VALUE = 'shhh-its-a-secret';

// ── Fake STS + Secrets Manager endpoints ─────────────────────────────
// The AWS SDK honors AWS_ENDPOINT_URL_STS / AWS_ENDPOINT_URL_SECRETS_MANAGER,
// including for the internal STS client used by the ini credential provider's
// role assumption, so we can run the whole flow against local servers.

let stsRequests: Array<Record<string, string>> = [];
let smRequests: Array<{ headers: http.IncomingHttpHeaders, body: any }> = [];
/** how long the fake STS says the assumed session is good for */
let stsSessionDurationMs = 3600 * 1000;
/** when set, the fake STS rejects this request number and every one after it */
let stsFailFromRequest: number | undefined;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}

const stsServer = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const params = Object.fromEntries(new URLSearchParams(body));
  stsRequests.push(params);

  if (stsFailFromRequest !== undefined && stsRequests.length >= stsFailFromRequest) {
    // AccessDenied is non-retryable, so the SDK will not retry this on its own
    res.writeHead(403, { 'content-type': 'text/xml', date: new Date().toUTCString() });
    res.end(outdent`
      <ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
        <Error>
          <Type>Sender</Type>
          <Code>AccessDenied</Code>
          <Message>MultiFactorAuthentication failed, invalid MFA one time pass code</Message>
        </Error>
        <RequestId>fake-error-id</RequestId>
      </ErrorResponse>
    `);
    return;
  }

  const expiration = new Date(Date.now() + stsSessionDurationMs).toISOString();
  res.writeHead(200, { 'content-type': 'text/xml', date: new Date().toUTCString() });
  res.end(outdent`
    <AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
      <AssumeRoleResult>
        <Credentials>
          <AccessKeyId>${ASSUMED_CREDS.accessKeyId}</AccessKeyId>
          <SecretAccessKey>${ASSUMED_CREDS.secretAccessKey}</SecretAccessKey>
          <SessionToken>${ASSUMED_CREDS.sessionToken}</SessionToken>
          <Expiration>${expiration}</Expiration>
        </Credentials>
        <AssumedRoleUser>
          <Arn>arn:aws:sts::123456789012:assumed-role/test-role/varlock</Arn>
          <AssumedRoleId>AROFAKEFAKEFAKEFAKE:varlock</AssumedRoleId>
        </AssumedRoleUser>
      </AssumeRoleResult>
      <ResponseMetadata><RequestId>fake-request-id</RequestId></ResponseMetadata>
    </AssumeRoleResponse>
  `);
});

/** optional hook run after each Secrets Manager request, used to advance the clock mid-load */
let onSmRequest: (() => void) | undefined;

const smServer = http.createServer(async (req, res) => {
  const body = await readBody(req);
  smRequests.push({ headers: req.headers, body: JSON.parse(body || '{}') });
  onSmRequest?.();
  res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1', date: new Date().toUTCString() });
  res.end(JSON.stringify({
    ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret-AbCdEf',
    Name: 'test-secret',
    SecretString: SECRET_VALUE,
    VersionId: 'fake-version',
  }));
});

// env vars the SDK reads directly - saved/restored around the suite
const ENV_KEYS = [
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_ENDPOINT_URL_STS',
  'AWS_ENDPOINT_URL_SECRETS_MANAGER',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
];
let savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];

  await new Promise<void>((resolve) => {
    stsServer.listen(0, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => {
    smServer.listen(0, '127.0.0.1', resolve);
  });
  process.env.AWS_ENDPOINT_URL_STS = `http://127.0.0.1:${(stsServer.address() as AddressInfo).port}`;
  process.env.AWS_ENDPOINT_URL_SECRETS_MANAGER = `http://127.0.0.1:${(smServer.address() as AddressInfo).port}`;
  process.env.AWS_CONFIG_FILE = path.join(FIXTURES_DIR, 'aws-config');
  process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(FIXTURES_DIR, 'aws-credentials');
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await new Promise((resolve) => {
    stsServer.close(resolve);
  });
  await new Promise((resolve) => {
    smServer.close(resolve);
  });
});

beforeEach(() => {
  stsRequests = [];
  smRequests = [];
  stsSessionDurationMs = 3600 * 1000;
  stsFailFromRequest = undefined;
  onSmRequest = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mfaSchema(opts?: { mfaToken?: string | false }) {
  const mfaTokenParam = opts?.mfaToken === false
    ? ''
    : `, mfaToken=${opts?.mfaToken || 'generateOtp($MFA_SECRET)'}`;
  return outdent`
    # @plugin(${PLUGIN_PATH})
    # @cache=memory
    # @initAws(region=us-east-1, profile=mfa-role${mfaTokenParam})
    # ---
    # @sensitive @internal
    MFA_SECRET=
    SOME_SECRET=awsSecret("test-secret")
  `;
}

describe('MFA-protected profiles', () => {
  test('assumes an mfa_serial role profile, generating the TOTP code lazily', async () => {
    await pluginTest({
      schema: mfaSchema(),
      injectValues: { MFA_SECRET: MFA_SECRET_B32 },
      expectValues: { SOME_SECRET: SECRET_VALUE },
    })();

    // STS was called once, with the serial from the config file and a valid TOTP code
    expect(stsRequests.length).toBe(1);
    expect(stsRequests[0].Action).toBe('AssumeRole');
    expect(stsRequests[0].SerialNumber).toBe(MFA_SERIAL);
    // allow the previous window in case the code rotated mid-test
    const validCodes = [
      generateTotp({ secret: MFA_SECRET_B32 }).code,
      generateTotp({ secret: MFA_SECRET_B32, now: Date.now() - 30_000 }).code,
    ];
    expect(validCodes).toContain(stsRequests[0].TokenCode);

    // the secrets manager call used the assumed session creds, not the source profile creds
    expect(smRequests.length).toBe(1);
    expect(smRequests[0].headers.authorization).toContain(ASSUMED_CREDS.accessKeyId);
    expect(smRequests[0].headers['x-amz-security-token']).toBe(ASSUMED_CREDS.sessionToken);
  });

  test('caches session creds and skips STS + mfaToken resolution on later loads', async () => {
    const setSpy = vi.spyOn(InMemoryCacheStore.prototype, 'set');

    await pluginTest({
      schema: mfaSchema(),
      injectValues: { MFA_SECRET: MFA_SECRET_B32 },
      expectValues: { SOME_SECRET: SECRET_VALUE },
    })();
    expect(stsRequests.length).toBe(1);

    // session creds were written to the (encrypted in real usage) plugin cache
    const sessionSetCall = setSpy.mock.calls.find(([key]) => key.includes('stsSession'));
    expect(sessionSetCall).toBeDefined();
    const [, cachedValue] = sessionSetCall!;
    expect(cachedValue.accessKeyId).toBe(ASSUMED_CREDS.accessKeyId);

    // simulate a later load finding the cached session creds (each pluginTest run
    // gets a fresh store, so we stub `get` to return the captured entry).
    // MFA_SECRET is invalid here - if the mfaToken resolver were invoked eagerly,
    // generateOtp() would fail the load. cached creds mean it is never resolved.
    vi.spyOn(InMemoryCacheStore.prototype, 'get').mockImplementation(async (key: string) => (
      key.includes('stsSession')
        ? { value: cachedValue, cachedAt: Date.now(), expiresAt: Date.now() + 3500_000 }
        : undefined
    ));
    await pluginTest({
      schema: mfaSchema(),
      injectValues: { MFA_SECRET: 'not-valid-base32-!!!' },
      expectValues: { SOME_SECRET: SECRET_VALUE },
    })();
    expect(stsRequests.length).toBe(1); // no additional STS call
  });

  test('does not cache a session too short to be worth sharing', async () => {
    // shorter than the expiry buffer, so it would be stale before another run could use
    // it. the TTL callback returns a non-positive value and the write is skipped, which
    // is what keeps "an entry exists" equivalent to "the session is still usable"
    stsSessionDurationMs = 2 * 60 * 1000;
    const setSpy = vi.spyOn(InMemoryCacheStore.prototype, 'set');

    await pluginTest({
      schema: mfaSchema(),
      injectValues: { MFA_SECRET: MFA_SECRET_B32 },
      expectValues: { SOME_SECRET: SECRET_VALUE },
    })();

    // the load still succeeds off the freshly assumed session
    expect(stsRequests.length).toBe(1);
    expect(setSpy.mock.calls.filter(([key]) => key.includes('stsSession'))).toHaveLength(0);
  });

  test('assumes the role through the shared cache lock, for parallel runs', async () => {
    const getOrSetSpy = vi.spyOn(InMemoryCacheStore.prototype, 'getOrSet');
    const setSpy = vi.spyOn(InMemoryCacheStore.prototype, 'set');

    await pluginTest({
      schema: mfaSchema(),
      injectValues: { MFA_SECRET: MFA_SECRET_B32 },
      expectValues: { SOME_SECRET: SECRET_VALUE },
    })();

    // the assume runs inside getOrSet, which is what holds the cross-process lock.
    // a plain get/set pair would let parallel varlock runs in separate processes
    // (turborepo, several dev servers) each assume with the same spent TOTP code
    const sessionFetch = getOrSetSpy.mock.calls.find(([key]) => key.includes('stsSession'));
    expect(sessionFetch).toBeDefined();

    // one write, with the TTL derived from what STS actually returned. the entry expires
    // exactly when the session stops being usable, so another process never picks up one
    // it would have to second-guess
    const sessionWrites = setSpy.mock.calls.filter(([key]) => key.includes('stsSession'));
    expect(sessionWrites.length).toBe(1);
    const ttlMs = sessionWrites[0][2];
    const expectedTtlMs = stsSessionDurationMs - 5 * 60 * 1000;
    expect(ttlMs).toBeGreaterThan(expectedTtlMs - 10_000);
    expect(ttlMs).toBeLessThanOrEqual(expectedTtlMs);
  });

  test('refreshes an expiring session within a long-lived process', async () => {
    // only Date is faked - the servers still need real timers for network IO
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = new Date('2026-08-28T12:00:00Z').getTime();
    vi.setSystemTime(startedAt);

    // jump forward once the first secret is fetched, so the 1 hour session is inside
    // the SDK's refresh threshold by the time the second lookup resolves credentials.
    // this is the long-lived process case: one graph, hours apart
    onSmRequest = () => {
      if (smRequests.length === 1) vi.setSystemTime(startedAt + 56 * 60 * 1000);
    };

    // SECRET_B references SECRET_A so the two lookups are sequential rather than
    // coalesced into a single credential resolution (the fake SM server ignores the name)
    await pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @cache=memory
        # @initAws(region=us-east-1, profile=mfa-role, mfaToken=generateOtp($MFA_SECRET))
        # ---
        # @sensitive @internal
        MFA_SECRET=
        SECRET_A=awsSecret("test-secret")
        SECRET_B=awsSecret("\${SECRET_A}-two")
      `,
      injectValues: { MFA_SECRET: MFA_SECRET_B32 },
      expectValues: { SECRET_A: SECRET_VALUE, SECRET_B: SECRET_VALUE },
    })();

    expect(smRequests.length).toBe(2);
    // the expiring session was refreshed rather than reused past its life...
    // ...and the re-assume cooldown kept it to exactly one extra call. the SDK asks
    // its credential provider several times per request in this state, and each
    // assume burns a single-use MFA code, so a burst would fail against real AWS
    expect(stsRequests.length).toBe(2);
    for (const req of stsRequests) {
      expect(req.SerialNumber).toBe(MFA_SERIAL);
      expect(req.TokenCode).toMatch(/^\d{6}$/);
    }
    // the refresh used a code from the new TOTP window, not a replay of the spent one
    expect(stsRequests[1].TokenCode).not.toBe(stsRequests[0].TokenCode);
  });

  test('does not replay a spent code after a failed refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = new Date('2026-08-28T12:00:00Z').getTime();
    vi.setSystemTime(startedAt);
    onSmRequest = () => {
      if (smRequests.length === 1) vi.setSystemTime(startedAt + 56 * 60 * 1000);
    };
    // the initial assume succeeds, the refresh is rejected
    stsFailFromRequest = 2;

    const g = await pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @cache=memory
        # @initAws(region=us-east-1, profile=mfa-role, mfaToken=generateOtp($MFA_SECRET))
        # ---
        # @sensitive @internal
        MFA_SECRET=
        SECRET_A=awsSecret("test-secret")
        SECRET_B=awsSecret("\${SECRET_A}-two")
      `,
      injectValues: { MFA_SECRET: MFA_SECRET_B32 },
      expectValues: { SECRET_A: SECRET_VALUE, SECRET_B: Error },
    })();

    // one initial assume and one refresh attempt - the failure is not retried within
    // this load. note the cooldown that also blocks a retry in a later resolution pass
    // is not what this asserts; the graph coalesces concurrent callers before reaching it
    expect(stsRequests.length).toBe(2);
    expect(g!.configSchema.SECRET_B.errors.length).toBeGreaterThan(0);
  });

  test('shares one role assumption between concurrent callers', async () => {
    // two instances pointing at the same region and profile share a cache key, so they
    // coalesce onto a single assume. a second would replay a code the first just spent
    await pluginTest({
      schema: outdent`
        # @plugin(${PLUGIN_PATH})
        # @cache=memory
        # @initAws(id=one, region=us-east-1, profile=mfa-role, mfaToken=generateOtp($MFA_SECRET))
        # @initAws(id=two, region=us-east-1, profile=mfa-role, mfaToken=generateOtp($MFA_SECRET))
        # ---
        # @sensitive @internal
        MFA_SECRET=
        SECRET_ONE=awsSecret(one, "test-secret")
        SECRET_TWO=awsSecret(two, "test-secret")
      `,
      injectValues: { MFA_SECRET: MFA_SECRET_B32 },
      expectValues: { SECRET_ONE: SECRET_VALUE, SECRET_TWO: SECRET_VALUE },
    })();

    expect(smRequests.length).toBe(2);
    expect(stsRequests.length).toBe(1);
  });

  test('fails with an actionable error when the profile requires MFA but no mfaToken is set', async () => {
    const g = await pluginTest({
      schema: mfaSchema({ mfaToken: false }),
      injectValues: { MFA_SECRET: MFA_SECRET_B32 },
      expectValues: { SOME_SECRET: Error },
    })();

    const itemError = g!.configSchema.SOME_SECRET.errors[0];
    expect(itemError.message).toContain('multi-factor');
    expect((itemError as any).tip).toContain('mfaToken');
    expect(stsRequests.length).toBe(0);
  });

  test('fails cleanly when mfaToken resolves to an empty value', async () => {
    const g = await pluginTest({
      schema: mfaSchema({ mfaToken: '""' }),
      injectValues: { MFA_SECRET: MFA_SECRET_B32 },
      expectValues: { SOME_SECRET: Error },
    })();

    const itemError = g!.configSchema.SOME_SECRET.errors[0];
    expect(itemError.message).toContain('mfaToken');
  });
});
