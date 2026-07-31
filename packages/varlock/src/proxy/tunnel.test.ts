/* eslint-disable no-bitwise -- hand-rolled WS frames for codec tests */
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import {
  attachTunnelServer, fetchTunnelBootstrap, startTunnelClientListener, proxyForTunnelUrl,
  TUNNEL_TOKEN_HEADER, TUNNEL_PATH,
  type TunnelBootstrap,
} from './tunnel';

const TOKEN = 'tunnel-test-token';

/** Set env vars for a test, returning a restore fn that puts the prior values back. */
function withEnvVars(vars: Record<string, string>): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const [key, was] of Object.entries(prev)) {
      if (was === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = was;
      }
    }
  };
}

/** A minimal HTTP CONNECT proxy standing in for a sandbox egress gateway. Counts
 * how many CONNECTs it served so tests can assert traffic actually went through it. */
function startConnectProxy(): Promise<{ port: number; connects: () => number; close: () => void }> {
  let connects = 0;
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.on('connect', (req, clientSock, head) => {
      connects += 1;
      const [host, port] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(port), host, () => {
        clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSock);
        clientSock.pipe(upstream);
      });
      const kill = () => {
        upstream.destroy();
        clientSock.destroy();
      };
      upstream.on('error', kill);
      clientSock.on('error', kill);
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: (srv.address() as net.AddressInfo).port,
        connects: () => connects,
        close: () => srv.close(),
      });
    });
  });
}

/** An echo TCP server standing in for the broker's proxy loopback port. */
function startEcho(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => sock.pipe(sock));
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() });
    });
  });
}

/** A broker: http.Server with the tunnel attached, bridging to the echo port. */
const EMPTY_PAYLOAD_JSON = '{"env":{},"omittedKeys":[],"serializedGraph":{"config":{}}}';

function startBroker(echoPort: number, bootstrap: TunnelBootstrap = { payloadJson: EMPTY_PAYLOAD_JSON, certs: { 'ca-cert.pem': 'CA' } }) {
  return new Promise<{ url: string; port: number; close: () => void }>((resolve) => {
    const httpServer = http.createServer((_r, res) => {
      res.writeHead(426);
      res.end();
    });
    const tunnel = attachTunnelServer(httpServer, {
      token: TOKEN, proxyPort: echoPort, buildBootstrap: () => bootstrap,
    });
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address() as net.AddressInfo;
      const close = () => {
        tunnel.close();
        httpServer.close();
      };
      resolve({ url: `ws://127.0.0.1:${port}`, port, close });
    });
  });
}

// ---------------------------------------------------------------------------
// Raw-socket WS client helpers: exercise codec paths the native client never
// produces (fragmentation, pings, header-based auth).
// ---------------------------------------------------------------------------

/** Encode one client→server frame (clients must mask). */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

/** Complete a WS handshake over a raw socket using the token header, then
 * collect parsed server frames via callback. */
function rawWsConnect(port: number, onFrame: (opcode: number, payload: Buffer) => void): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write([
        `GET ${TUNNEL_PATH} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        `${TUNNEL_TOKEN_HEADER}: ${TOKEN}`,
        '',
        '',
      ].join('\r\n'));
    });
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buf.subarray(0, end).toString();
        if (!head.startsWith('HTTP/1.1 101')) {
          reject(new Error(`handshake failed: ${head.split('\r\n')[0]}`));
          return;
        }
        handshakeDone = true;
        buf = buf.subarray(end + 4);
        resolve(sock);
      }
      // parse unmasked server frames
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        if (buf.length < offset + len) return;
        onFrame(opcode, buf.subarray(offset, offset + len));
        buf = buf.subarray(offset + len);
      }
    });
  });
}

describe('tunnel bootstrap', () => {
  test('serves the bootstrap over an authenticated WS (native client, subprotocol token)', async () => {
    const echo = await startEcho();
    const payloadJson = '{"env":{"FOO":"bar"},"omittedKeys":[],"serializedGraph":{"config":{}}}';
    const broker = await startBroker(echo.port, { payloadJson, certs: { 'ca-cert.pem': 'PEM' } });
    const boot = await fetchTunnelBootstrap(broker.url, TOKEN);
    expect(JSON.parse(boot.payloadJson).env.FOO).toBe('bar');
    expect(boot.certs['ca-cert.pem']).toBe('PEM');
    broker.close();
    echo.close();
  });

  test('rejects a bad token at the handshake', async () => {
    const echo = await startEcho();
    const broker = await startBroker(echo.port);
    await expect(fetchTunnelBootstrap(broker.url, 'wrong-token', 3000)).rejects.toThrow();
    broker.close();
    echo.close();
  });
});

describe('tunnel data path', () => {
  test('bridges a loopback connection through the WS to the broker proxy', async () => {
    const echo = await startEcho();
    const broker = await startBroker(echo.port);
    const listener = await startTunnelClientListener({ url: broker.url, token: TOKEN });

    // >65535 bytes so both directions exercise the 64-bit length encoding
    const payload = randomBytes(100_000);
    const received = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Array<Buffer> = [];
      let total = 0;
      const c = net.connect(listener.port, '127.0.0.1', () => c.write(payload));
      c.on('data', (d: Buffer) => {
        chunks.push(d);
        total += d.length;
        if (total >= payload.length) {
          c.destroy();
          resolve(Buffer.concat(chunks));
        }
      });
      c.on('error', reject);
      setTimeout(() => reject(new Error(`timed out after ${total}`)), 5000);
    });
    expect(received.equals(payload)).toBe(true);

    listener.close();
    broker.close();
    echo.close();
  });
});

describe('server frame codec (raw client)', () => {
  test('header auth + fragmented control message + text reply', async () => {
    const echo = await startEcho();
    const broker = await startBroker(echo.port);

    let resolveReply!: (b: Buffer) => void;
    let rejectReply!: (e: Error) => void;
    const replyPromise = new Promise<Buffer>((resolve, reject) => {
      resolveReply = resolve;
      rejectReply = reject;
    });
    const timer = setTimeout(() => rejectReply(new Error('timed out')), 5000);
    const sock = await rawWsConnect(broker.port, (opcode, payload) => {
      if (opcode === 0x1) resolveReply(payload);
    });
    // '{"t":"bootstrap"}' split across a non-fin text frame + fin continuation
    const msg = Buffer.from('{"t":"bootstrap"}');
    sock.write(clientFrame(0x1, msg.subarray(0, 6), false));
    sock.write(clientFrame(0x0, msg.subarray(6), true));
    const reply = await replyPromise;
    clearTimeout(timer);
    const boot = JSON.parse(reply.toString()) as TunnelBootstrap;
    expect(boot.certs['ca-cert.pem']).toBe('CA');

    broker.close();
    echo.close();
  });

  test('ping is answered with a pong echoing the payload', async () => {
    const echo = await startEcho();
    const broker = await startBroker(echo.port);

    let resolvePong!: (b: Buffer) => void;
    let rejectPong!: (e: Error) => void;
    const pongPromise = new Promise<Buffer>((resolve, reject) => {
      resolvePong = resolve;
      rejectPong = reject;
    });
    const timer = setTimeout(() => rejectPong(new Error('timed out')), 5000);
    const sock = await rawWsConnect(broker.port, (opcode, payload) => {
      if (opcode === 0xa) resolvePong(payload);
    });
    sock.write(clientFrame(0x9, Buffer.from('marco')));
    const pong = await pongPromise;
    clearTimeout(timer);
    expect(pong.toString()).toBe('marco');

    broker.close();
    echo.close();
  });
});

describe('proxy selection', () => {
  const base = 'ws://broker.internal:8080';
  test('picks HTTP_PROXY for ws:// and honors NO_PROXY', () => {
    expect(proxyForTunnelUrl(base, { HTTP_PROXY: 'http://gw:3128' })).toBe('http://gw:3128');
    expect(proxyForTunnelUrl(base, { HTTP_PROXY: 'http://gw:3128', NO_PROXY: 'broker.internal' })).toBeUndefined();
    expect(proxyForTunnelUrl(base, { HTTP_PROXY: 'http://gw:3128', NO_PROXY: '*' })).toBeUndefined();
  });
  test('picks HTTPS_PROXY for wss:// and falls back to ALL_PROXY', () => {
    expect(proxyForTunnelUrl('wss://broker.example.com', { HTTPS_PROXY: 'http://gw:3128' })).toBe('http://gw:3128');
    expect(proxyForTunnelUrl(base, { ALL_PROXY: 'http://gw:3128' })).toBe('http://gw:3128');
  });
  test('ignores socks and https proxies and a missing proxy (direct dial)', () => {
    expect(proxyForTunnelUrl(base, {})).toBeUndefined();
    expect(proxyForTunnelUrl(base, { ALL_PROXY: 'socks5://gw:1080' })).toBeUndefined();
    // https-to-proxy needs a TLS handshake before CONNECT, which this transport
    // does not do, so it must not be advertised as supported.
    expect(proxyForTunnelUrl(base, { HTTP_PROXY: 'https://gw:3128' })).toBeUndefined();
    expect(proxyForTunnelUrl('wss://broker.example.com', { HTTPS_PROXY: 'https://gw:3128' })).toBeUndefined();
  });
  test('dot-suffix NO_PROXY matches subdomains', () => {
    expect(proxyForTunnelUrl('ws://a.corp.example:8080', { HTTP_PROXY: 'http://gw:3128', NO_PROXY: '.example' })).toBeUndefined();
    expect(proxyForTunnelUrl('ws://a.corp.example:8080', { HTTP_PROXY: 'http://gw:3128', NO_PROXY: 'other.test' })).toBe('http://gw:3128');
  });
});

describe('tunnel through a CONNECT proxy', () => {
  test('fetches the bootstrap via the proxy when HTTP_PROXY is set', async () => {
    const echo = await startEcho();
    const broker = await startBroker(echo.port, { payloadJson: '{"env":{"VIA":"proxy"},"omittedKeys":[],"serializedGraph":{"config":{}}}', certs: { 'ca-cert.pem': 'PX' } });
    const proxy = await startConnectProxy();
    const restore = withEnvVars({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` });
    try {
      const boot = await fetchTunnelBootstrap(broker.url, TOKEN);
      expect(JSON.parse(boot.payloadJson).env.VIA).toBe('proxy');
      expect(boot.certs['ca-cert.pem']).toBe('PX');
      expect(proxy.connects()).toBeGreaterThan(0);
    } finally {
      restore();
    }
    proxy.close();
    broker.close();
    echo.close();
  });

  test('bridges the data path through the proxy (large, both directions)', async () => {
    const echo = await startEcho();
    const broker = await startBroker(echo.port);
    const proxy = await startConnectProxy();
    const restore = withEnvVars({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` });
    let listener: Awaited<ReturnType<typeof startTunnelClientListener>> | undefined;
    try {
      listener = await startTunnelClientListener({ url: broker.url, token: TOKEN });
      const payload = randomBytes(100_000);
      const received = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Array<Buffer> = [];
        let total = 0;
        const c = net.connect(listener!.port, '127.0.0.1', () => c.write(payload));
        c.on('data', (d: Buffer) => {
          chunks.push(d);
          total += d.length;
          if (total >= payload.length) {
            c.destroy();
            resolve(Buffer.concat(chunks));
          }
        });
        c.on('error', reject);
        setTimeout(() => reject(new Error(`timed out after ${total}`)), 5000);
      });
      expect(received.equals(payload)).toBe(true);
      expect(proxy.connects()).toBeGreaterThan(0);
    } finally {
      restore();
    }
    listener?.close();
    proxy.close();
    broker.close();
    echo.close();
  });

  test('surfaces a bad token through the proxy as an error', async () => {
    const echo = await startEcho();
    const broker = await startBroker(echo.port);
    const proxy = await startConnectProxy();
    const restore = withEnvVars({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` });
    try {
      await expect(fetchTunnelBootstrap(broker.url, 'wrong-token', 3000)).rejects.toThrow();
    } finally {
      restore();
    }
    proxy.close();
    broker.close();
    echo.close();
  });

  test('a stalled CONNECT handshake is cancelled on timeout (socket destroyed, no hang)', async () => {
    // Proxy accepts the TCP connection but never answers the CONNECT, so the
    // handshake stalls. The bootstrap timeout must destroy the in-flight socket.
    let signalAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      signalAccepted = resolve;
    });
    let signalClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      signalClosed = resolve;
    });
    const drain = () => { /* read so the peer RST is noticed */ };
    const srv = net.createServer((sock) => {
      signalAccepted();
      // Read (flowing mode) but never answer the CONNECT, so the handshake stalls
      // while the server still notices when the client tears the socket down. (A
      // paused/never-read socket would not surface the peer RST under Node.)
      sock.on('data', drain);
      sock.on('error', drain);
      sock.on('close', () => signalClosed());
    });
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port));
    });
    const restore = withEnvVars({ HTTP_PROXY: `http://127.0.0.1:${port}` });
    try {
      await expect(fetchTunnelBootstrap('ws://broker.internal:9', TOKEN, 400)).rejects.toThrow();
      await accepted; // the client did reach the proxy and stall there
      // the timeout's close() must have destroyed the in-flight socket
      await Promise.race([
        closed,
        new Promise((_r, reject) => { setTimeout(() => reject(new Error('socket not closed after timeout')), 2000); }),
      ]);
    } finally {
      restore();
    }
    srv.close();
  });

  test('NO_PROXY makes a loopback broker dial direct (proxy unused)', async () => {
    const echo = await startEcho();
    const broker = await startBroker(echo.port);
    const proxy = await startConnectProxy();
    const restore = withEnvVars({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: '127.0.0.1' });
    try {
      const boot = await fetchTunnelBootstrap(broker.url, TOKEN);
      expect(boot.certs['ca-cert.pem']).toBe('CA');
      expect(proxy.connects()).toBe(0);
    } finally {
      restore();
    }
    proxy.close();
    broker.close();
    echo.close();
  });
});

describe('tunnel constants', () => {
  test('token header and path are stable', () => {
    expect(TUNNEL_TOKEN_HEADER).toBe('x-varlock-tunnel-token');
    expect(TUNNEL_PATH.startsWith('/')).toBe(true);
  });
});
