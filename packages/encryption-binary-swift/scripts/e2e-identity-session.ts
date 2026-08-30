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

  async connect() {
    await new Promise<void>((resolve, reject) => {
      this.socket = net.createConnection(socketPath);
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

  send(action: string, payload?: Record<string, unknown>): Promise<any> {
    const id = Math.random().toString(36).slice(2);
    const body = Buffer.from(JSON.stringify({ id, action, payload }), 'utf-8');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length, 0);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timed out waiting for ${action}`));
      }, 30_000);
      this.socket.write(Buffer.concat([prefix, body]));
    });
  }

  close() {
    this.socket.end();
  }
}

async function expectError(label: string, fn: () => Promise<unknown>, expectedCode?: string) {
  try {
    const result = await fn();
    check(label, false, { unexpectedSuccess: result });
  } catch (err: any) {
    check(label, expectedCode === undefined || err.code === expectedCode, { code: err.code, message: err.message });
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

const daemon = spawn(binary, ['daemon', '--socket-path', socketPath, '--pid-path', path.join(configHome, 'daemon.pid')], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise<void>((resolve, reject) => {
  let out = '';
  daemon.stdout.on('data', (d) => {
    out += d.toString();
    if (out.includes('"ready"')) resolve();
  });
  daemon.stderr.on('data', (d) => process.stderr.write(`[daemon] ${d}`));
  daemon.on('exit', (code) => reject(new Error(`daemon exited early with code ${code}: ${out}`)));
  setTimeout(() => reject(new Error('daemon did not become ready')), 10_000);
});

const client = new Client();
await client.connect();

try {
  console.log('\nping');
  const ping = await client.send('ping');
  check('reports protocol version 2', ping.protocolVersion === 2, ping);
  const sessionId = ping.sessionId;
  check('peer has a session identity', typeof sessionId === 'string' && sessionId.length > 0, ping);

  console.log('\ndecrypt-v2 without a grant');
  await expectError('refused before unlock', () => client.send('decrypt-v2', {
    keyId: KEY_ID, ciphertexts: [payloads[0]],
  }), 'NO_SESSION_GRANT');

  console.log('\nunlock-session');
  const unlocked = await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'session' });
  check('no prompt needed for a --no-auth key', unlocked.policy === 'no-presence-required', unlocked);
  check('one grant returned', unlocked.grants?.length === 1, unlocked);
  const sessionGrant = unlocked.grants?.[0] ?? {};
  check('grant is scoped to the requested key', sessionGrant.keyId === KEY_ID, unlocked);
  check('grant carries a 12h cap', sessionGrant.expiresAt - sessionGrant.grantedAt === 12 * 60 * 60 * 1000, unlocked);

  console.log('\ndecrypt-v2 batch');
  const decrypted = await client.send('decrypt-v2', { keyId: KEY_ID, ciphertexts: payloads });
  check('every payload decrypted', JSON.stringify(decrypted.plaintexts) === JSON.stringify(SECRETS), decrypted.plaintexts?.length);
  check('batch counts as one use', decrypted.grant?.useCount === 1, decrypted.grant);

  const second = await client.send('decrypt-v2', { keyId: KEY_ID, ciphertext: payloads[0] });
  check('single-ciphertext form works', second.plaintexts?.[0] === SECRETS[0], second);
  check('session grant survives repeated use', second.grant?.useCount === 2, second.grant);

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
  await expectError('rejects a malformed identity public key', () => client.send('prompt-secret', {
    identityPublicKey: 'not base64 at all!!',
    message: 'e2e should never see this dialog',
  }));

  console.log('\nunknown identity');
  await expectError('reports a missing identity clearly', () => client.send('unlock-session', {
    keyIds: [KEY_ID], identityId: 'no-such-identity', scope: 'session',
  }), 'IDENTITY_NOT_FOUND');

  console.log('\ninvalidate everything');
  await client.send('unlock-session', { keyIds: [KEY_ID], scope: 'session' });
  const all = await client.send('invalidate-session');
  check('drops remaining grants', all.invalidated === 1, all);
} finally {
  client.close();
  daemon.kill('SIGTERM');
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
  try {
    runBinary(['delete-key', '--key-id', KEY_ID]);
  } catch { /* best effort */ }
  fs.rmSync(configHome, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall identity session checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
