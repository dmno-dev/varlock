import * as net from 'node:net';
import * as fs from 'node:fs';
import { ExecError } from '@env-spec/utils/exec-helpers';
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SOCKET_ENV_VAR,
  BRIDGE_TOKEN_ENV_VAR,
  BRIDGE_TOKEN_FILE_ENV_VAR,
  type BridgeRequest,
  type BridgeResponse,
} from './protocol';
import { parseBridgeAddr, type BridgeAddr } from './addr';

export function getBridgeAddr(): string | undefined {
  return process.env[BRIDGE_SOCKET_ENV_VAR] || undefined;
}

/** @deprecated use getBridgeAddr — kept for backward compat */
export const getBridgeSocketPath = getBridgeAddr;

/**
 * Resolves the bridge auth token.
 * Preference order:
 *   1. VARLOCK_OP_BRIDGE_TOKEN env var (direct value)
 *   2. VARLOCK_OP_BRIDGE_TOKEN_FILE env var (path to file containing token)
 * Returns undefined when no token is configured (bridge auth is optional).
 */
export function getBridgeToken(): string | undefined {
  const direct = process.env[BRIDGE_TOKEN_ENV_VAR];
  if (direct) return direct.trim();
  const filePath = process.env[BRIDGE_TOKEN_FILE_ENV_VAR];
  if (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').trim() || undefined;
    } catch (err: any) {
      throw new Error(`failed to read bridge token file ${filePath}: ${err.message}`);
    }
  }
  return undefined;
}

function connect(addr: BridgeAddr): net.Socket {
  return addr.kind === 'unix'
    ? net.createConnection(addr.path)
    : net.createConnection(addr.port, addr.host);
}

function sendRequest(addrStr: string, req: BridgeRequest): Promise<BridgeResponse> {
  const addr = parseBridgeAddr(addrStr);
  return new Promise((resolve, reject) => {
    const socket = connect(addr);
    let buf = '';
    let settled = false;

    const finish = (err: Error | null, res?: BridgeResponse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(res!);
    };

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(req)}\n`);
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nlIdx = buf.indexOf('\n');
      if (nlIdx === -1) return;
      const line = buf.slice(0, nlIdx);
      try {
        finish(null, JSON.parse(line));
      } catch (e: any) {
        finish(new Error(`invalid response from op bridge: ${e.message}`));
      }
    });
    socket.on('end', () => {
      if (!settled && buf) {
        try {
          finish(null, JSON.parse(buf));
        } catch (e: any) {
          finish(new Error(`invalid response from op bridge: ${e.message}`));
        }
      } else if (!settled) {
        finish(new Error('op bridge closed connection without a response'));
      }
    });
    socket.on('error', (err) => finish(err));
  });
}

export async function invokeOpViaBridge(
  addrStr: string,
  argv: Array<string>,
  opts: { env?: Record<string, string | undefined>; input?: string; token?: string } = {},
): Promise<string> {
  const token = opts.token ?? getBridgeToken();
  const req: BridgeRequest = {
    v: BRIDGE_PROTOCOL_VERSION,
    ...(token && { token }),
    argv,
    env: opts.env ?? {},
    input: opts.input,
  };

  const res = await sendRequest(addrStr, req);

  if (res.error) {
    throw new Error(`op bridge error: ${res.error}`);
  }
  if (res.exitCode !== 0) {
    throw new ExecError(res.exitCode ?? -1, res.signal as NodeJS.Signals | null, res.stderr || 'command gave no output');
  }
  return res.stdout;
}
