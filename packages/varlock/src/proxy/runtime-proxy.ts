import {
  mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { URL } from 'node:url';

import { createEphemeralCa, createHostCert } from './cert-authority';
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

/**
 * Resolve the managed items that are in scope for a given host: only items
 * referenced by a rule whose domain matches this host. This enforces per-item
 * domain scoping — an item's secret is injected (and its real value redacted on
 * the way back) only on the hosts its own rule applies to, never on every ruled
 * host. Prevents a child from harvesting item B's real value by reflecting B's
 * placeholder into a request to item A's host.
 */
function getHostScopedManagedItems(
  host: string,
  rules: Array<ProxyRule>,
  managedItems: Array<ProxyManagedItem>,
): Array<ProxyManagedItem> {
  const allowedKeys = new Set<string>();
  for (const rule of rules) {
    if (rule.domain.some((d) => domainMatches(d, host))) {
      for (const key of rule.itemKeys) allowedKeys.add(key);
    }
  }
  if (allowedKeys.size === 0) return [];
  return managedItems.filter((item) => allowedKeys.has(item.key));
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

// Only buffer-and-redact bounded, reasonably small text bodies. Anything we
// can't size up front (SSE, chunked streams) or that's too large is streamed
// straight through — buffering it would break streaming (e.g. LLM token-by-token
// responses hang until complete) for a low-value protection: the injected secret
// is in the request, not the response. Header redaction still applies regardless.
const MAX_REDACT_BODY_BYTES = 2 * 1024 * 1024;

function isStreamingResponse(headers: http.IncomingHttpHeaders): boolean {
  const contentType = getHeaderValue(headers, 'content-type')?.toLowerCase() ?? '';
  return contentType.includes('text/event-stream');
}

function isBoundedRedactableBody(headers: http.IncomingHttpHeaders): boolean {
  const lenRaw = getHeaderValue(headers, 'content-length');
  if (lenRaw === undefined) return false; // unknown size — treat as a stream, never buffer
  const len = Number(lenRaw);
  return Number.isFinite(len) && len >= 0 && len <= MAX_REDACT_BODY_BYTES;
}

function shouldRedactResponseBody(headers: http.IncomingHttpHeaders): boolean {
  return isUncompressedResponse(headers)
    && isTextLikeResponse(headers)
    && !isStreamingResponse(headers)
    && isBoundedRedactableBody(headers);
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
  // Only the public CA cert is written to disk (for child trust). Private keys
  // — the CA's and every per-host leaf's — stay in memory; see cert-authority.ts.
  const certsDir = await mkdtemp(path.join(os.tmpdir(), 'varlock-proxy-certs-'));
  const ca = await createEphemeralCa();
  const caCertPath = path.join(certsDir, 'ca-cert.pem');
  const combinedCaPath = path.join(certsDir, 'combined-ca.pem');
  await writeFile(caCertPath, ca.certPem, 'utf8');
  await writeFile(combinedCaPath, `${ca.certPem}\n${tls.rootCertificates.join('\n')}\n`, 'utf8');

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
    const hostItems = shouldRewrite ? getHostScopedManagedItems(hostInfo.host, rules, managedItems) : [];
    const body = await readBody(req);
    const rewrittenBody = shouldRewrite
      ? Buffer.from(replacePlaceholdersWithReal(body.toString('utf8'), hostItems), 'utf8')
      : body;

    const upstreamHeaders = transformHeaders(
      req.headers,
      shouldRewrite
        ? (value) => replacePlaceholdersWithReal(value, hostItems)
        : (value) => value,
    );
    delete upstreamHeaders['proxy-connection'];
    delete upstreamHeaders.connection;
    const rewrittenPath = shouldRewrite
      ? buildPathnameAndQuery(req.url ?? '/', hostItems)
      : (req.url ?? '/');

    if (rewrittenBody.byteLength !== body.byteLength) {
      upstreamHeaders['content-length'] = String(rewrittenBody.byteLength);
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
        hostItems,
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

    const hostCert = await createHostCert(ca, normalized);
    const server = https.createServer({
      key: hostCert.keyPem,
      cert: hostCert.certPem,
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
    const hostItems = shouldRewrite ? getHostScopedManagedItems(destination.hostname, rules, managedItems) : [];

    const body = await readBody(clientReq);
    const rewrittenBody = shouldRewrite
      ? Buffer.from(replacePlaceholdersWithReal(body.toString('utf8'), hostItems), 'utf8')
      : body;

    const rewrittenPath = shouldRewrite
      ? buildPathnameAndQuery(`${destination.pathname}${destination.search}`, hostItems)
      : `${destination.pathname}${destination.search}`;

    const upstreamHeaders = transformHeaders(
      clientReq.headers,
      shouldRewrite
        ? (value) => replacePlaceholdersWithReal(value, hostItems)
        : (value) => value,
    );
    delete upstreamHeaders['proxy-connection'];
    delete upstreamHeaders.connection;
    upstreamHeaders.host = destination.host;
    if (rewrittenBody.byteLength !== body.byteLength) {
      upstreamHeaders['content-length'] = String(rewrittenBody.byteLength);
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
        hostItems,
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
      const blockedBody = 'Proxy egress blocked by strict mode';
      clientSocket.write(
        `HTTP/1.1 403 Forbidden\r\nContent-Length: ${Buffer.byteLength(blockedBody)}\r\nConnection: close\r\n\r\n${blockedBody}`,
      );
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
