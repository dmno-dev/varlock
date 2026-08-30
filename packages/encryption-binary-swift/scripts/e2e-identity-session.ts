/**
 * End-to-end check of the daemon's identity session protocol, with no human in
 * the loop.
 *
 * Everything runs against a throwaway `XDG_CONFIG_HOME`, and the custody key is
 * created with `--no-auth`, so the daemon's unlock finds no presence requirement
 * to satisfy and never prompts. That exercises the whole path (identity file,
 * unlock-session, decrypt-v2, list-sessions, invalidate-session) while leaving
 * the biometric handoff itself to `probe-session-unlock`, which does need a real
 * finger.
 *
 * It also covers the authorization log (that it is written, that it grows, that
 * it holds no secrets, and that a decrypt is denied when it cannot be written),
 * and restarts the daemon to prove that no grant survives it.
 *
 * The approval panel is covered here only in its refusing form. A second daemon
 * runs with `_VARLOCK_UI_MODE=headless` and `_VARLOCK_FORCE_UNLOCK_PROMPT=1`,
 * which together say "a question is required and there is no screen to ask on",
 * and every path that needs approval must answer NO_UI rather than proceeding.
 * Both env vars can only make the daemon stricter, never more permissive. Seeing
 * the panel itself needs a person; the package README says how.
 *
 * Needs a Mac with a Secure Enclave. Run it after building the binary:
 *
 *   swift build --package-path packages/encryption-binary-swift/swift
 *   bun run packages/encryption-binary-swift/scripts/e2e-identity-session.ts
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createKeyPair, encrypt, IDENTITY_PAYLOAD_VERSION } from '../../varlock/src/lib/local-encrypt/crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const binary = path.resolve(here, '../swift/.build/debug/VarlockEnclave');

if (!fs.existsSync(binary)) {
  throw new Error(`binary not built at ${binary}; run: swift build --package-path packages/encryption-binary-swift/swift`);
}

const KEY_ID = 'varlock-e2e-identity';
const IDENTITY_ID = 'default';

const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-e2e-'));
const env = { ...process.env, XDG_CONFIG_HOME: configHome };
const socketPath = path.join(configHome, 'daemon.sock');
const auditPath = path.join(configHome, 'varlock', 'audit', 'authorizations.jsonl');

/** Permission bits as a three-digit octal string, e.g. "600". */
function permissionsOf(target: string): string {
  return (fs.statSync(target).mode % 0o1000).toString(8).padStart(3, '0');
}

/** Every authorization record written so far, oldest first. */
function readAudit(): Array<any> {
  if (!fs.existsSync(auditPath)) return [];
  return fs.readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

function runBinary(args: Array<string>): any {
  return JSON.parse(execFileSync(binary, args, { env, encoding: 'utf-8' }));
}

// -- minimal IPC client (4-byte LE length prefix + JSON) --

class Client {
  private socket!: net.Socket;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(private readonly connectTo: string = socketPath) {}

  async connect() {
    await new Promise<void>((resolve, reject) => {
      this.socket = net.createConnection(this.connectTo);
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('data', (chunk) => this.onData(chunk));
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      const message = JSON.parse(body.toString());
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(Object.assign(new Error(message.error), { code: message.errorCode }));
      else waiter.resolve(message.result);
    }
  }

  /**
   * `timeoutMs` is per call. Anything that must answer without drawing UI gets a
   * short one: a check that only ever passes because it timed out is a check
   * that stopped testing anything.
   */
  send(action: string, payload?: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<any> {
    const id = Math.random().toString(36).slice(2);
    const body = Buffer.from(JSON.stringify({ id, action, payload }), 'utf-8');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length, 0);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(Object.assign(new Error(`timed out waiting for ${action}`), { code: 'E2E_TIMEOUT' }));
        }
      }, opts.timeoutMs ?? 30_000);
      this.socket.write(Buffer.concat([prefix, body]));
    });
  }

  close() {
    this.socket.end();
  }
}

/**
 * Every call here names the code it expects. Accepting any failure would let a
 * timeout, a crashed daemon, or a dialog nobody can dismiss count as a pass.
 */
async function expectError(label: string, fn: () => Promise<unknown>, expectedCode: string) {
  try {
    const result = await fn();
    check(label, false, { unexpectedSuccess: result });
  } catch (err: any) {
    check(label, err.code === expectedCode, { expected: expectedCode, code: err.code, message: err.message });
  }
}

// -- setup --

console.log(`config home: ${configHome}`);
const generated = runBinary(['generate-key', '--key-id', KEY_ID, '--no-auth']);
check('custody key created', generated.ok === true);

// Build an identity whose private key is wrapped to the custody key, exactly as
// the TS identity layer would write it.
const identityKeyPair = await createKeyPair();
const wrapped = runBinary(['encrypt', '--key-id', KEY_ID, '--data', Buffer.from(identityKeyPair.privateKey, 'utf-8').toString('base64')]);
check('identity key wrapped to custody key', typeof wrapped.ciphertext === 'string');

fs.mkdirSync(path.join(configHome, 'varlock', 'identities'), { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(configHome, 'varlock', 'identities', `${IDENTITY_ID}.json`),
  `${JSON.stringify({
    version: 1,
    id: IDENTITY_ID,
    publicKey: identityKeyPair.publicKey,
    wraps: { [KEY_ID]: wrapped.ciphertext },
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`,
  { mode: 0o600 },
);

const SECRETS = ['sk-first-value', 'sk-second-value-🔐', ''.padEnd(2048, 'x')];
const payloads = await Promise.all(
  SECRETS.map((secret) => encrypt(identityKeyPair.publicKey, secret, { version: IDENTITY_PAYLOAD_VERSION })),
);

// -- daemon --

async function startDaemon(opts: { socket: string; label: string; extraEnv?: Record<string, string> }) {
  const daemon = spawn(
    binary,
    ['daemon', '--socket-path', opts.socket, '--pid-path', `${opts.socket}.pid`],
    { env: { ...env, ...opts.extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    let out = '';
    daemon.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('"ready"')) resolve();
    });
    daemon.stderr.on('data', (d) => process.stderr.write(`[${opts.label}] ${d}`));
    daemon.on('exit', (code) => reject(new Error(`${opts.label} exited early with code ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`${opts.label} did not become ready`)), 10_000);
  });
  return daemon;
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a daemon and make sure it is really gone.
 *
 * A daemon left behind is holding enclave sessions on somebody's machine, with a
 * config home about to be deleted underneath it, so this escalates rather than
 * hoping. It also reports the escalation as a failed check: a daemon that does
 * not answer SIGTERM is a bug in the daemon, not a tidiness problem here.
 */
async function stopDaemon(child: ReturnType<typeof spawn>, label: string) {
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  child.kill('SIGTERM');
  await Promise.race([
    exited, new Promise((resolve) => {
      setTimeout(resolve, 5_000);
    }),
  ]);

  if (!isAlive(child.pid)) return;
  child.kill('SIGKILL');
  await Promise.race([
    exited, new Promise((resolve) => {
      setTimeout(resolve, 2_000);
    }),
  ]);
  check(`${label} exits on SIGTERM`, false, { pid: child.pid, note: 'needed SIGKILL' });
}

let daemon = await startDaemon({ socket: socketPath, label: 'daemon' });

let client = new Client();
await client.connect();

// A second daemon, started later, that cannot draw anything.
let headlessDaemon: ReturnType<typeof spawn> | undefined;
let headlessClient: Client | undefined;

try {
  console.log('\nping');
  const ping = await client.send('ping');
  check('reports protocol version 3', ping.protocolVersion === 3, ping);
  const sessionId = ping.sessionId;
  check('peer has a session identity', typeof sessionId === 'string' && sessionId.length > 0, ping);

  console.log('\ndecrypt-v2 without a grant');
  await expectError('refused before unlock', () => client.send('decrypt-v2', {
    keyId: KEY_ID, ciphertexts: [payloads[0]],
  }), 'NO_SESSION_GRANT');

  console.log('\nunlock-session');
  const unlocked = await client.send('unlock-session', {
    keyIds: [KEY_ID],
    scope: 'session',
    // Optional decoration. It may reach the panel's wording and nothing else.
    display: { projectName: 'e2e-project', projectPath: configHome, itemCounts: { [KEY_ID]: 3 } },
  });
  check('no prompt needed for a --no-auth key', unlocked.policy === 'no-presence-required', unlocked);
  check('reports that nobody was asked', unlocked.prompted === false, unlocked);
  check('one grant returned', unlocked.grants?.length === 1, unlocked);
  const sessionGrant = unlocked.grants?.[0] ?? {};
  check('grant is scoped to the requested key', sessionGrant.keyId === KEY_ID, unlocked);
  check('grant carries a 12h cap', sessionGrant.expiresAt - sessionGrant.grantedAt === 12 * 60 * 60 * 1000, unlocked);

  check('default lock policy is sleep', unlocked.lockOn === 'sleep', unlocked);
  check('default comes from the built-in default', unlocked.lockOnSource === 'built-in-default', unlocked);
  check('policy is reported per grant', unlocked.grants?.[0]?.lockOn === 'sleep', unlocked.grants?.[0]);

  console.log('\ndecrypt-v2 batch');
  const decrypted = await client.send('decrypt-v2', { keyId: KEY_ID, ciphertexts: payloads });
  check('every payload decrypted', JSON.stringify(decrypted.plaintexts) === JSON.stringify(SECRETS), decrypted.plaintexts?.length);
  check('batch counts as one use', decrypted.grant?.useCount === 1, decrypted.grant);

  const second = await client.send('decrypt-v2', { keyId: KEY_ID, ciphertext: payloads[0] });
  check('single-ciphertext form works', second.plaintexts?.[0] === SECRETS[0], second);
  check('session grant survives repeated use', second.grant?.useCount === 2, second.grant);

  console.log('\nauthorization log');
  check('audit file exists after the first decrypt', fs.existsSync(auditPath), auditPath);
  const auditAfterDecrypts = readAudit();
  check('records the unlock and both decrypts', auditAfterDecrypts.length >= 3, auditAfterDecrypts.length);
  const decryptRecords = auditAfterDecrypts.filter((r) => r.event === 'decrypt-v2');
  check('decrypt records name the key and payload count', decryptRecords.some(
    (r) => r.keyIds?.[0] === KEY_ID && r.payloadCount === SECRETS.length,
  ), decryptRecords);
  check('records carry the session identity', decryptRecords.every((r) => r.sessionId === sessionId), decryptRecords);
  check('records carry the scope used', decryptRecords.every((r) => r.scope === 'session'), decryptRecords);
  check('records describe the requester', decryptRecords.every(
    (r) => typeof r.requester === 'string' && r.requester.length > 0,
  ), decryptRecords);
  check('unlock is recorded too', auditAfterDecrypts.some((r) => r.event === 'unlock-session'), auditAfterDecrypts);
  check('audit file is owner-only', permissionsOf(auditPath) === '600', permissionsOf(auditPath));
  check(
    'audit directory is owner-only',
    permissionsOf(path.dirname(auditPath)) === '700',
    permissionsOf(path.dirname(auditPath)),
  );

  const rawAudit = fs.readFileSync(auditPath, 'utf-8');
  check('no plaintext in the log', !SECRETS.some((secret) => secret.length > 0 && rawAudit.includes(secret)));
  check('no key material in the log', !rawAudit.includes(identityKeyPair.privateKey.slice(0, 24)));
  check('no ciphertext in the log', !rawAudit.includes(payloads[0].slice(0, 24)));

  const beforeGrowth = readAudit().length;
  await client.send('decrypt-v2', { keyId: KEY_ID, ciphertext: payloads[0] });
  check('the log grows with each authorization', readAudit().length === beforeGrowth + 1, readAudit().length);

  console.log('\nauthorization log that cannot be written');
  // Nothing is decrypted that cannot be accounted for, so making the log
  // unwritable has to deny rather than degrade to silence.
  fs.chmodSync(auditPath, 0o400);
  await expectError('decrypt is denied when the record cannot be written', () => client.send('decrypt-v2', {
    keyId: KEY_ID, ciphertexts: [payloads[0]],
  }), 'AUDIT_WRITE_FAILED');
  await expectError('unlock is denied too', () => client.send('unlock-session', {
    keyIds: [KEY_ID], scope: 'session',
  }), 'AUDIT_WRITE_FAILED');
  check('a denied unlock leaves no grant behind', (await client.send('list-sessions')).sessions.length === 0);

  fs.chmodSync(auditPath, 0o600);
  await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'session' });
  const recovered = await client.send('decrypt-v2', { keyId: KEY_ID, ciphertexts: [payloads[0]] });
  check('decrypt works again once the log does', recovered.plaintexts?.[0] === SECRETS[0], recovered);

  console.log('\nwrong key id');
  await expectError('refused for a key with no grant', () => client.send('decrypt-v2', {
    keyId: 'some-other-key', ciphertexts: [payloads[0]],
  }), 'NO_SESSION_GRANT');

  console.log('\nlist-sessions');
  const listed = await client.send('list-sessions');
  check('lists the live grant', listed.sessions?.length === 1, listed);
  check('reports the scope label', listed.sessions?.[0]?.scope === 'session', listed.sessions?.[0]);
  check('reports remaining ttl', listed.sessions?.[0]?.expiresInMs > 0, listed.sessions?.[0]);
  check('reports unlock time', typeof listed.sessions?.[0]?.sessionUnlockedAt === 'number', listed.sessions?.[0]);
  check('never includes key material', !JSON.stringify(listed).includes(identityKeyPair.privateKey.slice(0, 24)), 'leak');

  console.log('\ninvalidate-session (this session only)');
  const invalidated = await client.send('invalidate-session', { sessionId });
  check('one grant dropped', invalidated.invalidated === 1, invalidated);
  check('nothing left to list', (await client.send('list-sessions')).sessions.length === 0);
  await expectError('decrypt refused after invalidate', () => client.send('decrypt-v2', {
    keyId: KEY_ID, ciphertexts: [payloads[0]],
  }), 'NO_SESSION_GRANT');

  console.log('\nonce-scoped grant');
  await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'once' });
  const onceResult = await client.send('decrypt-v2', { keyId: KEY_ID, ciphertexts: payloads });
  check('once grant serves its batch', onceResult.plaintexts?.length === SECRETS.length);
  await expectError('once grant is spent afterwards', () => client.send('decrypt-v2', {
    keyId: KEY_ID, ciphertexts: [payloads[0]],
  }), 'NO_SESSION_GRANT');

  console.log('\nduration-scoped grant');
  const durational = await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'duration', durationMs: 1500 });
  const durationGrant = durational.grants[0];
  check('duration honored', durationGrant.expiresAt - durationGrant.grantedAt === 1500, durationGrant);
  await new Promise((resolve) => {
    setTimeout(resolve, 2000);
  });
  await expectError('expired duration grant is refused', () => client.send('decrypt-v2', {
    keyId: KEY_ID, ciphertexts: [payloads[0]],
  }), 'SESSION_GRANT_EXPIRED');

  console.log('\nprompt-secret shape');
  // The recipient key is checked before any dialog is drawn, so this has to come
  // back immediately. The short timeout is the assertion: if a dialog ever gets
  // in front of this call again, the check fails in a second instead of quietly
  // passing on the timeout half a minute later.
  await expectError('rejects a malformed identity public key without prompting', () => client.send('prompt-secret', {
    identityPublicKey: 'not base64 at all!!',
    message: 'e2e should never see this dialog',
  }, { timeoutMs: 3_000 }), 'MALFORMED_PUBLIC_KEY');
  await expectError('rejects a well-formed base64 that is not a key', () => client.send('prompt-secret', {
    identityPublicKey: Buffer.from('still not a p-256 point').toString('base64'),
    message: 'e2e should never see this dialog',
  }, { timeoutMs: 3_000 }), 'MALFORMED_PUBLIC_KEY');

  console.log('\nunknown identity');
  await expectError('reports a missing identity clearly', () => client.send('unlock-session', {
    keyIds: [KEY_ID], identityId: 'no-such-identity', scope: 'session',
  }), 'IDENTITY_NOT_FOUND');

  console.log('\nlock policy resolution');
  const overridden = await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'session', lockOn: 'none' });
  check('per-session override is honored', overridden.lockOn === 'none', overridden);
  check('override is named as the source', overridden.lockOnSource === 'session-override', overridden);
  check('override shows up in list-sessions', (await client.send('list-sessions')).sessions[0].lockOn === 'none');

  // The daemon reads the config file fresh at each unlock, so no restart here.
  const configPath = path.join(configHome, 'varlock', 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({ anonymousId: 'e2e', sessions: { lockOn: 'screenLock' } }, null, 2)}\n`);
  const fromConfig = await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'session' });
  check('machine config beats the default', fromConfig.lockOn === 'screenLock', fromConfig);
  check('config is named as the source', fromConfig.lockOnSource === 'machine-config', fromConfig);

  const overrideWins = await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'session', lockOn: 'sleep' });
  check('override still beats the machine config', overrideWins.lockOn === 'sleep', overrideWins);

  fs.writeFileSync(configPath, `${JSON.stringify({ sessions: { lockOn: 'whenever-i-feel-like-it' } }, null, 2)}\n`);
  const badConfig = await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'session' });
  check('invalid config value falls back to the default', badConfig.lockOn === 'sleep', badConfig);
  check('and does not fail the unlock', badConfig.grants?.length === 1, badConfig);

  const badOverride = await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'session', lockOn: 'sometimes' });
  check('invalid override falls back too', badOverride.lockOn === 'sleep', badOverride);

  fs.writeFileSync(configPath, '{ not json at all');
  const brokenConfig = await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'session' });
  check('unparseable config does not break unlock', brokenConfig.lockOn === 'sleep', brokenConfig);
  fs.rmSync(configPath, { force: true });

  console.log('\ninvalidate everything');
  await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'session' });
  const all = await client.send('invalidate-session');
  check('drops remaining grants', all.invalidated === 1, all);

  // -- approval paths, on a daemon that has no screen to ask on --

  console.log('\nheadless daemon (nothing can be approved)');
  const headlessSocket = path.join(configHome, 'headless.sock');
  headlessDaemon = await startDaemon({
    socket: headlessSocket,
    label: 'headless',
    extraEnv: { _VARLOCK_UI_MODE: 'headless', _VARLOCK_FORCE_UNLOCK_PROMPT: '1' },
  });
  headlessClient = new Client(headlessSocket);
  await headlessClient.connect();

  await expectError('unlock refuses when nobody can be asked', () => headlessClient!.send('unlock-session', {
    keyIds: [KEY_ID], scope: 'session',
  }), 'NO_UI');
  await expectError('nothing was unlocked on the way out', () => headlessClient!.send('decrypt-v2', {
    keyId: KEY_ID, ciphertexts: [payloads[0]],
  }), 'NO_SESSION_GRANT');
  check('no grant was recorded', (await headlessClient.send('list-sessions')).sessions.length === 0);

  console.log('\nrequest-approval');
  await expectError('refuses when nobody can be asked', () => headlessClient!.send('request-approval', {
    title: 'Use the deploy token?',
    descriptionLines: ['POST https://api.example.com/deploy'],
    allowedScopes: ['once', 'session'],
  }), 'NO_UI');
  await expectError('needs a title', () => headlessClient!.send('request-approval', {
    descriptionLines: ['no title here'],
  }), 'APPROVAL_MISSING_TITLE');
  await expectError('needs at least one usable scope', () => headlessClient!.send('request-approval', {
    title: 'Use the deploy token?', allowedScopes: ['forever'],
  }), 'APPROVAL_NO_SCOPES');
  check('approval never touches the grant table', (await headlessClient.send('list-sessions')).sessions.length === 0);

  // -- sessions die with the daemon --

  console.log('\ndaemon restart');
  // The whole design rests on session material being memory-only: a
  // session-wrapped blob that survived a restart, plus a session key with no
  // presence requirement, would reopen silently after a reboot. So the death is
  // asserted rather than assumed.
  await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'session' });
  check('a grant is live before the restart', (await client.send('list-sessions')).sessions.length === 1);
  const auditBeforeRestart = readAudit().length;

  client.close();
  await stopDaemon(daemon, 'daemon');

  daemon = await startDaemon({ socket: socketPath, label: 'daemon-2' });
  client = new Client();
  await client.connect();

  const afterRestart = await client.send('ping');
  check('the same session identity comes back', afterRestart.sessionId === sessionId, afterRestart);
  check('no grant survived the restart', (await client.send('list-sessions')).sessions.length === 0);
  await expectError('decrypt is refused after a restart', () => client.send('decrypt-v2', {
    keyId: KEY_ID, ciphertexts: [payloads[0]],
  }), 'NO_SESSION_GRANT');

  // The sessions are gone; the record of them is not.
  check('the authorization log survives the restart', readAudit().length >= auditBeforeRestart, readAudit().length);

  await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'session' });
  const reopened = await client.send('decrypt-v2', { keyId: KEY_ID, ciphertexts: [payloads[0]] });
  check('unlocking again works after a restart', reopened.plaintexts?.[0] === SECRETS[0], reopened);
} finally {
  client.close();
  headlessClient?.close();
  // The audit file may have been left read-only by the denial checks, and the
  // scratch directory has to be removable either way.
  if (fs.existsSync(auditPath)) fs.chmodSync(auditPath, 0o600);
  // Waited on rather than given a fixed moment to die. A daemon this script
  // leaves running is holding enclave sessions on somebody's machine, with a
  // config home that is about to be deleted out from under it.
  await stopDaemon(daemon, 'daemon');
  if (headlessDaemon) await stopDaemon(headlessDaemon, 'headless daemon');
  try {
    runBinary(['delete-key', '--key-id', KEY_ID]);
  } catch { /* best effort */ }
  fs.rmSync(configHome, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall identity session checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
