#!/usr/bin/env node
/**
 * A stand-in for the native encryption daemon, for tests.
 *
 * Speaks the same 4-byte LE length-prefixed JSON framing over a unix socket, and
 * is spawned the same way the real one is (`<binary> daemon --socket-path ...`),
 * so `DaemonClient` cannot tell the difference. That is the point: it lets the
 * session flow, the unlock retry, and the stale-daemon restart be tested without
 * a Secure Enclave, a TPM, or a human with a fingerprint.
 *
 * Behaviour comes from `fake-daemon.json` in the socket directory, re-read on
 * every message so a test can change its mind mid-flight (which is how the
 * "grant died between the unlock and the decrypt" case is staged). Every message
 * it receives is appended to `fake-daemon-calls.jsonl` for tests to assert on.
 *
 * It holds no key material and does no crypto: `decrypt-v2` answers from a
 * ciphertext-to-plaintext table in the config. Real ECIES is covered elsewhere.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const socketPath = getArg('--socket-path');
const pidPath = getArg('--pid-path');
if (!socketPath) {
  process.stderr.write('fake-daemon: --socket-path is required\n');
  process.exit(1);
}

const socketDir = path.dirname(socketPath);
const configPath = path.join(socketDir, 'fake-daemon.json');
const callLogPath = path.join(socketDir, 'fake-daemon-calls.jsonl');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function logCall(message) {
  try {
    fs.appendFileSync(callLogPath, `${JSON.stringify({
      action: message.action,
      payload: message.payload ?? {},
      pid: process.pid,
    })}\n`);
  } catch { /* the log is a convenience, never the thing under test */ }
}

/**
 * Which protocol this daemon speaks, fixed when it starts.
 *
 * Unlike the rest of the config this is deliberately not re-read: a real daemon's
 * protocol is whatever binary it was started from, and it cannot change under a
 * running process. Pinning it is what makes the restart observable, because the
 * only way to see a different version is for a new process to have started.
 */
const protocolVersionAtStartup = readConfig().protocolVersion ?? 3;

/** Key ids this "session" currently holds a grant for */
const grantedKeys = new Set();
/**
 * keyId -> the ciphertexts an item-scoped grant covers.
 *
 * Only populated when the config asks for `itemScoped`, which stands in for a
 * user picking the narrow breadth on the real panel. The real daemon binds to
 * SHA-256 digests it computes itself; the fake compares the ciphertexts
 * directly, because what is under test on this side is the client's reaction to
 * a refusal, not the hashing.
 */
const coveredItems = new Map();

function grantFor(keyId, config) {
  const now = Date.now();
  return {
    sessionId: config.sessionId ?? 'fake-session',
    keyId,
    identityId: 'default',
    scope: 'session',
    grantedAt: now,
    expiresAt: now + 3_600_000,
    sessionUnlockedAt: now,
    sessionExpiresAt: now + 12 * 3_600_000,
    sessionExpiresInMs: 12 * 3_600_000,
    lockOn: 'sleep',
    expiresInMs: 3_600_000,
    useCount: 1,
    breadth: coveredItems.has(keyId) ? 'listed' : 'key',
    vaultId: 'local',
    ...(coveredItems.has(keyId) ? { coveredItemCount: coveredItems.get(keyId).size } : {}),
  };
}

function handle(message) {
  const config = readConfig();
  const payload = message.payload ?? {};
  const protocolVersion = protocolVersionAtStartup;

  // An old daemon knows none of the session ops, which is exactly how a real
  // one behaves and what the stale-daemon restart has to notice.
  const isSessionOp = ['unlock-session', 'decrypt-v2', 'list-sessions'].includes(message.action);
  if (isSessionOp && protocolVersion < 2) {
    return { error: `Unknown action: ${message.action}` };
  }

  switch (message.action) {
    case 'ping':
      return {
        result: {
          pong: true,
          sessionWarm: grantedKeys.size > 0,
          sessionId: config.sessionId ?? 'fake-session',
          protocolVersion,
        },
      };

    case 'unlock-session': {
      if (config.unlockError) {
        return { error: config.unlockError.message ?? 'unlock failed', errorCode: config.unlockError.code };
      }
      const keyIds = payload.keyIds ?? (payload.keyId ? [payload.keyId] : []);
      for (const keyId of keyIds) {
        grantedKeys.add(keyId);
        const items = (payload.items ?? {})[keyId];
        if (config.itemScoped && items?.length) coveredItems.set(keyId, new Set(items));
        else coveredItems.delete(keyId);
      }
      return {
        result: {
          sessionId: config.sessionId ?? 'fake-session',
          policy: 'biometrics',
          lockOn: 'sleep',
          lockOnSource: 'built-in-default',
          prompted: true,
          grants: keyIds.map((keyId) => grantFor(keyId, config)),
        },
      };
    }

    case 'decrypt-v2': {
      const keyId = payload.keyId ?? 'varlock-default';
      const ciphertexts = payload.ciphertexts ?? (payload.ciphertext ? [payload.ciphertext] : []);

      // Staged race: the grant dies between the unlock and the decrypt. Consumed
      // once, so the client's single retry is enough to get past it.
      if (config.dropGrantsBeforeDecrypt) {
        grantedKeys.delete(keyId);
        writeConfig({ ...config, dropGrantsBeforeDecrypt: false });
      }
      if (!grantedKeys.has(keyId)) {
        return { error: `No grant for key ${keyId}`, errorCode: 'NO_SESSION_GRANT' };
      }

      // An item-scoped grant refuses the whole batch when any ciphertext in it
      // was not approved over, and stays live: the caller is expected to ask.
      const covered = coveredItems.get(keyId);
      if (covered && ciphertexts.some((ciphertext) => !covered.has(ciphertext))) {
        return {
          error: `Key ${keyId} was not approved over every value in this request`,
          errorCode: 'GRANT_ITEM_NOT_COVERED',
        };
      }

      const table = config.plaintexts ?? {};
      const plaintexts = [];
      for (const ciphertext of ciphertexts) {
        if (!(ciphertext in table)) {
          return { error: `fake-daemon has no plaintext for ${ciphertext.slice(0, 12)}` };
        }
        plaintexts.push(table[ciphertext]);
      }
      return { result: { plaintexts, grant: grantFor(keyId, config) } };
    }

    case 'list-sessions':
      return { result: { sessions: [...grantedKeys].map((keyId) => grantFor(keyId, config)) } };

    case 'invalidate-session': {
      const before = grantedKeys.size;
      if (payload.keyId) grantedKeys.delete(payload.keyId);
      else grantedKeys.clear();
      return { result: { invalidated: before - grantedKeys.size } };
    }

    // v1 device-key decrypt, which answers with a bare string rather than an
    // object, exactly as both real daemons do
    case 'decrypt':
      return { result: (config.plaintexts ?? {})[payload.ciphertext] ?? 'via-daemon' };

    case 'encrypt':
      return { result: `fake-encrypted:${payload.plaintext}` };

    default:
      return { error: `Unknown action: ${message.action}` };
  }
}

try {
  fs.unlinkSync(socketPath);
} catch { /* nothing to clean up */ }

const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);

      const message = JSON.parse(body.toString());
      logCall(message);
      const response = { id: message.id, ...handle(message) };
      const out = Buffer.from(JSON.stringify(response), 'utf-8');
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(out.length, 0);
      socket.write(Buffer.concat([prefix, out]));
    }
  });
  socket.on('error', () => { /* a client hanging up is not our problem */ });
});

server.listen(socketPath, () => {
  if (pidPath) fs.writeFileSync(pidPath, String(process.pid));
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);
});

function shutdown() {
  try {
    server.close();
  } catch { /* already closing */ }
  try {
    fs.unlinkSync(socketPath);
  } catch { /* already gone */ }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
