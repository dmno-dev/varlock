import {
  mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import tls from 'node:tls';
import { URL } from 'node:url';

import type { ProxyActivity } from './audit';
import { createEphemeralCa, createHostCert } from './cert-authority';
import {
  describeRule, evaluateProxyPolicy, getRequestScopedManagedItems, type RequestFacts,
} from './policy';
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
  onActivity?: (activity: ProxyActivity) => void;
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

function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replace(/:/g, '').toLowerCase();
}

function getCertPinsForHost(host: string, rules: Array<ProxyRule>): Set<string> {
  const pins = new Set<string>();
  for (const rule of rules) {
    if (!rule.pin?.length) continue;
    if (rule.domain.some((d) => domainMatches(d, host))) {
      for (const pin of rule.pin) pins.add(normalizeFingerprint(pin));
    }
  }
  return pins;
}

/**
 * Invariant #1 (+ #4): bind secret injection to the *verified upstream TLS
 * identity*, not the requested name. Returns TLS options for the secret-bearing
 * upstream request that (a) require validation against the public PKI
 * (`rejectUnauthorized`), (b) confirm the cert identity matches the host we
 * dialed (which is the rule-matched host), and (c) enforce any per-rule cert
 * pinning. On any mismatch the handshake fails, so the already-substituted
 * request is never transmitted — a poisoned DNS/Host name causes a failed
 * connection, never a leaked secret.
 */
function buildVerifiedUpstreamOptions(host: string, rules: Array<ProxyRule>): {
  rejectUnauthorized: true;
  checkServerIdentity: (servername: string, cert: tls.PeerCertificate) => Error | undefined;
} {
  const pins = getCertPinsForHost(host, rules);
  // Deliberately do NOT set `servername` — Node derives it from the request
  // hostname (SNI for DNS names; omitted for IP literals, where setting it
  // throws) and still passes the host to checkServerIdentity, so identity is
  // verified against the host we dialed (= the rule-matched host) either way.
  return {
    rejectUnauthorized: true,
    checkServerIdentity: (servername, cert) => {
      const identityError = tls.checkServerIdentity(servername, cert);
      if (identityError) return identityError;
      if (pins.size) {
        const actual = normalizeFingerprint(String(cert.fingerprint256 ?? ''));
        if (!actual || !pins.has(actual)) {
          return new Error(`Upstream certificate for ${servername} did not match a pinned fingerprint`);
        }
      }
      return undefined;
    },
  };
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

/**
 * Which managed items' placeholders actually appear in this request — i.e. the
 * secrets that will really be injected. Used for the audit log so it records
 * what was injected (keys only), not merely what was in scope.
 */
function detectInjectedKeys(parts: Array<string>, hostItems: Array<ProxyManagedItem>): Array<string> {
  const keys: Array<string> = [];
  for (const item of hostItems) {
    if (!item.placeholder) continue;
    if (parts.some((part) => part.includes(item.placeholder))) keys.push(item.key);
  }
  return keys;
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

/** Returns the first managed item whose real value still appears in `text` (a leak), if any. */
function findRealLeak(text: string, managedItems: Array<ProxyManagedItem>): ProxyManagedItem | undefined {
  return managedItems.find((item) => item.realValue.length > 0 && text.includes(item.realValue));
}

/**
 * Length of the longest suffix of `text` that is a strict prefix of some real
 * value — i.e. a partial real value that might complete in the next chunk and
 * so must be held back. Returns 0 (emit everything) when the text doesn't end
 * mid-secret, which keeps streaming responsive instead of buffering a fixed
 * window every chunk.
 */
function pendingRealPrefixLen(text: string, managedItems: Array<ProxyManagedItem>): number {
  let best = 0;
  for (const item of managedItems) {
    const real = item.realValue;
    if (!real) continue;
    const maxK = Math.min(real.length - 1, text.length);
    for (let k = maxK; k > best; k -= 1) {
      if (text.endsWith(real.slice(0, k))) {
        best = k;
        break;
      }
    }
  }
  return best;
}

/**
 * Scrub real values back to placeholders on an *unbounded text stream* (e.g.
 * SSE), chunk by chunk, so a reflected secret in a streamed response is still
 * replaced for the child without buffering the whole stream. A StringDecoder
 * keeps multi-byte UTF-8 chars intact across chunks; only a trailing *partial*
 * real value is held back, so complete chunks flow through immediately.
 */
function createScrubbingTransform(managedItems: Array<ProxyManagedItem>): Transform {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  return new Transform({
    transform(chunk, _enc, cb) {
      const scrubbed = replaceRealWithPlaceholders(carry + decoder.write(chunk as Buffer), managedItems);
      const hold = pendingRealPrefixLen(scrubbed, managedItems);
      const emitLen = scrubbed.length - hold;
      carry = scrubbed.slice(emitLen);
      cb(null, Buffer.from(scrubbed.slice(0, emitLen), 'utf8'));
    },
    flush(cb) {
      cb(null, Buffer.from(replaceRealWithPlaceholders(carry + decoder.end(), managedItems), 'utf8'));
    },
  });
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
    // Scrub unbounded uncompressed text streams (e.g. SSE) chunk-by-chunk so a
    // reflected secret is still replaced. Bodies with a content-length take the
    // buffered path below; compressed/binary bodies can't be scanned without
    // decompressing and pass through unchanged.
    const hasContentLength = getHeaderValue(upstreamRes.headers, 'content-length') !== undefined;
    const canScrubStream = shouldRedact
      && managedItems.length > 0
      && !hasContentLength
      && isUncompressedResponse(upstreamRes.headers)
      && isTextLikeResponse(upstreamRes.headers);

    clientRes.writeHead(statusCode, outgoingHeaders);
    if (canScrubStream) {
      upstreamRes.pipe(createScrubbingTransform(managedItems)).pipe(clientRes);
    } else {
      upstreamRes.pipe(clientRes);
    }
    return;
  }

  const chunks: Array<Buffer> = [];
  upstreamRes.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  upstreamRes.on('end', () => {
    const originalBody = Buffer.concat(chunks).toString('utf8');
    const redactedBody = replaceRealWithPlaceholders(originalBody, managedItems);

    // Fail-safe (Invariant #6): if a real value somehow survived scrubbing, do
    // NOT forward it — fail closed rather than leak a secret to the child.
    if (findRealLeak(redactedBody, managedItems)) {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'content-type': 'text/plain', connection: 'close' });
      }
      clientRes.end('Response withheld: a sensitive value could not be redacted');
      clientRes.socket?.destroy();
      return;
    }

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

    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const pathOnly = rawUrl.split('?')[0] ?? '/';
    const baseActivity = {
      host: hostInfo.host, method, path: pathOnly, url: rawUrl,
    };

    const shouldRewrite = hostMatchesProxyRules(hostInfo.host, rules);
    const shouldAllowEgress = egressMode === 'permissive' || shouldRewrite;
    if (!shouldAllowEgress) {
      onActivity?.({
        ...baseActivity, matched: shouldRewrite, blocked: true, decision: 'blocked-egress',
      });
      res.statusCode = 403;
      res.end('Proxy egress blocked by strict mode');
      return;
    }
    // Per-call policy (Invariant: static authorization). Evaluate host + method
    // + path against the rules; a matching `block` rule denies the request.
    const facts: RequestFacts = { host: hostInfo.host, method, path: pathOnly };
    const policyDecision = shouldRewrite ? evaluateProxyPolicy(facts, rules) : undefined;
    const ruleId = policyDecision?.matchedRule ? { ruleId: describeRule(policyDecision.matchedRule) } : {};
    if (policyDecision?.verdict === 'deny') {
      onActivity?.({
        ...baseActivity, ...ruleId, matched: true, blocked: true, decision: 'deny',
      });
      // Fail closed: the request is denied and never reaches upstream. Best-effort
      // 403, then tear down (short MITM-tunnel responses don't reliably flush).
      try {
        res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
        res.end('Blocked by proxy policy');
      } catch { /* response may already be gone */ }
      res.socket?.destroy();
      return;
    }

    const hostItems = shouldRewrite ? getRequestScopedManagedItems(facts, rules, managedItems) : [];
    const body = await readBody(req);
    const injectedKeys = shouldRewrite
      ? detectInjectedKeys([rawUrl, JSON.stringify(req.headers), body.toString('utf8')], hostItems)
      : [];
    onActivity?.({
      ...baseActivity,
      ...ruleId,
      matched: shouldRewrite,
      blocked: false,
      decision: 'allow',
      ...(injectedKeys.length ? { injectedKeys } : {}),
    });

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
      ? buildPathnameAndQuery(rawUrl, hostItems)
      : rawUrl;

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
      ...buildVerifiedUpstreamOptions(hostInfo.host, rules),
    }, (upstreamRes) => {
      forwardUpstreamResponseWithRedaction(
        upstreamRes,
        res,
        hostItems,
        shouldRewrite,
      );
    });

    upstreamReq.on('error', () => {
      // Fail closed: the upstream identity could not be verified (or the
      // connection failed), so the secret was never transmitted. Tear the
      // client connection down rather than risk a half-delivered response.
      if (!res.headersSent) {
        try {
          res.writeHead(502, { 'content-type': 'text/plain', connection: 'close' });
          res.end('Upstream MITM request failed');
        } catch { /* response may already be gone */ }
      }
      res.socket?.destroy();
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

    const method = clientReq.method ?? 'GET';
    const pathOnly = destination.pathname;
    const url = `${destination.pathname}${destination.search}`;
    const baseActivity = {
      host: destination.hostname, method, path: pathOnly, url,
    };

    const shouldRewrite = hostMatchesProxyRules(destination.hostname, rules);
    const shouldAllowEgress = egressMode === 'permissive' || shouldRewrite;
    if (!shouldAllowEgress) {
      onActivity?.({
        ...baseActivity, matched: shouldRewrite, blocked: true, decision: 'blocked-egress',
      });
      clientRes.statusCode = 403;
      clientRes.end('Proxy egress blocked by strict mode');
      return;
    }
    const facts: RequestFacts = { host: destination.hostname, method, path: pathOnly };
    const policyDecision = shouldRewrite ? evaluateProxyPolicy(facts, rules) : undefined;
    const ruleId = policyDecision?.matchedRule ? { ruleId: describeRule(policyDecision.matchedRule) } : {};
    if (policyDecision?.verdict === 'deny') {
      onActivity?.({
        ...baseActivity, ...ruleId, matched: true, blocked: true, decision: 'deny',
      });
      clientRes.statusCode = 403;
      clientRes.end('Blocked by proxy policy');
      return;
    }

    const isHttps = destination.protocol === 'https:';
    const hostItems = shouldRewrite ? getRequestScopedManagedItems(facts, rules, managedItems) : [];

    // Invariant #2/#5: never inject a secret into a cleartext (non-TLS)
    // connection — no cert means no verifiable identity. Fail closed.
    if (hostItems.length > 0 && !isHttps) {
      onActivity?.({
        ...baseActivity, ...ruleId, matched: true, blocked: true, decision: 'blocked-cleartext',
      });
      clientRes.statusCode = 403;
      clientRes.end('Refusing to inject secrets into a cleartext (non-TLS) connection');
      return;
    }

    const body = await readBody(clientReq);
    const injectedKeys = shouldRewrite
      ? detectInjectedKeys([url, JSON.stringify(clientReq.headers), body.toString('utf8')], hostItems)
      : [];
    onActivity?.({
      ...baseActivity,
      ...ruleId,
      matched: shouldRewrite,
      blocked: false,
      decision: 'allow',
      ...(injectedKeys.length ? { injectedKeys } : {}),
    });

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
      ...(isHttps ? buildVerifiedUpstreamOptions(destination.hostname, rules) : {}),
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
      // CONNECT only exposes host:port; the per-request audit entry (method/path)
      // comes later from the MITM handler for allowed hosts. Here we record the
      // host-level egress denial.
      onActivity?.({
        host: hostInfo.host,
        method: 'CONNECT',
        path: '/',
        matched: shouldRewrite,
        blocked: true,
        decision: 'blocked-egress',
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
