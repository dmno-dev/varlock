/* eslint-disable no-console, @typescript-eslint/no-empty-function */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeRequest,
  type BridgeResponse,
} from './protocol';
import { type BridgeAddr, describeAddr } from './addr';

interface ServeOptions {
  addr: BridgeAddr;
  /** If set, every incoming request must match `request.token === token`. */
  token?: string;
  verbose?: boolean;
  allowedEnvPassthrough?: Array<string>;
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const DEFAULT_ALLOWED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'XDG_CONFIG_HOME',
  'OP_BIOMETRIC_UNLOCK_ENABLED',
];

// Env vars the CLIENT is not allowed to overlay — these must always come from
// the host. Otherwise e.g. a container passing HOME=/home/node would make the
// host's `op` try to write state to a path that doesn't exist on macOS.
const CLIENT_ENV_BLOCKLIST = new Set([
  'HOME',
  'USER',
  'PATH',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'TMPDIR',
  'LOGNAME',
  'SHELL',
  'PWD',
]);

const noopLog = (..._a: Array<unknown>) => {};

function sendResponse(socket: net.Socket, partial: Partial<BridgeResponse>) {
  const res: BridgeResponse = {
    v: BRIDGE_PROTOCOL_VERSION,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    ...partial,
  };
  try {
    socket.end(`${JSON.stringify(res)}\n`);
  } catch {
    socket.destroy();
  }
}

function runOp(req: BridgeRequest, allowedEnvKeys: Array<string>): Promise<BridgeResponse> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {};
    for (const key of allowedEnvKeys) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    for (const [k, v] of Object.entries(req.env ?? {})) {
      if (CLIENT_ENV_BLOCKLIST.has(k)) continue;
      if (v === undefined) delete env[k];
      else env[k] = v;
    }

    const child = spawn('op', req.argv, { env });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    if (req.input !== undefined && child.stdin) {
      child.stdin.write(req.input);
      child.stdin.end();
    }

    child.on('error', (err: any) => {
      resolve({
        v: BRIDGE_PROTOCOL_VERSION,
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        error: err?.code === 'ENOENT' ? 'ENOENT: `op` not found on host' : err?.message ?? String(err),
      });
    });

    child.on('exit', (exitCode, signal) => {
      resolve({
        v: BRIDGE_PROTOCOL_VERSION,
        stdout,
        stderr,
        exitCode,
        signal,
      });
    });
  });
}

export async function startBridgeServer(opts: ServeOptions): Promise<net.Server> {
  const log = opts.verbose ? (...a: Array<unknown>) => console.error('[op-bridge]', ...a) : noopLog;

  if (opts.addr.kind === 'unix') {
    // Clean up stale socket file and make sure parent dir exists
    try {
      const st = fs.statSync(opts.addr.path);
      if (st.isSocket()) fs.unlinkSync(opts.addr.path);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
    fs.mkdirSync(path.dirname(opts.addr.path), { recursive: true });
  }

  const server = net.createServer((socket) => {
    log('connection');
    let buf = '';
    let handled = false;

    socket.on('data', (chunk) => {
      if (handled) return;
      buf += chunk.toString('utf8');
      const nlIdx = buf.indexOf('\n');
      if (nlIdx === -1) return;
      handled = true;
      const line = buf.slice(0, nlIdx);

      let req: BridgeRequest;
      try {
        req = JSON.parse(line);
      } catch (err: any) {
        sendResponse(socket, { error: `invalid request json: ${err.message}` });
        return;
      }

      if (req.v !== BRIDGE_PROTOCOL_VERSION) {
        sendResponse(socket, { error: `protocol version mismatch: server=${BRIDGE_PROTOCOL_VERSION} client=${req.v}` });
        return;
      }

      if (opts.token) {
        if (!req.token || !safeEq(req.token, opts.token)) {
          log('rejecting request: bad/missing token');
          sendResponse(socket, { error: 'unauthorized: invalid or missing bridge token' });
          return;
        }
      }

      runOp(req, opts.allowedEnvPassthrough ?? DEFAULT_ALLOWED_ENV)
        .then((res) => sendResponse(socket, res))
        .catch((err) => sendResponse(socket, { error: err?.message ?? String(err) }));
    });

    socket.on('error', (err) => log('socket error', err.message));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const onListening = () => {
      server.off('error', reject);
      resolve();
    };
    if (opts.addr.kind === 'unix') {
      server.listen(opts.addr.path, onListening);
    } else {
      server.listen(opts.addr.port, opts.addr.host, onListening);
    }
  });

  if (opts.addr.kind === 'unix') {
    // Restrict Unix socket to owner only
    try {
      fs.chmodSync(opts.addr.path, 0o600);
    } catch (err) {
      log('chmod failed', err);
    }
  }

  log(`listening on ${describeAddr(opts.addr)}`);
  return server;
}
