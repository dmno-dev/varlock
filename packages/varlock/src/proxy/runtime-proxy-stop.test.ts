import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { URL } from 'node:url';

import { startLocalProxyRuntime } from './runtime-proxy';
import {
  openMitmTunnel, sendAndRead, setupMitmHarness, UPSTREAM_HOST,
} from './mitm-test-harness';

// Regression coverage for stop() hanging on CONNECT tunnels. Once a request is
// upgraded to a tunnel the http server stops tracking its socket, so
// closeAllConnections() skips it while server.close() still waits for it. Both
// cases below hung forever before the tunnel sockets were tracked and tied to
// their peer's lifetime.

const { startUpstream } = setupMitmHarness();

const STOP_TIMEOUT_MS = 2000;
const stopOrTimeout = (stop: () => Promise<void>) => Promise.race([
  stop().then(() => 'stopped' as const),
  new Promise<'timed-out'>((resolve) => {
    setTimeout(() => resolve('timed-out'), STOP_TIMEOUT_MS);
  }),
]);

test('stop() resolves after a client read a blocked (torn-down) response and closed its socket', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });
  const runtime = await startLocalProxyRuntime({
    managedItems: [{ key: 'API_KEY', placeholder: 'sk-stub-PLACEHOLDER', realValue: 'sk-stub-REALKEY' }],
    rules: [{ domain: [UPSTREAM_HOST], itemKeys: ['API_KEY'] }],
    egressMode: 'permissive',
  });
  const proxyCaPem = readFileSync(runtime.env.NODE_EXTRA_CA_CERTS!, 'utf8');

  const tlsSocket = await openMitmTunnel(runtime.env.HTTP_PROXY!, proxyCaPem, upstream.port);
  // A duplicated placeholder trips the substitution guard: the proxy writes a
  // 403 and tears the MITM connection down. Reading the response (rather than
  // destroying the socket with it unread) is what used to wedge stop(): the
  // client's TLS close_notify arrived on a tunnel socket nobody was draining.
  const response = await sendAndRead(
    tlsSocket,
    `GET /data HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\nConnection: close\r\n`
      + 'Authorization: Bearer sk-stub-PLACEHOLDER\r\nX-Duplicate: sk-stub-PLACEHOLDER\r\n\r\n',
  );
  expect(response.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
  tlsSocket.destroy();

  await expect(stopOrTimeout(runtime.stop)).resolves.toBe('stopped');
  await upstream.close();
}, 5000);

test('stop() resolves while an idle passthrough CONNECT tunnel is still open', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.end('ok');
  });
  // No rule for the upstream host, so CONNECT is tunneled straight through
  // (no MITM) and the only thing holding the socket is the client itself.
  const runtime = await startLocalProxyRuntime({
    managedItems: [],
    rules: [],
    egressMode: 'permissive',
  });
  const proxy = new URL(runtime.env.HTTP_PROXY!);
  const rawSocket = net.connect(Number(proxy.port), proxy.hostname);
  rawSocket.on('error', () => { /* expected once stop() tears the tunnel down */ });
  await new Promise<void>((resolve) => {
    rawSocket.once('connect', () => resolve());
  });
  const statusLine = await new Promise<string>((resolve) => {
    rawSocket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8').split('\r\n')[0] ?? ''));
    rawSocket.write(`CONNECT ${UPSTREAM_HOST}:${upstream.port} HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${upstream.port}\r\n\r\n`);
  });
  expect(statusLine).toMatch(/^HTTP\/1\.1 200/);

  // The client never sends or closes anything: stop() must not wait on it.
  await expect(stopOrTimeout(runtime.stop)).resolves.toBe('stopped');
  // and the client side sees the tunnel go away rather than being left dangling
  const clientClosed = await Promise.race([
    new Promise<true>((resolve) => {
      if (rawSocket.closed) resolve(true);
      else rawSocket.once('close', () => resolve(true));
    }),
    new Promise<false>((resolve) => {
      setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
    }),
  ]);
  expect(clientClosed).toBe(true);
  await upstream.close();
}, 5000);
