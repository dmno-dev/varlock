/* eslint-disable no-bitwise -- RFC 6455 frame codec is inherently bit-level */
import http from 'node:http';
import net from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';

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
 * No WebSocket library is shipped, deliberately: bundling CJS `ws` into the ESM
 * npm dist broke Node at import time, and crossws's node adapter refuses to run
 * under Bun (the compiled binary). The client is the runtime's native `WebSocket`
 * (global in Node 22+ and Bun). The server side is a minimal RFC 6455 codec below
 * (no extensions are negotiated, so there is no permessage-deflate to handle),
 * except under Bun: Bun's node:http silently drops manual writes on upgrade
 * sockets, and its runtime ships a native built-in implementation of the `ws`
 * module (no package required), so the Bun path delegates the handshake and
 * framing to that.
 *
 * Auth is one token presented on the handshake (the session's data-plane token).
 * The native client can't set request headers, so it rides a
 * `Sec-WebSocket-Protocol` entry (`vlt_<base64url(token)>`; base64url keeps any
 * token within the header's token grammar). The server also accepts the
 * `x-varlock-tunnel-token` header for non-browser-API clients.
 */

export const TUNNEL_TOKEN_HEADER = 'x-varlock-tunnel-token';
/** Upgrade path the tunnel answers on, so it never hijacks an unrelated upgrade. */
export const TUNNEL_PATH = '/__varlock/tunnel';
/** Subprotocol the tunnel speaks; echoed by the server when offered. */
export const TUNNEL_PROTOCOL = 'varlock-tunnel.v1';
const TOKEN_PROTOCOL_PREFIX = 'vlt_';
/** Fixed GUID from RFC 6455 §4.2.2 used to derive `Sec-WebSocket-Accept`. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Cap on one reassembled message; pipe traffic is TCP-chunk sized and the
 * bootstrap payload is far below this. */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

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

/** The token-bearing subprotocol entry offered by the client. */
export function tunnelTokenProtocolEntry(token: string): string {
  return TOKEN_PROTOCOL_PREFIX + Buffer.from(token, 'utf8').toString('base64url');
}

function parseOfferedProtocols(header: string | Array<string> | undefined): Array<string> {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  return raw.split(',').map((p) => p.trim()).filter(Boolean);
}

/** True if the upgrade request presents the expected token, via either the
 * dedicated header or a `vlt_` subprotocol entry. */
function upgradeAuthOk(req: http.IncomingMessage, expected: string): boolean {
  if (tokenMatches(req.headers[TUNNEL_TOKEN_HEADER], expected)) return true;
  for (const proto of parseOfferedProtocols(req.headers['sec-websocket-protocol'])) {
    if (!proto.startsWith(TOKEN_PROTOCOL_PREFIX)) continue;
    const decoded = Buffer.from(proto.slice(TOKEN_PROTOCOL_PREFIX.length), 'base64url').toString('utf8');
    if (tokenMatches(decoded, expected)) return true;
  }
  return false;
}

function tunnelUrl(base: string): string {
  // Preserve scheme/host, force the tunnel path.
  const u = new URL(base);
  u.pathname = TUNNEL_PATH;
  return u.toString();
}

// ---------------------------------------------------------------------------
// Broker (server) side — minimal RFC 6455 server socket
// ---------------------------------------------------------------------------

const enum WsOpcode {
  Continuation = 0x0,
  Text = 0x1,
  Binary = 0x2,
  Close = 0x8,
  Ping = 0x9,
  Pong = 0xa,
}

/** Encode a single server→client frame (servers never mask). */
function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

type WsFrame = { fin: boolean; opcode: number; payload: Buffer };

/** The socket surface `handleTunnelConnection` needs, implemented by both the
 * built-in codec (Node) and the Bun `ws`-shim wrapper. */
type TunnelSocketLike = {
  onmessage: (data: Buffer, isText: boolean) => void;
  onclose: () => void;
  sendText: (data: string) => void;
  sendBinary: (data: Buffer) => void;
  close: () => void;
};

/**
 * A WebSocket connection after the upgrade handshake: incremental frame parser
 * over the raw socket (handles fragmentation, masking, ping/pong, close) and
 * unmasked server-side send. Extensions are never negotiated, so RSV bits are
 * treated as a protocol error.
 */
const NOOP = () => { /* replaced by the connection handler */ };

class TunnelServerSocket implements TunnelSocketLike {
  onmessage: (data: Buffer, isText: boolean) => void = NOOP;
  onclose: () => void = NOOP;

  private buf: Buffer = Buffer.alloc(0);
  private fragments: Array<Buffer> | undefined;
  private fragmentsText = false;
  private fragmentsBytes = 0;
  private closeSent = false;
  private closed = false;

  constructor(private sock: net.Socket) {
    sock.setNoDelay(true);
    sock.on('data', (chunk: Buffer) => this.feed(chunk));
    sock.on('close', () => this.destroy());
    sock.on('error', () => this.destroy());
  }

  sendText(data: string) {
    this.write(encodeServerFrame(WsOpcode.Text, Buffer.from(data)));
  }

  sendBinary(data: Buffer) {
    this.write(encodeServerFrame(WsOpcode.Binary, data));
  }

  /** Polite close: send a close frame and end the socket. */
  close() {
    if (!this.closeSent) {
      this.closeSent = true;
      this.write(encodeServerFrame(WsOpcode.Close, Buffer.alloc(0)));
    }
    this.sock.end();
  }

  feed(chunk: Buffer) {
    if (this.closed || chunk.length === 0) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed) {
      const frame = this.tryReadFrame();
      if (!frame) return;
      this.handleFrame(frame);
    }
  }

  private write(data: Buffer) {
    if (!this.closed && this.sock.writable) this.sock.write(data);
  }

  private destroy() {
    if (this.closed) return;
    this.closed = true;
    this.sock.destroy();
    this.onclose();
  }

  private tryReadFrame(): WsFrame | undefined {
    const buf = this.buf;
    if (buf.length < 2) return undefined;
    if ((buf[0] & 0x70) !== 0) {
      // RSV bits without a negotiated extension
      this.destroy();
      return undefined;
    }
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return undefined;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return undefined;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) {
        this.destroy();
        return undefined;
      }
      len = Number(big);
      offset = 10;
    }
    if (len > MAX_MESSAGE_BYTES) {
      this.destroy();
      return undefined;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (buf.length < offset + len) return undefined;
    const payload = Buffer.allocUnsafe(len);
    buf.copy(payload, 0, offset, offset + len);
    if (masked) {
      for (let i = 0; i < len; i++) payload[i] ^= buf[maskOffset + (i % 4)];
    }
    this.buf = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  private handleFrame(frame: WsFrame) {
    switch (frame.opcode) {
      case WsOpcode.Ping:
        this.write(encodeServerFrame(WsOpcode.Pong, frame.payload));
        return;
      case WsOpcode.Pong:
        return;
      case WsOpcode.Close:
        if (!this.closeSent) {
          this.closeSent = true;
          this.write(encodeServerFrame(WsOpcode.Close, Buffer.alloc(0)));
        }
        this.destroy();
        return;
      case WsOpcode.Text:
      case WsOpcode.Binary:
        if (this.fragments) {
          // data frame while a fragmented message is in flight
          this.destroy();
          return;
        }
        if (frame.fin) {
          this.onmessage(frame.payload, frame.opcode === WsOpcode.Text);
        } else {
          this.fragments = [frame.payload];
          this.fragmentsText = frame.opcode === WsOpcode.Text;
          this.fragmentsBytes = frame.payload.length;
        }
        return;
      case WsOpcode.Continuation: {
        if (!this.fragments) {
          this.destroy();
          return;
        }
        this.fragments.push(frame.payload);
        this.fragmentsBytes += frame.payload.length;
        if (this.fragmentsBytes > MAX_MESSAGE_BYTES) {
          this.destroy();
          return;
        }
        if (frame.fin) {
          const whole = Buffer.concat(this.fragments);
          const isText = this.fragmentsText;
          this.fragments = undefined;
          this.onmessage(whole, isText);
        }
        return;
      }
      default:
        this.destroy();
    }
  }
}

/** Adapt a `ws`-library socket (Bun's built-in shim) to the codec interface.
 * Closing must wait for in-flight sends: the shim's `close()` does not flush
 * buffered frames the way `net.Socket.end()` does, which truncates a large
 * bootstrap payload on a slow link (invisible on loopback). */
function wrapWsLibSocket(ws: any): TunnelSocketLike {
  let pendingSends = 0;
  let closeRequested = false;
  const closeNow = () => {
    try {
      ws.close();
    } catch { /* already closing */ }
  };
  const sent = () => {
    pendingSends--;
    if (closeRequested && pendingSends === 0) closeNow();
  };
  const send = (data: string | Buffer, binary: boolean) => {
    if (ws.readyState !== 1 || closeRequested) return;
    pendingSends++;
    ws.send(data, { binary }, sent);
  };
  const wrapper: TunnelSocketLike = {
    onmessage: NOOP,
    onclose: NOOP,
    sendText: (data) => send(data, false),
    sendBinary: (data) => send(data, true),
    close: () => {
      closeRequested = true;
      if (pendingSends === 0) closeNow();
    },
  };
  ws.on('message', (data: any, isBinary: boolean) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    wrapper.onmessage(buf, !isBinary);
  });
  ws.on('close', () => wrapper.onclose());
  ws.on('error', () => wrapper.onclose());
  return wrapper;
}

function handleTunnelConnection(ws: TunnelSocketLike, opts: {
  proxyPort: number;
  buildBootstrap: () => TunnelBootstrap;
}) {
  let first = true;
  let upstream: net.Socket | undefined;
  ws.onclose = () => upstream?.destroy();
  ws.onmessage = (data) => {
    if (!first) {
      upstream?.write(data);
      return;
    }
    first = false;

    let control: { t?: string };
    try {
      control = JSON.parse(data.toString());
    } catch {
      ws.close();
      return;
    }

    if (control.t === 'bootstrap') {
      // Receiver-driven close: the client closes once it has the payload.
      // Closing here right after send truncates the in-flight payload on a
      // real WAN under Bun, whose ws close discards unflushed frames and
      // offers no reliable flush signal. The timer reaps clients that never
      // close.
      ws.sendText(JSON.stringify(opts.buildBootstrap()));
      const reaper = setTimeout(() => ws.close(), 30_000);
      reaper.unref?.();
      ws.onclose = () => clearTimeout(reaper);
      return;
    }

    if (control.t === 'connect') {
      upstream = net.connect(opts.proxyPort, '127.0.0.1');
      upstream.on('data', (d: Buffer) => ws.sendBinary(d));
      const teardown = () => {
        ws.close();
        upstream?.destroy();
      };
      upstream.on('close', teardown);
      upstream.on('error', teardown);
      return;
    }

    ws.close();
  };
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
  // Bun path: its node:http drops manual writes on upgrade sockets, so the
  // handshake must go through Bun's native built-in `ws` module (resolvable at
  // runtime with no package installed). The specifier is computed so neither
  // tsc nor the npm bundler tries to resolve/bundle a ws package; under Node
  // this import never runs.
  const bunWssPromise: Promise<any> | undefined = (globalThis as any).Bun
    ? (() => {
      const specifier = 'ws';
      return import(/* @vite-ignore */ specifier).then((m: any) => new m.WebSocketServer({
        noServer: true,
        // native clients fail the handshake if their offered protocols go
        // unanswered, so select ours when present
        handleProtocols: (protocols: Set<string>) => (protocols.has(TUNNEL_PROTOCOL) ? TUNNEL_PROTOCOL : false),
      }));
    })()
    : undefined;

  const onUpgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    // Only our path; leave any other upgrade for another handler / rejection.
    if (!(req.url ?? '').startsWith(TUNNEL_PATH)) return;
    if (!upgradeAuthOk(req, opts.token)) {
      opts.onAuthFailure?.();
      // (under Bun this response is dropped and the client just sees the close)
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (bunWssPromise) {
      bunWssPromise
        .then((wss) => wss.handleUpgrade(req, socket, head, (ws: any) => {
          handleTunnelConnection(wrapWsLibSocket(ws), opts);
        }))
        .catch(() => socket.destroy());
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    const responseLines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    // Native clients fail the handshake if they offered protocols and none was
    // selected, so echo our protocol back when it was offered.
    if (parseOfferedProtocols(req.headers['sec-websocket-protocol']).includes(TUNNEL_PROTOCOL)) {
      responseLines.push(`Sec-WebSocket-Protocol: ${TUNNEL_PROTOCOL}`);
    }
    socket.write(`${responseLines.join('\r\n')}\r\n\r\n`);

    const conn = new TunnelServerSocket(socket);
    handleTunnelConnection(conn, opts);
    if (head?.length) conn.feed(head);
  };

  httpServer.on('upgrade', onUpgrade);
  return {
    close: () => {
      httpServer.off('upgrade', onUpgrade);
    },
  };
}

// ---------------------------------------------------------------------------
// Guest (client) side — the runtime's native WebSocket
// ---------------------------------------------------------------------------

/** The slice of the WHATWG WebSocket API the client uses (typed locally so we
 * don't depend on DOM lib types). */
type NativeWs = {
  binaryType: string;
  readyState: number;
  send: (data: string | Uint8Array) => void;
  close: () => void;
  addEventListener: (type: string, listener: (ev: any) => void) => void;
};
const WS_OPEN = 1;

function openTunnelWs(url: string, token: string): NativeWs {
  const Ctor = (globalThis as any).WebSocket as (new (u: string, protocols?: Array<string>) => NativeWs) | undefined;
  if (!Ctor) throw new Error('global WebSocket is not available in this runtime');
  const ws = new Ctor(tunnelUrl(url), [TUNNEL_PROTOCOL, tunnelTokenProtocolEntry(token)]);
  ws.binaryType = 'arraybuffer';
  return ws;
}

function messageToBuffer(data: unknown): Buffer {
  if (typeof data === 'string') return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as Uint8Array);
}

/** Open a short-lived WS, ask for the bootstrap (env + certs), and return it. */
export function fetchTunnelBootstrap(url: string, token: string, timeoutMs = 15000): Promise<TunnelBootstrap> {
  return new Promise((resolve, reject) => {
    let ws: NativeWs;
    try {
      ws = openTunnelWs(url, token);
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error('tunnel bootstrap timed out'));
      ws.close();
    }, timeoutMs);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'bootstrap' })));
    ws.addEventListener('message', (ev) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(messageToBuffer(ev.data).toString()) as TunnelBootstrap);
      } catch (err) {
        reject(err);
      }
      ws.close();
    });
    // The native client surfaces a rejected handshake (e.g. a 401 on a bad
    // token) as a generic error event with no status code, so keep the message
    // actionable. `close` also rejects, covering error-less server closes;
    // rejecting after resolve is a no-op.
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('tunnel handshake failed. Check the URL and --token, and that the broker started with `--tunnel`.'));
    });
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      reject(new Error('tunnel closed before the bootstrap arrived'));
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
  const listener = net.createServer((sock) => {
    let ws: NativeWs;
    try {
      ws = openTunnelWs(opts.url, opts.token);
    } catch {
      sock.destroy();
      return;
    }
    const pending: Array<Buffer> = [];
    let open = false;
    ws.addEventListener('open', () => {
      open = true;
      ws.send(JSON.stringify({ t: 'connect' }));
      for (const b of pending) ws.send(b);
      pending.length = 0;
    });
    sock.on('data', (data: Buffer) => {
      if (open && ws.readyState === WS_OPEN) ws.send(data);
      else pending.push(data);
    });
    ws.addEventListener('message', (ev) => sock.write(messageToBuffer(ev.data)));
    const teardown = () => {
      try {
        ws.close();
      } catch { /* already closing */ }
      sock.destroy();
    };
    ws.addEventListener('close', teardown);
    ws.addEventListener('error', teardown);
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
