import http from 'node:http';
import net from 'node:net';
import { describe, expect, test } from 'vitest';

import {
  attachTunnelServer, fetchTunnelBootstrap, startTunnelClientListener, TUNNEL_TOKEN_HEADER, TUNNEL_PATH,
  type TunnelBootstrap,
} from './tunnel';

const TOKEN = 'tunnel-test-token';

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
  return new Promise<{ url: string; close: () => void }>((resolve) => {
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
      resolve({ url: `ws://127.0.0.1:${port}`, close });
    });
  });
}

describe('tunnel bootstrap', () => {
  test('serves the bootstrap over an authenticated WS', async () => {
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

    const payload = Buffer.from('hello through the tunnel'.repeat(100));
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

describe('tunnel constants', () => {
  test('token header and path are stable', () => {
    expect(TUNNEL_TOKEN_HEADER).toBe('x-varlock-tunnel-token');
    expect(TUNNEL_PATH.startsWith('/')).toBe(true);
  });
});
