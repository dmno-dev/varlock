/**
 * Puts the real unlock panel on screen, one state at a time, so it can be looked at.
 *
 * Everything is throwaway: a scratch XDG_CONFIG_HOME, keys created with
 * `--no-auth`, and `_VARLOCK_FORCE_UNLOCK_PROMPT=1` so the panel is drawn even
 * though an ungated key has nothing to check. That means no fingerprint is
 * needed to see the panel, and approving it will not scan: the point here is the
 * layout and the copy, not the enclave.
 *
 * The states it walks through:
 *
 *   single  one key, expanded value metadata (12 values across two files)
 *   two     two keys, one of them tagged as a team vault
 *   agent   the same request sent by a script running under an interpreter,
 *           inside something that looks like a Claude Code session, which is
 *           what the execution chain is there to show
 *   delta   asking for a second key while the session already holds one
 *
 * Run it after building the daemon:
 *
 *   swift build --package-path packages/encryption-binary-swift/swift
 *   bun run packages/encryption-binary-swift/scripts/demo-panel.ts
 *   bun run packages/encryption-binary-swift/scripts/demo-panel.ts --only agent
 *
 * Each panel waits for a real answer, so approve or deny to move to the next one.
 *
 * `--gated` makes the scratch keys presence-gated instead, which is the only way
 * to see the embedded Touch ID view: an ungated key has nothing to scan for. The
 * keys still live in the scratch config home and go with it.
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const binary = path.resolve(here, '../swift/.build/debug/VarlockEnclave');

/** Frame one message the way the daemon's socket expects it */
function frame(message: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

/**
 * A one-shot client: connect, send, print the answer, exit.
 *
 * The demo re-runs itself in this mode to produce the agent state, because the
 * chain the panel draws is read off the process that actually connected. A faked
 * chain would prove nothing; a script run by bun under an agent's environment is
 * the real thing.
 */
async function runAsClient(socketPath: string, requestPath: string) {
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
  const socket = net.createConnection(socketPath);
  await new Promise((resolve) => {
    socket.once('connect', resolve);
  });
  socket.write(frame({ id: 'demo-agent', action: 'unlock-session', payload: request }));

  let buffer = Buffer.alloc(0);
  await new Promise<void>((resolve) => {
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      console.log(`  answer: ${buffer.subarray(4, 4 + length).toString('utf-8').slice(0, 200)}`);
      resolve();
    });
  });
  socket.destroy();
}

const clientSocket = process.argv[process.argv.indexOf('--client-socket') + 1];
if (process.argv.includes('--client-socket')) {
  await runAsClient(clientSocket, process.argv[process.argv.indexOf('--client-request') + 1]);
  process.exit(0);
}

if (!fs.existsSync(binary)) {
  throw new Error(`daemon not built at ${binary}; run: swift build --package-path packages/encryption-binary-swift/swift`);
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
/** Real presence-gated keys, so the panel carries a real scan. */
const gated = process.argv.includes('--gated');

// -- a throwaway world: scratch config home, ungated keys, no real secrets --

const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-panel-demo-'));
// Bun hands a child the environment the parent STARTED with unless it is passed
// explicitly, so every spawn below gets this object by name.
const env = { ...process.env, XDG_CONFIG_HOME: configHome };
const socketPath = path.join(configHome, 'demo.sock');
console.log(`scratch config home: ${configHome}`);

function runBinary(args: Array<string>): any {
  return JSON.parse(execFileSync(binary, args, { env, encoding: 'utf-8' }));
}

// Skip the one-time "setting up biometrics" panel: it is real and wanted, but it
// is not the panel this demo is about.
fs.mkdirSync(path.join(configHome, 'varlock', 'secure-enclave'), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(configHome, 'varlock', 'secure-enclave', '.setup-shown'), '');

const { createKeyPair } = await import('../../varlock/src/lib/local-encrypt/crypto');

const keyFlags = gated ? [] : ['--no-auth'];
runBinary(['generate-key', '--key-id', 'varlock-default', ...keyFlags]);
runBinary(['generate-key', '--key-id', 'prod', ...keyFlags]);
if (gated) console.log('gated keys: the panel will carry a real Touch ID scan');

const identityKeyPair = await createKeyPair();
const wrapFor = (keyId: string) => runBinary([
  'encrypt',
  '--key-id',
  keyId,
  '--data',
  Buffer.from(identityKeyPair.privateKey, 'utf-8').toString('base64'),
]).ciphertext;

fs.mkdirSync(path.join(configHome, 'varlock', 'identities'), { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(configHome, 'varlock', 'identities', 'default.json'),
  `${JSON.stringify({
    version: 1,
    id: 'default',
    publicKey: identityKeyPair.publicKey,
    wraps: { 'varlock-default': wrapFor('varlock-default'), prod: wrapFor('prod') },
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`,
  { mode: 0o600 },
);

// -- the daemon, with the panel forced so an ungated key still draws one --

const daemon = spawn(
  binary,
  ['daemon', '--socket-path', socketPath, '--pid-path', `${socketPath}.pid`],
  {
    env: {
      ...env,
      // A gated key prompts on its own; forcing it is only for the ungated ones.
      ...(gated ? {} : { _VARLOCK_FORCE_UNLOCK_PROMPT: '1' }),
      // The setup step is its own question, and this demo is about the panel.
      _VARLOCK_BIOMETRIC_SETUP: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
daemon.stderr.on('data', (chunk) => process.stderr.write(`[daemon] ${chunk}`));
await new Promise<void>((resolve, reject) => {
  let out = '';
  daemon.stdout.on('data', (chunk) => {
    out += chunk.toString();
    if (out.includes('"ready"')) resolve();
  });
  daemon.on('exit', (code) => reject(new Error(`daemon exited early with code ${code}: ${out}`)));
  setTimeout(() => reject(new Error('daemon did not become ready')), 10_000);
});

// Ctrl-C in the middle of a panel still has to leave the machine as it was: a
// daemon holding a scratch key and a temp directory full of key handles are not
// things to leave behind.
function cleanUp() {
  daemon.kill('SIGKILL');
  fs.rmSync(configHome, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    cleanUp();
    process.exit(1);
  });
}

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
    this.socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE(0);
        if (this.buffer.length < 4 + length) break;
        const message = JSON.parse(this.buffer.subarray(4, 4 + length).toString('utf-8'));
        this.buffer = this.buffer.subarray(4 + length);
        const waiting = this.pending.get(message.id);
        if (!waiting) continue;
        this.pending.delete(message.id);
        if (message.error) waiting.reject(Object.assign(new Error(message.error), { code: message.errorCode }));
        else waiting.resolve(message.result);
      }
    });
  }

  /** Args go under `payload`; the daemon refuses a message without one. */
  send(action: string, payload: Record<string, unknown> = {}): Promise<any> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(frame({ id, action, payload }));
    });
  }

  close() { this.socket?.destroy(); }
}

const projectPath = `${os.homedir()}/dev/acme-api`;

const defaultKeyDisplay = {
  valueCount: 12,
  files: [
    {
      path: '.env',
      valueNames: [
        'DATABASE_URL',
        'STRIPE_TEST_KEY',
        'SENTRY_DSN',
        'REDIS_URL',
        'SMTP_PASS',
        'JWT_SECRET',
        'S3_KEY',
        'S3_SECRET',
      ],
    },
    {
      path: '.env.local',
      valueNames: ['OPENAI_API_KEY', 'GH_TOKEN', 'LOCAL_DB_URL', 'NGROK_TOKEN'],
    },
  ],
};

const prodKeyDisplay = {
  valueCount: 3,
  vaultLabel: 'acme-team vault',
  vaultColor: '#b48ce8',
  files: [{ path: '.env.production', valueNames: ['PROD_DB_URL', 'PROD_STRIPE_KEY', 'PROD_JWT'] }],
};

const client = new Client();
await client.connect();

async function show(label: string, description: string, payload: Record<string, unknown>) {
  if (only && only !== label) return;
  console.log(`\n>>> ${label}: ${description}`);
  try {
    const result = await client.send('unlock-session', payload);
    console.log(`  approved: ${JSON.stringify(result.grants?.map((g: any) => ({ keyId: g.keyId, scope: g.scope })))}`);
  } catch (err: any) {
    console.log(`  denied or timed out: ${err.code ?? err.message}`);
  }
}

try {
  await show('single', 'one key, open a row to see the value names', {
    keyIds: ['varlock-default'],
    scope: 'session',
    display: {
      projectName: 'acme-api',
      projectPath,
      keys: { 'varlock-default': defaultKeyDisplay },
    },
  });

  await show('two', 'two keys, one of them in a team vault', {
    keyIds: ['varlock-default', 'prod'],
    scope: 'session',
    lockOn: 'screenLock',
    display: {
      projectName: 'acme-api',
      projectPath,
      keys: { 'varlock-default': defaultKeyDisplay, prod: prodKeyDisplay },
    },
  });

  if (!only || only === 'agent') {
    // The chain is read off whoever connects, so this is a real script under a
    // real interpreter, in an environment that looks like an agent session.
    console.log('\n>>> agent: the request comes from a script run by bun, inside an agent session');
    const requestPath = path.join(configHome, 'agent-request.json');
    fs.writeFileSync(requestPath, JSON.stringify({
      keyIds: ['prod'],
      scope: 'session',
      display: { projectName: 'acme-api', projectPath, keys: { prod: prodKeyDisplay } },
    }));
    const agent = spawn(
      'bun',
      ['run', fileURLToPath(import.meta.url), '--client-socket', socketPath, '--client-request', requestPath],
      {
        env: {
          ...env,
          CLAUDECODE: '1',
          CLAUDE_CODE_ENTRYPOINT: 'cli',
        },
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    await new Promise((resolve) => {
      agent.once('exit', resolve);
    });
  }

  await show('delta', 'a second key while the session already holds one', {
    keyIds: ['varlock-default', 'prod'],
    scope: 'session',
    display: {
      projectName: 'acme-api',
      projectPath,
      keys: { 'varlock-default': defaultKeyDisplay, prod: prodKeyDisplay },
    },
  });
} finally {
  client.close();
  daemon.kill('SIGTERM');
  await new Promise((resolve) => {
    daemon.once('exit', resolve);
    setTimeout(resolve, 3_000);
  });
  // The key store is a directory under XDG_CONFIG_HOME, so removing the scratch
  // home is the whole cleanup: the real keys live in the real config home and
  // were never in scope here.
  fs.rmSync(configHome, { recursive: true, force: true });
  console.log('\ncleaned up the scratch config home');
}
