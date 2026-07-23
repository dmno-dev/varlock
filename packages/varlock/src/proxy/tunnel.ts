import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

/**
 * CONNECT-over-WebSocket tunnel for reaching the proxy from a remote sandbox.
 *
 * Providers (E2B, Modal, ...) expose a sandbox port through an HTTP reverse
 * proxy that carries WebSocket upgrades but not raw `CONNECT`, so a remote agent
 * can't point `HTTP(S)_PROXY` straight at the broker. This bridges the gap
 * without an external tool (previously chisel): the broker attaches a WS server
 * to the existing proxy listener, and `varlock proxy run --url` runs a loopback
 * proxy in the guest whose connections ride the WS to the broker's proxy.
 *
 * One WS per connection (no multiplexing): the WS *is* the stream. Each carries
 * one JSON control line first, then raw binary bytes:
 *  - `{"t":"bootstrap"}` → broker replies with the guest's env + CA certs, closes.
 *  - `{"t":"connect"}`   → broker dials its own loopback proxy; the WS becomes a
 *                          byte pipe. On the broker the connection is loopback, so
 *                          it's exempt from the data-plane token check — the WS
 *                          handshake already authenticated it.
 *
 * Auth is one token presented on the handshake (the session's data-plane token);
 * `ws` supports request headers, so it rides `x-varlock-tunnel-token`.
 */

export const TUNNEL_TOKEN_HEADER = 'x-varlock-tunnel-token';
/** Upgrade path the tunnel answers on, so it never hijacks an unrelated upgrade. */
export const TUNNEL_PATH = '/__varlock/tunnel';

/** What a guest needs to run through the broker: the child-view session payload
 * (as the same encoded JSON the control endpoint serves — env + omittedKeys +
 * serializedGraph, so the guest gets identical redaction/omit handling) plus the
 * CA cert files. The guest decodes the payload and adds its own loopback wiring. */
export type TunnelBootstrap = {
  /** Encoded `SessionEnvPayload` (JSON); decode with `decodeSessionEnvPayload`. */
  payloadJson: string;
  /** CA bundle files by basename (`ca-cert.pem`, `combined-ca.pem`) → PEM contents. */
  certs: Record<string, string>;
};

function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tunnelUrl(base: string): string {
  // Preserve scheme/host, force the tunnel path.
  const u = new URL(base);
  u.pathname = TUNNEL_PATH;
  return u.toString();
}

// ---------------------------------------------------------------------------
// Broker (server) side
// ---------------------------------------------------------------------------

function handleTunnelConnection(ws: WebSocket, opts: {
  proxyPort: number;
  buildBootstrap: () => TunnelBootstrap;
}) {
  ws.once('message', (first: RawData) => {
    let control: { t?: string };
    try {
      control = JSON.parse(first.toString());
    } catch {
      ws.close();
      return;
    }

    if (control.t === 'bootstrap') {
      try {
        ws.send(JSON.stringify(opts.buildBootstrap()));
      } finally {
        ws.close();
      }
      return;
    }

    if (control.t === 'connect') {
      const upstream = net.connect(opts.proxyPort, '127.0.0.1');
      ws.on('message', (data: RawData) => upstream.write(data as Buffer));
      upstream.on('data', (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
      });
      const teardown = () => {
        try {
          ws.close();
        } catch { /* already closing */ }
        upstream.destroy();
      };
      ws.on('close', teardown);
      ws.on('error', teardown);
      upstream.on('close', teardown);
      upstream.on('error', teardown);
      return;
    }

    ws.close();
  });
}

/**
 * Attach the tunnel WS server to an existing http.Server (the proxy listener).
 * Returns a handle whose `close()` detaches it. Handshakes are gated on `token`;
 * an authenticated `connect` stream is bridged to `127.0.0.1:proxyPort`.
 */
export function attachTunnelServer(httpServer: http.Server, opts: {
  token: string;
  proxyPort: number;
  buildBootstrap: () => TunnelBootstrap;
  onAuthFailure?: () => void;
}): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    // Only our path; leave any other upgrade for another handler / rejection.
    if (!(req.url ?? '').startsWith(TUNNEL_PATH)) return;
    if (!tokenMatches(req.headers[TUNNEL_TOKEN_HEADER], opts.token)) {
      opts.onAuthFailure?.();
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleTunnelConnection(ws, opts));
  };

  httpServer.on('upgrade', onUpgrade);
  return {
    close: () => {
      httpServer.off('upgrade', onUpgrade);
      wss.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Guest (client) side
// ---------------------------------------------------------------------------

/** Open a short-lived WS, ask for the bootstrap (env + certs), and return it. */
export function fetchTunnelBootstrap(url: string, token: string, timeoutMs = 15000): Promise<TunnelBootstrap> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tunnelUrl(url), { headers: { [TUNNEL_TOKEN_HEADER]: token } });
    const timer = setTimeout(() => {
      reject(new Error('tunnel bootstrap timed out'));
      ws.terminate();
    }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'bootstrap' })));
    ws.on('message', (data: RawData) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()) as TunnelBootstrap);
      } catch (err) {
        reject(err);
      }
      ws.close();
    });
    // `unexpected-response` gives a precise message for a rejected handshake (e.g.
    // a 401 on a bad token), but Bun's `ws` doesn't implement it and warns if we
    // subscribe — so only attach it under Node. On Bun a bad handshake falls back
    // to the timeout below, which still rejects.
    if (typeof (globalThis as any).Bun === 'undefined') {
      ws.on('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`tunnel handshake rejected (status ${res.statusCode}). Check the URL and --token.`));
      });
    }
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run a loopback proxy listener in the guest: each incoming connection opens a
 * `connect` WS to the broker and bridges bytes. Returns the bound port + a close.
 */
export function startTunnelClientListener(opts: {
  url: string;
  token: string;
  listenHost?: string;
  listenPort?: number;
}): Promise<{ port: number; close: () => void }> {
  const target = tunnelUrl(opts.url);
  const listener = net.createServer((sock) => {
    const ws = new WebSocket(target, { headers: { [TUNNEL_TOKEN_HEADER]: opts.token } });
    const pending: Array<Buffer> = [];
    let open = false;
    ws.on('open', () => {
      open = true;
      ws.send(JSON.stringify({ t: 'connect' }));
      for (const b of pending) ws.send(b, { binary: true });
      pending.length = 0;
    });
    sock.on('data', (data: Buffer) => {
      if (open && ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
      else pending.push(data);
    });
    ws.on('message', (data: RawData) => sock.write(data as Buffer));
    const teardown = () => {
      try {
        ws.close();
      } catch { /* already closing */ }
      sock.destroy();
    };
    ws.on('close', teardown);
    ws.on('error', teardown);
    sock.on('close', teardown);
    sock.on('error', teardown);
  });

  return new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(opts.listenPort ?? 0, opts.listenHost ?? '127.0.0.1', () => {
      listener.off('error', reject);
      const addr = listener.address();
      if (!addr || typeof addr === 'string') {
        listener.close();
        reject(new Error('tunnel listener failed to bind'));
        return;
      }
      resolve({ port: addr.port, close: () => listener.close() });
    });
  });
}
