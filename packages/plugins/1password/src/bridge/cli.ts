/* eslint-disable no-console */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { startBridgeServer } from './server';
import { parseBridgeAddr, describeAddr, type BridgeAddr } from './addr';

const DEFAULT_TCP_PORT = 7195;

const HELP = `varlock-op-bridge — bridge container calls to \`op\` through the host CLI

Usage:
  varlock-op-bridge serve  [--addr <path|host:port>] [--verbose]
  varlock-op-bridge ensure [--addr <path|host:port>] [--log <path>]

The --addr argument accepts either:
  • a Unix socket path  (e.g. /tmp/varlock-op-bridge.sock)
  • a TCP address       (e.g. 127.0.0.1:7195, :7195, 7195)

Commands:
  serve   Run the bridge in the foreground (blocks).
  ensure  Start the bridge in the background if not already running.
          Idempotent; intended for devcontainer initializeCommand.

Defaults to TCP on 127.0.0.1:${DEFAULT_TCP_PORT}. TCP is recommended for
devcontainers — Docker Desktop on macOS has known issues bind-mounting
Unix sockets.

Inside the devcontainer, set VARLOCK_OP_BRIDGE_SOCKET=<addr> so the
1Password plugin proxies through. For TCP, use host.docker.internal:<port>.

Example (devcontainer.json):
  "initializeCommand": "npx -y -p @varlock/1password-plugin varlock-op-bridge ensure",
  "containerEnv": {
    "VARLOCK_OP_BRIDGE_SOCKET": "host.docker.internal:${DEFAULT_TCP_PORT}"
  }
`;

function defaultAddrString() {
  return `127.0.0.1:${DEFAULT_TCP_PORT}`;
}

function defaultLogPath() {
  return path.join(os.homedir(), '.varlock-op-bridge.log');
}

function defaultTokenPath() {
  return path.join(os.homedir(), '.varlock-op-bridge.token');
}

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function writeTokenFile(tokenPath: string, token: string) {
  // Write as 0600 atomically: create new file with restrictive mode, then rename.
  const tmp = `${tokenPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.renameSync(tmp, tokenPath);
}

function readTokenFile(tokenPath: string): string | undefined {
  try {
    const v = fs.readFileSync(tokenPath, 'utf8').trim();
    return v || undefined;
  } catch (err: any) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

function parseArgs(argv: Array<string>, flags: Record<string, 'value' | 'bool'>) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const spec = flags[a];
    if (!spec) {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
    if (spec === 'bool') out[a] = true;
    else out[a] = argv[++i];
  }
  return out;
}

async function pingBridge(addr: BridgeAddr, timeoutMs = 500): Promise<boolean> {
  if (addr.kind === 'unix' && !fs.existsSync(addr.path)) return false;
  return new Promise((resolve) => {
    const s = addr.kind === 'unix'
      ? net.createConnection(addr.path)
      : net.createConnection(addr.port, addr.host);
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), timeoutMs).unref();
  });
}

async function waitForBridge(addr: BridgeAddr, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingBridge(addr, 300)) return true;
    await new Promise<void>((r) => {
      setTimeout(r, 200);
    });
  }
  return false;
}

async function cmdServe(argv: Array<string>) {
  const args = parseArgs(argv, {
    '--addr': 'value',
    '-a': 'value',
    // kept for backward compat — treated as Unix path
    '--socket': 'value',
    '-s': 'value',
    '--token-file': 'value',
    '--no-token': 'bool',
    '--verbose': 'bool',
    '-v': 'bool',
  });
  const addrStr = (args['--addr'] ?? args['-a'] ?? args['--socket'] ?? args['-s'] ?? defaultAddrString()) as string;
  const addr = parseBridgeAddr(addrStr);
  const verbose = Boolean(args['--verbose'] ?? args['-v']);

  // Resolve token: --token-file wins, else default path, unless --no-token.
  let token: string | undefined;
  if (!args['--no-token']) {
    const tokenPath = (args['--token-file'] ?? defaultTokenPath()) as string;
    token = readTokenFile(tokenPath);
    if (!token) {
      console.error(`[serve] no token file at ${tokenPath} — run \`varlock-op-bridge ensure\` first, or pass --no-token to disable auth.`);
      process.exit(1);
    }
  }

  const server = await startBridgeServer({ addr, token, verbose });
  console.log(`varlock-op-bridge listening on ${describeAddr(addr)} (auth: ${token ? 'token' : 'none'})`);

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdEnsure(argv: Array<string>) {
  const args = parseArgs(argv, {
    '--addr': 'value',
    '-a': 'value',
    '--socket': 'value',
    '-s': 'value',
    '--log': 'value',
    '--token-file': 'value',
    '--no-token': 'bool',
    '--print-token': 'bool',
  });
  const addrStr = (args['--addr'] ?? args['-a'] ?? args['--socket'] ?? args['-s'] ?? defaultAddrString()) as string;
  const addr = parseBridgeAddr(addrStr);
  const logPath = (args['--log'] ?? defaultLogPath()) as string;
  const tokenPath = (args['--token-file'] ?? defaultTokenPath()) as string;
  const useToken = !args['--no-token'];

  if (useToken) {
    // Rotate: new random token per ensure. Existing bridge will be killed below
    // if reachable so the fresh token lands in both the file and the server.
    const newToken = generateToken();
    writeTokenFile(tokenPath, newToken);
    if (args['--print-token']) console.log(newToken);
  }

  // If a bridge is already up, restart it so it picks up the rotated token.
  if (await pingBridge(addr)) {
    console.log(`[ensure] existing bridge found on ${describeAddr(addr)} — restarting to rotate token`);
    // Best-effort kill: any `node ... bridge-cli.cjs serve --addr <addrStr>`
    try {
      const { execSync } = await import('node:child_process');
      execSync(`pkill -f ${JSON.stringify(`bridge-cli.cjs serve --addr ${addrStr}`)}`, { stdio: 'ignore' });
    } catch { /* pkill returns 1 if nothing matched; ignore */ }
    // Wait for the port/socket to free up
    for (let i = 0; i < 20; i++) {
      if (!(await pingBridge(addr, 200))) break;
      await new Promise<void>((r) => { setTimeout(r, 100); });
    }
  }

  if (addr.kind === 'unix') {
    // Stale socket file with no listener — remove so serve's listen() can bind.
    try {
      const st = fs.statSync(addr.path);
      if (st.isSocket()) fs.unlinkSync(addr.path);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  const scriptPath = process.argv[1];
  const logFd = fs.openSync(logPath, 'a');
  const serveArgs = [scriptPath, 'serve', '--addr', addrStr, '--verbose'];
  if (useToken) serveArgs.push('--token-file', tokenPath);
  else serveArgs.push('--no-token');

  // Try to make the spawned bridge process introspect as "varlock-op-bridge"
  // rather than "node" — e.g. in 1Password's "X wants to access 1Password"
  // prompt, `ps`, and macOS privacy dialogs. Two cheap tricks combined:
  //   1. Spawn via a symlink to process.execPath, named varlock-op-bridge —
  //      macOS exec-path APIs typically return the symlink path.
  //   2. Set argv[0] to varlock-op-bridge for any API that reads it.
  // Neither changes the binary's code signature (still node's); 1Password may
  // still show "node" if it uses signature-based identity. Best-effort.
  let execPath = process.execPath;
  try {
    const aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-op-bridge-'));
    const alias = path.join(aliasDir, 'varlock-op-bridge');
    fs.symlinkSync(process.execPath, alias);
    execPath = alias;
  } catch { /* fall through to plain node */ }

  const child = spawn(execPath, serveArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
    argv0: 'varlock-op-bridge',
  });
  child.unref();
  fs.closeSync(logFd);

  console.log(`[ensure] starting bridge (pid ${child.pid}, log ${logPath}${useToken ? `, token file ${tokenPath}` : ', no auth'})`);

  const ready = await waitForBridge(addr, 5000);
  if (!ready) {
    console.error(`[ensure] bridge did not come up within 5s — check ${logPath}`);
    process.exit(1);
  }
  console.log(`[ensure] bridge ready on ${describeAddr(addr)}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === 'serve') return cmdServe(argv.slice(1));
  if (cmd === 'ensure') return cmdEnsure(argv.slice(1));

  console.error(`unknown command: ${cmd}`);
  console.error(HELP);
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
