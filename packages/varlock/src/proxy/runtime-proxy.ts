import { execFileSync } from 'node:child_process';
import {
  mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { URL } from 'node:url';

import type { ProxyEgressMode, ProxyManagedItem, ProxyRule } from './types';

const LOCALHOST = '127.0.0.1';

export type ProxyRuntimeContext = {
  env: NodeJS.ProcessEnv;
  stop: () => Promise<void>;
};

export type StartLocalProxyRuntimeInput = {
  managedItems: Array<ProxyManagedItem>;
  rules: Array<ProxyRule>;
  egressMode: ProxyEgressMode;
  onActivity?: (activity: {
    matched: boolean;
    blocked: boolean;
  }) => void;
};

type HostInfo = { host: string, port: number };

type HeaderTransformFn = (value: string) => string;

function parseHostPort(value: string): HostInfo | null {
  const [host, portRaw] = value.split(':');
  if (!host) return null;
  const port = Number(portRaw ?? 443);
  if (Number.isNaN(port)) return null;
  return { host, port };
}

function normalizeHost(host: string): string {
  return host.toLowerCase().trim();
}

function domainMatches(domainPattern: string, host: string): boolean {
  const pattern = normalizeHost(domainPattern);
  const normalizedHost = normalizeHost(host);
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedHost === pattern;
}

function hostMatchesProxyRules(host: string, rules: Array<ProxyRule>): boolean {
  return rules.some((rule) => rule.domain.some((d) => domainMatches(d, host)));
}

function replacePlaceholdersWithReal(value: string, managedItems: Array<ProxyManagedItem>): string {
  let next = value;
  for (const item of managedItems) {
    if (item.placeholder) {
      next = next.split(item.placeholder).join(item.realValue);
    }
  }
  return next;
}

function replaceRealWithPlaceholders(value: string, managedItems: Array<ProxyManagedItem>): string {
  let next = value;
  const sortedByRealLength = [...managedItems]
    .filter((item) => !!item.realValue && !!item.placeholder)
    .sort((a, b) => b.realValue.length - a.realValue.length);
  for (const item of sortedByRealLength) {
    next = next.split(item.realValue).join(item.placeholder);
  }
  return next;
}

function transformHeaders(
  headers: http.IncomingHttpHeaders,
  transformValue: HeaderTransformFn,
): Record<string, string | Array<string>> {
  const out: Record<string, string | Array<string>> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      out[key] = val.map((v) => transformValue(v));
    } else {
      out[key] = transformValue(String(val));
    }
  }
  return out;
}

function getHeaderValue(
  headers: http.IncomingHttpHeaders,
  key: string,
): string | undefined {
  const raw = headers[key.toLowerCase()];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw[0];
  return String(raw);
}

function isUncompressedResponse(headers: http.IncomingHttpHeaders): boolean {
  const contentEncoding = getHeaderValue(headers, 'content-encoding');
  if (!contentEncoding) return true;
  const tokens = contentEncoding.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every((token) => token === 'identity');
}

function isTextLikeResponse(headers: http.IncomingHttpHeaders): boolean {
  const contentType = getHeaderValue(headers, 'content-type')?.toLowerCase();
  if (!contentType) return false;
  return contentType.startsWith('text/')
    || contentType.includes('json')
    || contentType.includes('xml')
    || contentType.includes('javascript')
    || contentType.includes('x-www-form-urlencoded')
    || contentType.includes('graphql');
}

function shouldRedactResponseBody(headers: http.IncomingHttpHeaders): boolean {
  return isUncompressedResponse(headers) && isTextLikeResponse(headers);
}

function redactOutgoingHeaders(
  headers: http.IncomingHttpHeaders,
  managedItems: Array<ProxyManagedItem>,
): Record<string, string | Array<string>> {
  return transformHeaders(
    headers,
    (value) => replaceRealWithPlaceholders(value, managedItems),
  );
}

function forwardUpstreamResponseWithRedaction(
  upstreamRes: http.IncomingMessage,
  clientRes: http.ServerResponse,
  managedItems: Array<ProxyManagedItem>,
  shouldRedact: boolean,
) {
  const statusCode = upstreamRes.statusCode ?? 502;
  const outgoingHeaders = shouldRedact
    ? redactOutgoingHeaders(upstreamRes.headers, managedItems)
    : { ...upstreamRes.headers };

  if (!shouldRedact || !shouldRedactResponseBody(upstreamRes.headers)) {
    clientRes.writeHead(statusCode, outgoingHeaders);
    upstreamRes.pipe(clientRes);
    return;
  }

  const chunks: Array<Buffer> = [];
  upstreamRes.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  upstreamRes.on('end', () => {
    const originalBody = Buffer.concat(chunks).toString('utf8');
    const redactedBody = replaceRealWithPlaceholders(originalBody, managedItems);
    const redactedBuffer = Buffer.from(redactedBody, 'utf8');

    const headersForWrite = { ...outgoingHeaders };
    headersForWrite['content-length'] = String(redactedBuffer.byteLength);
    delete headersForWrite['transfer-encoding'];
    delete headersForWrite.etag;

    clientRes.writeHead(statusCode, headersForWrite);
    clientRes.end(redactedBuffer);
  });

  upstreamRes.on('error', () => {
    if (!clientRes.headersSent) clientRes.statusCode = 502;
    clientRes.end('Upstream proxy error');
  });
}

function sanitizeHostForFilename(host: string): string {
  return host.replaceAll(/[^a-zA-Z0-9.-]/g, '_');
}

function runOpenssl(args: Array<string>) {
  execFileSync('openssl', args, {
    stdio: 'ignore',
  });
}

async function createProxyCa(certsDir: string): Promise<{
  caKeyPath: string;
  caCertPath: string;
  combinedCaPath: string;
}> {
  const caKeyPath = path.join(certsDir, 'ca-key.pem');
  const caCertPath = path.join(certsDir, 'ca-cert.pem');
  const combinedCaPath = path.join(certsDir, 'combined-ca.pem');

  runOpenssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-days',
    '3',
    '-keyout',
    caKeyPath,
    '-out',
    caCertPath,
    '-subj',
    '/CN=varlock-proxy-ca',
  ]);

  const [caCertContents] = await Promise.all([readFile(caCertPath, 'utf8')]);
  const combined = `${caCertContents}\n${tls.rootCertificates.join('\n')}\n`;
  await writeFile(combinedCaPath, combined, 'utf8');

  return { caKeyPath, caCertPath, combinedCaPath };
}

async function createHostCert(
  certsDir: string,
  host: string,
  caKeyPath: string,
  caCertPath: string,
): Promise<{
  key: Buffer;
  cert: Buffer;
  context: tls.SecureContext;
}> {
  const safeHost = sanitizeHostForFilename(host);
  const hostKeyPath = path.join(certsDir, `${safeHost}.key.pem`);
  const hostCsrPath = path.join(certsDir, `${safeHost}.csr.pem`);
  const hostCertPath = path.join(certsDir, `${safeHost}.cert.pem`);
  const extPath = path.join(certsDir, `${safeHost}.ext.cnf`);
  const serialPath = path.join(certsDir, 'ca.srl');

  await writeFile(extPath, `subjectAltName=DNS:${host}\n`, 'utf8');

  runOpenssl([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    hostKeyPath,
    '-out',
    hostCsrPath,
    '-subj',
    `/CN=${host}`,
  ]);

  runOpenssl([
    'x509',
    '-req',
    '-in',
    hostCsrPath,
    '-CA',
    caCertPath,
    '-CAkey',
    caKeyPath,
    '-CAserial',
    serialPath,
    '-CAcreateserial',
    '-out',
    hostCertPath,
    '-days',
    '3',
    '-sha256',
    '-extfile',
    extPath,
  ]);

  const [key, cert] = await Promise.all([
    readFile(hostKeyPath),
    readFile(hostCertPath),
  ]);
  return {
    key,
    cert,
    context: tls.createSecureContext({ key, cert }),
  };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function buildPathnameAndQuery(input: string, managedItems: Array<ProxyManagedItem>): string {
  return replacePlaceholdersWithReal(input, managedItems);
}

/**
 * Local MITM proxy runtime for `varlock proxy run`.
 * Rewrites placeholder values to real values for requests matching @proxy domains.
 */
export async function startLocalProxyRuntime({
  managedItems,
  rules,
  egressMode,
  onActivity,
}: StartLocalProxyRuntimeInput): Promise<ProxyRuntimeContext> {
  const certsDir = await mkdtemp(path.join(os.tmpdir(), 'varlock-proxy-certs-'));
  const { caKeyPath, caCertPath, combinedCaPath } = await createProxyCa(certsDir);

  const handleInterceptRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const hostHeader = req.headers.host ?? '';
    const hostInfo = parseHostPort(hostHeader.includes(':') ? hostHeader : `${hostHeader}:443`);
    if (!hostInfo) {
      res.statusCode = 400;
      res.end('Invalid host');
      return;
    }

    const shouldRewrite = hostMatchesProxyRules(hostInfo.host, rules);
    const shouldAllowEgress = egressMode === 'permissive' || shouldRewrite;
    if (!shouldAllowEgress) {
      onActivity?.({
        matched: shouldRewrite,
        blocked: true,
      });
      res.statusCode = 403;
      res.end('Proxy egress blocked by strict mode');
      return;
    }
    onActivity?.({
      matched: shouldRewrite,
      blocked: false,
    });
    const body = await readBody(req);
    const bodyString = body.toString('utf8');
    const rewrittenBody = shouldRewrite ? replacePlaceholdersWithReal(bodyString, managedItems) : bodyString;

    const upstreamHeaders = transformHeaders(
      req.headers,
      shouldRewrite
        ? (value) => replacePlaceholdersWithReal(value, managedItems)
        : (value) => value,
    );
    delete upstreamHeaders['proxy-connection'];
    delete upstreamHeaders.connection;

    const rewrittenPath = shouldRewrite
      ? buildPathnameAndQuery(req.url ?? '/', managedItems)
      : (req.url ?? '/');

    if (rewrittenBody.length !== body.length) {
      upstreamHeaders['content-length'] = String(Buffer.byteLength(rewrittenBody));
    }

    const upstreamReq = https.request({
      protocol: 'https:',
      hostname: hostInfo.host,
      port: hostInfo.port || 443,
      method: req.method,
      path: rewrittenPath,
      headers: upstreamHeaders,
    }, (upstreamRes) => {
      forwardUpstreamResponseWithRedaction(
        upstreamRes,
        res,
        managedItems,
        shouldRewrite,
      );
    });

    upstreamReq.on('error', () => {
      if (!res.headersSent) res.statusCode = 502;
      res.end('Upstream MITM request failed');
    });
    upstreamReq.end(rewrittenBody);
  };

  const hostMitmServers = new Map<string, { server: https.Server; port: number }>();
  const getOrCreateHostMitmServer = async (host: string): Promise<{ server: https.Server; port: number }> => {
    const normalized = normalizeHost(host);
    const cached = hostMitmServers.get(normalized);
    if (cached) return cached;

    const hostCert = await createHostCert(certsDir, normalized, caKeyPath, caCertPath);
    const server = https.createServer({
      key: hostCert.key,
      cert: hostCert.cert,
      ALPNProtocols: ['http/1.1'],
    }, (req, res) => {
      handleInterceptRequest(req, res).catch(() => {
        if (!res.headersSent) res.statusCode = 502;
        res.end('Upstream MITM request failed');
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOCALHOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      server.close();
      throw new Error(`Failed to start MITM TLS server for ${normalized}`);
    }

    const created = { server, port: addr.port };
    hostMitmServers.set(normalized, created);
    return created;
  };

  // Handles absolute-form proxy requests (mostly plain HTTP).
  const proxyServer = http.createServer(async (clientReq, clientRes) => {
    const urlRaw = clientReq.url;
    if (!urlRaw) {
      clientRes.statusCode = 400;
      clientRes.end('Missing request URL');
      return;
    }

    let destination: URL;
    try {
      destination = new URL(urlRaw);
    } catch {
      clientRes.statusCode = 400;
      clientRes.end('Invalid proxy request URL');
      return;
    }

    const shouldRewrite = hostMatchesProxyRules(destination.hostname, rules);
    const shouldAllowEgress = egressMode === 'permissive' || shouldRewrite;
    if (!shouldAllowEgress) {
      onActivity?.({
        matched: shouldRewrite,
        blocked: true,
      });
      clientRes.statusCode = 403;
      clientRes.end('Proxy egress blocked by strict mode');
      return;
    }
    onActivity?.({
      matched: shouldRewrite,
      blocked: false,
    });
    const isHttps = destination.protocol === 'https:';

    const body = await readBody(clientReq);
    const bodyString = body.toString('utf8');
    const rewrittenBody = shouldRewrite ? replacePlaceholdersWithReal(bodyString, managedItems) : bodyString;

    const rewrittenPath = shouldRewrite
      ? buildPathnameAndQuery(`${destination.pathname}${destination.search}`, managedItems)
      : `${destination.pathname}${destination.search}`;

    const upstreamHeaders = transformHeaders(
      clientReq.headers,
      shouldRewrite
        ? (value) => replacePlaceholdersWithReal(value, managedItems)
        : (value) => value,
    );
    delete upstreamHeaders['proxy-connection'];
    delete upstreamHeaders.connection;
    upstreamHeaders.host = destination.host;

    if (rewrittenBody.length !== body.length) {
      upstreamHeaders['content-length'] = String(Buffer.byteLength(rewrittenBody));
    }

    const upstream = (isHttps ? https : http).request({
      protocol: destination.protocol,
      hostname: destination.hostname,
      port: destination.port || (isHttps ? 443 : 80),
      method: clientReq.method,
      path: rewrittenPath,
      headers: upstreamHeaders,
    }, (upstreamRes) => {
      forwardUpstreamResponseWithRedaction(
        upstreamRes,
        clientRes,
        managedItems,
        shouldRewrite,
      );
    });

    upstream.on('error', () => {
      if (!clientRes.headersSent) clientRes.statusCode = 502;
      clientRes.end('Upstream proxy error');
    });
    upstream.end(rewrittenBody);
  });

  proxyServer.on('connect', async (req, clientSocket, head) => {
    const hostInfo = parseHostPort(req.url ?? '');
    if (!hostInfo) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const shouldRewrite = hostMatchesProxyRules(hostInfo.host, rules);
    const shouldAllowEgress = egressMode === 'permissive' || shouldRewrite;
    if (!shouldAllowEgress) {
      onActivity?.({
        matched: shouldRewrite,
        blocked: true,
      });
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 34\r\nConnection: close\r\n\r\nProxy egress blocked by strict mode');
      clientSocket.destroy();
      return;
    }

    // Only MITM for configured proxy domains. Others are tunneled through.
    if (!shouldRewrite) {
      const upstreamSocket = net.connect(hostInfo.port, hostInfo.host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstreamSocket.write(head);
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
      });
      upstreamSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstreamSocket.destroy());
      return;
    }

    try {
      const hostMitmServer = await getOrCreateHostMitmServer(hostInfo.host);
      const mitmSocket = net.connect(hostMitmServer.port, LOCALHOST, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) {
          mitmSocket.write(head);
        }
        clientSocket.pipe(mitmSocket);
        mitmSocket.pipe(clientSocket);
      });
      mitmSocket.on('error', () => {
        clientSocket.destroy();
      });
      clientSocket.on('error', () => {
        mitmSocket.destroy();
      });
    } catch {
      clientSocket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    proxyServer.once('error', reject);
    proxyServer.listen(0, LOCALHOST, () => {
      proxyServer.off('error', reject);
      resolve();
    });
  });

  const address = proxyServer.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => {
      proxyServer.close(() => resolve());
    });
    throw new Error('Failed to start local proxy runtime');
  }
  const proxyUrl = `http://${LOCALHOST}:${address.port}`;

  return {
    env: {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: proxyUrl,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      NODE_EXTRA_CA_CERTS: caCertPath,
      SSL_CERT_FILE: combinedCaPath,
      REQUESTS_CA_BUNDLE: combinedCaPath,
      CURL_CA_BUNDLE: combinedCaPath,
      GIT_SSL_CAINFO: combinedCaPath,
    },
    stop: async () => {
      await Promise.all([
        new Promise<void>((resolve) => {
          proxyServer.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          Promise.all(
            [...hostMitmServers.values()].map(({ server }) => new Promise<void>((innerResolve) => {
              server.close(() => innerResolve());
            })),
          ).then(() => resolve());
        }),
      ]);
      await rm(certsDir, { recursive: true, force: true });
    },
  };
}
