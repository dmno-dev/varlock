import { timingSafeEqual } from 'node:crypto';
import {
  mkdir, mkdtemp, rm, writeFile,
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

import {
  createApprovalRequest, isApprovalValid, type ApprovalProvider,
} from './approval';
import type { ProxyActivity } from './audit';
import { createEphemeralCa, createHostCert } from './cert-authority';
import {
  describeRule, domainMatches, evaluateProxyPolicy, getRequestScopedManagedItems, normalizeHost, type RequestFacts,
} from './policy';
import {
  PROXY_TOKEN_HEADER, SESSION_ENV_ENDPOINT_PATH, VARLOCK_INTERNAL_HOST,
} from './session-env-payload';
import { attachTunnelServer, type TunnelBootstrap } from './tunnel';
import type {
  ProxyApprovalEach, ProxyEgressMode, ProxyManagedItem, ProxyRule,
} from './types';

const LOCALHOST = '127.0.0.1';

export type ProxyReconfigureInput = {
  managedItems: Array<ProxyManagedItem>;
  rules: Array<ProxyRule>;
  egressMode: ProxyEgressMode;
};

export type ProxyRuntimeContext = {
  env: NodeJS.ProcessEnv;
  /**
   * Hot-swap the policy a running proxy enforces (rules, managed items, egress
   * mode) without restarting — used by `proxy reload` to apply schema edits to
   * a live daemon. Takes effect on the next request; in-flight requests keep the
   * snapshot they already resolved. The proxy address and CA are unchanged.
   */
  reconfigure: (next: ProxyReconfigureInput) => void;
  /**
   * Set/replace the encoded session-env payload the `varlock.internal` endpoint
   * serves (see `internalEndpoint`). Called once after startup and again on
   * every reload so attach fetches are always current.
   */
  setSessionEnvPayloadJson: (payloadJson: string, meta?: SessionEnvPayloadMeta) => void;
  stop: () => Promise<void>;
};

/** Reported after an upstream response is forwarded — surfaces response-side scrubbing. */
export type ProxyResponseInfo = {
  host: string;
  method: string;
  path: string;
  statusCode: number;
  /** Managed item keys (names) whose real value appeared in the response and was scrubbed back to a placeholder. */
  scrubbedKeys: Array<string>;
  /** True for an unbounded/streamed body (scrubbed chunk-by-chunk). */
  streamed?: boolean;
};

export type StartLocalProxyRuntimeInput = {
  managedItems: Array<ProxyManagedItem>;
  rules: Array<ProxyRule>;
  egressMode: ProxyEgressMode;
  onActivity?: (activity: ProxyActivity) => void;
  /** Called after an upstream response is forwarded, with any keys scrubbed from it. */
  onResponse?: (info: ProxyResponseInfo) => void;
  /**
   * Called when a request matches a `require-approval` rule. Must fail closed
   * (deny on timeout/error). Absent ⇒ require-approval requests are denied.
   */
  approvalProvider?: ApprovalProvider;
  /**
   * Enables the `varlock.internal` internal endpoint, which serves the current
   * session-env payload (child-view env + graph; never wire real values) so an
   * attaching `proxy run` can adopt this session's env without resolving
   * anything itself. Requests to the internal host are answered by the proxy,
   * never forwarded upstream, and not reported as egress activity. The token is
   * a dedicated endpoint credential stored in the 0600 session record (never
   * displayed anywhere), so this gates at same-uid — the same trust level as
   * the record itself, not a hard boundary. Loopback peers only, asserted even
   * though the listener is loopback-bound, so a future non-loopback data-plane
   * bind (sandbox bridging) can't silently expose the control plane.
   */
  internalEndpoint?: {
    token: string;
    /** A request presented a missing/invalid token (or came from a non-loopback peer) — surface to the owner. */
    onAuthFailure?: () => void;
    /** The session env payload was served; meta comes from the matching setSessionEnvPayloadJson call. */
    onServed?: (meta?: SessionEnvPayloadMeta) => void;
  };
  /**
   * Fixed loopback port for the proxy listener (the HTTP(S)_PROXY port a caller
   * wires tools to). Omitted ⇒ an ephemeral port. A busy fixed port fails to start
   * with a clear error rather than silently falling back.
   */
  port?: number;
  /**
   * Directory to write the CA cert into (`ca-cert.pem` + `combined-ca.pem`),
   * instead of a fresh temp dir — so a caller can point tools at a known CA path
   * before the proxy starts. Created if missing. On stop, only the cert files we
   * wrote are removed (an ephemeral temp dir is removed whole).
   */
  certDir?: string;
  /**
   * Address the proxy listener binds. Defaults to loopback (`127.0.0.1`). Binding
   * a non-loopback address (e.g. `0.0.0.0`, to reach the proxy from a remote
   * sandbox) exposes the data plane off-host, so it REQUIRES `dataPlaneToken` —
   * the runtime throws otherwise. The control endpoint stays loopback-only
   * regardless of this.
   */
  listenHost?: string;
  /**
   * Per-session data-plane credential. When set, a non-loopback peer must present
   * it as `Proxy-Authorization: Basic base64(varlock:<token>)`; loopback peers are
   * exempt (same-uid trust, unchanged). Distinct from the control-endpoint token.
   */
  dataPlaneToken?: string;
};

/** Command-side metadata attached to the served payload (for owner-terminal visibility). */
export type SessionEnvPayloadMeta = {
  /** Count of sensitive items served with their REAL value (@proxy=passthrough). */
  passthroughCount?: number;
};

type HostInfo = { host: string, port: number };

type HeaderTransformFn = (value: string) => string;

function parseHostPort(value: string): HostInfo | null {
  // Parse via URL so bracketed IPv6 literals (`[::1]:443`) are handled — a plain
  // `split(':')` mangles them. The hostname comes back bracketed for IPv6; strip
  // the brackets so the bare address flows to tls.connect / checkServerIdentity /
  // the IP-SAN cert minting (all of which expect `::1`, not `[::1]`).
  try {
    const url = new URL(`http://${value}`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host) return null;
    const port = url.port ? Number(url.port) : 443;
    if (Number.isNaN(port)) return null;
    return { host, port };
  } catch {
    return null;
  }
}

function hostMatchesProxyRules(host: string, rules: Array<ProxyRule>): boolean {
  return rules.some((rule) => rule.domain.some((d) => domainMatches(d, host)));
}

/**
 * Invariant #1: bind secret injection to the *verified upstream TLS identity*,
 * not the requested name. Opens a TLS connection to the rule-matched host, proves
 * the chain validates against the public PKI AND the cert identity matches that
 * host, and returns the **verified peer IP**. The secret-bearing request is then
 * pinned to that exact IP (see processProxiedRequest).
 *
 * Why not just rely on `https.request`'s own pre-write identity check? Some
 * runtimes — notably Bun's `https.request`, which the compiled CLI binary runs on
 * — flush the request (the `Authorization` header and body) to a wrong-identity
 * upstream *before* `checkServerIdentity` rejects, leaking the secret. So we
 * verify here, on a connection we control, and then pin the request to the proven
 * IP. A poisoned DNS/Host name fails this verification (we abort, secret never
 * sent); pinning the IP for the real request defeats a DNS-rebind between the two
 * connections — the secret only ever reaches an address already proven to hold a
 * valid cert for the rule host.
 */
function verifyUpstreamIdentity(host: string, port: number): Promise<{ address: string }> {
  return new Promise((resolve, reject) => {
    // SNI for DNS names; omitted for IP literals (setting `servername` to an IP
    // throws). Identity is verified against `host` either way below.
    const servername = net.isIP(host) ? undefined : host;
    const socket = tls.connect({
      host,
      port,
      ...(servername ? { servername } : {}),
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
      // Default trust store (system roots + NODE_EXTRA_CA_CERTS), but also honor
      // any process-global CAs the user configured on the https agent (e.g. a
      // corporate root) so we trust the same upstreams the rest of their stack
      // does. Undefined in the common case → default roots.
      ca: https.globalAgent.options.ca,
    });
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      socket.removeListener('error', fail);
      // (a) public-PKI chain must validate
      if (!socket.authorized) {
        fail(socket.authorizationError ?? new Error('upstream TLS chain not authorized'));
        return;
      }
      // (b) cert identity must match the host we dialed (= the rule-matched host).
      // checkServerIdentity handles both DNS names (dNSName SANs) and IP literals
      // (iPAddress SANs) when given the host.
      const identityError = tls.checkServerIdentity(host, socket.getPeerCertificate());
      if (identityError) {
        fail(identityError);
        return;
      }
      const address = socket.remoteAddress;
      socket.destroy();
      if (!address) {
        reject(new Error('verified upstream has no remote address'));
        return;
      }
      resolve({ address });
    });
  });
}

/**
 * Run the request-bound approval gate (Invariant #8). Builds an ApprovalRequest
 * committed to this exact request, asks the provider, and returns whether the
 * decision actually authorizes it. Fails closed: no provider, a throwing
 * provider, a nonce mismatch, or an expired/denied decision all return false.
 */
async function runApprovalGate(input: {
  approvalProvider: ApprovalProvider | undefined;
  method: string;
  host: string;
  path: string;
  body: Buffer;
  ruleId?: string;
  each?: ProxyApprovalEach;
  maxDurationMs?: number;
  injectedKeys: Array<string>;
}): Promise<boolean> {
  if (!input.approvalProvider) return false;
  const request = createApprovalRequest({
    method: input.method,
    host: input.host,
    path: input.path,
    body: input.body,
    ruleId: input.ruleId,
    each: input.each,
    maxDurationMs: input.maxDurationMs,
    injectedKeys: input.injectedKeys,
  });
  try {
    const decision = await input.approvalProvider.requestApproval(request);
    return isApprovalValid(request, decision);
  } catch {
    return false;
  }
}

export function replacePlaceholdersWithReal(value: string, managedItems: Array<ProxyManagedItem>): string {
  let next = value;
  // Longest placeholder first, mirroring the scrub direction: if one placeholder
  // is a substring of another (e.g. `vlk_x` and `vlk_x_1`), replacing the shorter
  // one first would corrupt the longer one and splice in the wrong real value.
  const sortedByPlaceholderLength = [...managedItems]
    .filter((item) => !!item.placeholder)
    .sort((a, b) => b.placeholder.length - a.placeholder.length);
  for (const item of sortedByPlaceholderLength) {
    next = next.split(item.placeholder).join(item.realValue);
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

/**
 * Find a managed placeholder present in the outbound request that is NOT being
 * injected on this route (`injectHere`). Such a placeholder would reach the
 * upstream un-substituted and fail with a cryptic auth error, and the cause is
 * the proxy rules (wrong path/method, or wrong host) — so we catch it and
 * explain, rather than forwarding a doomed request. Placeholders are unique
 * per item, so a match is unambiguous (no false positives).
 */
export function findUninjectedPlaceholder(
  parts: Array<string>,
  managedItems: Array<ProxyManagedItem>,
  injectHere: Array<ProxyManagedItem>,
): ProxyManagedItem | undefined {
  const injectedKeys = new Set(injectHere.map((item) => item.key));
  return managedItems.find(
    (item) => item.placeholder.length > 0
      && !injectedKeys.has(item.key)
      && parts.some((part) => part.includes(item.placeholder)),
  );
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

/**
 * Fail-closed response for a blocked/failed request. When `teardown` is set (the
 * MITM tunnel path), short status-only responses don't reliably flush through the
 * CONNECT tunnel, so we write a best-effort response and destroy the socket. The
 * absolute-form (plain http) path ends the response normally.
 */
function respondBlocked(
  res: http.ServerResponse,
  code: number,
  message: string,
  teardown: boolean,
): void {
  if (!res.headersSent) {
    try {
      if (teardown) {
        res.writeHead(code, { 'content-type': 'text/plain', connection: 'close' });
      } else {
        res.statusCode = code;
      }
      res.end(message);
    } catch { /* response may already be gone */ }
  } else {
    try {
      res.end();
    } catch { /* ignore */ }
  }
  if (teardown) res.socket?.destroy();
}

/** Constant-time token comparison (length leak is fine; the token is a uuid, not a password). */
function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

/** True if a listen host binds only loopback (so remote peers can't reach it). */
function isLoopbackBind(host: string): boolean {
  return host === 'localhost' || isLoopbackAddress(host);
}

/** Extract the token from a `Proxy-Authorization: Basic base64(user:token)` header. */
export function parseProxyAuthToken(header: string | Array<string> | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return undefined;
  const spaceIdx = value.indexOf(' ');
  if (spaceIdx === -1) return undefined;
  const scheme = value.slice(0, spaceIdx);
  const encoded = value.slice(spaceIdx + 1).trim();
  if (scheme.toLowerCase() !== 'basic' || !encoded) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  const colon = decoded.indexOf(':');
  // Basic is `user:pass`; the token is the password half (username is cosmetic).
  return colon === -1 ? decoded : decoded.slice(colon + 1);
}

/**
 * Data-plane gate. Loopback peers are same-uid-trusted and always pass (the
 * historical model). A non-loopback peer — only reachable when the listener is
 * bound off-loopback — must present the session's `Proxy-Authorization` token.
 */
export function dataPlaneAuthOk(
  peerAddr: string | undefined,
  header: string | Array<string> | undefined,
  token: string | undefined,
): boolean {
  if (isLoopbackAddress(peerAddr)) return true;
  if (!token) return false; // non-loopback bind without a token: fail closed
  return tokenMatches(parseProxyAuthToken(header), token);
}

/** Transport-specific inputs for a proxied request, shared by the MITM-tunnel and
 * absolute-form (plain http) handlers so the policy/approval/injection/forwarding
 * logic lives in one place. */
type ProxiedRequestTransport = {
  host: string;
  port: number;
  isHttps: boolean;
  method: string;
  /** Path component for policy facts/activity (no query). */
  pathOnly: string;
  /** Origin-form path+query sent upstream (and scrubbed) — also used as the activity URL. */
  requestTarget: string;
  /** When set, override the upstream `Host` header (absolute-form). Undefined = pass the client's through (MITM). */
  upstreamHostHeader?: string;
  /** Deny/approval/error responses tear the socket down (MITM tunnel) rather than ending normally. */
  tunnelTeardown: boolean;
};

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

/** Item keys whose real value appears in `text` — i.e. the keys that get scrubbed back to placeholders. */
function detectScrubbedKeys(text: string, managedItems: Array<ProxyManagedItem>): Array<string> {
  const keys: Array<string> = [];
  for (const item of managedItems) {
    if (item.realValue.length > 0 && text.includes(item.realValue)) keys.push(item.key);
  }
  return keys;
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
function createScrubbingTransform(
  managedItems: Array<ProxyManagedItem>,
  matchedKeys?: Set<string>,
): Transform {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  const note = (text: string) => {
    if (matchedKeys) for (const key of detectScrubbedKeys(text, managedItems)) matchedKeys.add(key);
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      const decoded = carry + decoder.write(chunk as Buffer);
      note(decoded);
      const scrubbed = replaceRealWithPlaceholders(decoded, managedItems);
      const hold = pendingRealPrefixLen(scrubbed, managedItems);
      const emitLen = scrubbed.length - hold;
      carry = scrubbed.slice(emitLen);
      cb(null, Buffer.from(scrubbed.slice(0, emitLen), 'utf8'));
    },
    flush(cb) {
      const decoded = carry + decoder.end();
      note(decoded);
      cb(null, Buffer.from(replaceRealWithPlaceholders(decoded, managedItems), 'utf8'));
    },
  });
}

function forwardUpstreamResponseWithRedaction(
  upstreamRes: http.IncomingMessage,
  clientRes: http.ServerResponse,
  managedItems: Array<ProxyManagedItem>,
  shouldRedact: boolean,
  responseCtx?: { host: string; method: string; path: string; onResponse?: (info: ProxyResponseInfo) => void },
) {
  const statusCode = upstreamRes.statusCode ?? 502;
  const onResponse = responseCtx?.onResponse;
  const report = (scrubbedKeys: Iterable<string>, streamed: boolean) => {
    if (!onResponse || !responseCtx) return;
    onResponse({
      host: responseCtx.host,
      method: responseCtx.method,
      path: responseCtx.path,
      statusCode,
      scrubbedKeys: [...new Set(scrubbedKeys)],
      ...(streamed ? { streamed: true } : {}),
    });
  };
  // Detect keys reflected in the (original) response headers, scrubbed regardless of body path.
  const headerKeys = shouldRedact ? detectScrubbedKeys(JSON.stringify(upstreamRes.headers), managedItems) : [];
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
      const matched = new Set(headerKeys);
      const transform = createScrubbingTransform(managedItems, matched);
      transform.on('end', () => report(matched, true));
      upstreamRes.pipe(transform).pipe(clientRes);
    } else {
      // Passthrough (compressed/binary/unscanned body) — only header reflection is visible.
      report(headerKeys, false);
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
    const bodyKeys = detectScrubbedKeys(originalBody, managedItems);
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
    report([...headerKeys, ...bodyKeys], false);
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

/**
 * Local MITM proxy runtime for `varlock proxy run`.
 * Rewrites placeholder values to real values for requests matching @proxy domains.
 */
export async function startLocalProxyRuntime({
  managedItems: initialManagedItems,
  rules: initialRules,
  egressMode: initialEgressMode,
  onActivity,
  onResponse,
  approvalProvider,
  internalEndpoint,
  port,
  certDir,
  listenHost,
  dataPlaneToken,
}: StartLocalProxyRuntimeInput): Promise<ProxyRuntimeContext> {
  const bindHost = listenHost ?? LOCALHOST;
  if (!isLoopbackBind(bindHost) && !dataPlaneToken) {
    // Belt-and-suspenders: the command layer mints a token whenever it passes a
    // non-loopback listenHost. If we got here without one, refuse to expose an
    // unauthenticated proxy off-loopback rather than fail open.
    throw new Error('varlock proxy: a non-loopback listen address requires a data-plane token.');
  }
  // Mutable so `reconfigure` can hot-swap the enforced policy on a live proxy.
  // The request handlers below close over these bindings, so reassigning them
  // changes behavior on the next request (in-flight requests already snapshotted).
  let managedItems = initialManagedItems;
  let rules = initialRules;
  let egressMode = initialEgressMode;
  // Set via setSessionEnvPayloadJson right after startup (and on each reload).
  let sessionEnvPayloadJson: string | undefined;
  let sessionEnvPayloadMeta: SessionEnvPayloadMeta | undefined;
  // Only the public CA cert is written to disk (for child trust). Private keys
  // — the CA's and every per-host leaf's — stay in memory; see cert-authority.ts.
  // A caller-provided certDir gives tools a known CA path to wire up before start;
  // otherwise use a fresh temp dir. Track which so stop() cleans up appropriately.
  const certDirIsUserProvided = certDir !== undefined;
  const certsDir = certDir ?? await mkdtemp(path.join(os.tmpdir(), 'varlock-proxy-certs-'));
  if (certDirIsUserProvided) await mkdir(certsDir, { recursive: true });
  const ca = await createEphemeralCa();
  const caCertPath = path.join(certsDir, 'ca-cert.pem');
  const combinedCaPath = path.join(certsDir, 'combined-ca.pem');
  await writeFile(caCertPath, ca.certPem, 'utf8');
  await writeFile(combinedCaPath, `${ca.certPem}\n${tls.rootCertificates.join('\n')}\n`, 'utf8');

  // Internal control endpoint: requests to the magic internal host are answered
  // by the proxy itself (an attaching `proxy run` fetches the session env here).
  // Handled before any egress/rule evaluation, never forwarded upstream, and
  // deliberately not reported as egress activity (it is control plane, not
  // traffic). Fail order: token first (an unauthenticated caller learns nothing,
  // not even which paths exist), then path.
  const handleInternalRequest = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    t: ProxiedRequestTransport,
  ) => {
    // Loopback peers only. Redundant today (the listener binds 127.0.0.1) but
    // deliberate: a future non-loopback data-plane bind (sandbox bridging) must
    // not silently expose the control plane to a network segment.
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      internalEndpoint?.onAuthFailure?.();
      respondBlocked(res, 403, 'varlock proxy: internal endpoint is loopback-only', t.tunnelTeardown);
      return;
    }
    if (!internalEndpoint || !tokenMatches(req.headers[PROXY_TOKEN_HEADER], internalEndpoint.token)) {
      internalEndpoint?.onAuthFailure?.();
      respondBlocked(res, 403, 'varlock proxy: invalid or missing session token', t.tunnelTeardown);
      return;
    }
    if (t.method !== 'GET' || t.pathOnly !== SESSION_ENV_ENDPOINT_PATH) {
      respondBlocked(res, 404, 'varlock proxy: unknown internal endpoint', t.tunnelTeardown);
      return;
    }
    if (!sessionEnvPayloadJson) {
      respondBlocked(res, 503, 'varlock proxy: session env not ready yet', t.tunnelTeardown);
      return;
    }
    try {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(sessionEnvPayloadJson);
      internalEndpoint.onServed?.(sessionEnvPayloadMeta);
    } catch { /* client went away */ }
  };

  // Shared request pipeline for both transports (MITM tunnel + absolute-form http):
  // egress gate → per-call policy (block) → cleartext guard → approval gate →
  // scrub+inject → forward upstream (verified identity) → scrub response. Every
  // failure path fails closed via respondBlocked.
  const processProxiedRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    t: ProxiedRequestTransport,
  ) => {
    if (normalizeHost(t.host) === VARLOCK_INTERNAL_HOST) {
      handleInternalRequest(req, res, t);
      return;
    }

    const baseActivity = {
      host: t.host, method: t.method, path: t.pathOnly, url: t.requestTarget,
    };

    const shouldRewrite = hostMatchesProxyRules(t.host, rules);
    const shouldAllowEgress = egressMode === 'permissive' || shouldRewrite;
    if (!shouldAllowEgress) {
      onActivity?.({
        ...baseActivity, matched: shouldRewrite, blocked: true, decision: 'blocked-egress',
      });
      respondBlocked(res, 403, `Blocked by the varlock credential proxy: ${t.host} is not allowed by your egress policy (strict mode only permits hosts with a matching @proxy rule). Add a @proxy rule for this host, or use permissive egress, to allow it.`, false);
      return;
    }

    // Per-call policy (static authorization): evaluate host + method + path; a
    // matching `block` rule denies the request and it never reaches upstream.
    const facts: RequestFacts = { host: t.host, method: t.method, path: t.pathOnly };
    const policyDecision = shouldRewrite ? evaluateProxyPolicy(facts, rules, egressMode) : undefined;
    const ruleIdStr = policyDecision?.matchedRule ? describeRule(policyDecision.matchedRule) : undefined;
    const ruleId = ruleIdStr ? { ruleId: ruleIdStr } : {};
    if (policyDecision?.verdict === 'deny') {
      // Two deny kinds: an explicit `block` rule (denylist), or strict egress with
      // no allow rule matching this method/path on an otherwise-ruled host.
      const egressStrictDeny = policyDecision.denyKind === 'egress-strict';
      onActivity?.({
        ...baseActivity, ...ruleId, matched: true, blocked: true, decision: egressStrictDeny ? 'blocked-egress' : 'deny',
      });
      const message = egressStrictDeny
        ? `Blocked by the varlock credential proxy: no @proxy rule matches ${t.method} ${t.host}${t.pathOnly}. `
          + 'The host has a @proxy rule, but none matches this method and path, and egress is strict. '
          + 'Add a matching (or broader) @proxy rule, or use permissive egress.'
        : `Blocked by the varlock credential proxy: a @proxy block rule denies ${t.method} ${t.host}${t.pathOnly}.`;
      respondBlocked(res, 403, message, t.tunnelTeardown);
      return;
    }

    // Approval-gated keys (contributed only by `@proxy(approval)` rules) are
    // withheld unless the verdict actually routes through the approval gate below.
    // A plain-`allow` verdict from a more-specific rule must NOT smuggle a broader
    // approval rule's secret in without a prompt (see getRequestScopedManagedItems).
    const hostItems = shouldRewrite
      ? getRequestScopedManagedItems(facts, rules, managedItems, {
        includeApprovalGatedKeys: policyDecision?.verdict === 'require-approval',
      })
      : [];

    // Invariant #2/#5: never inject a secret into a cleartext (non-TLS) connection —
    // no cert means no verifiable identity. Fail closed. (MITM is always https, so
    // this only fires on the absolute-form http path.)
    if (hostItems.length > 0 && !t.isHttps) {
      onActivity?.({
        ...baseActivity, ...ruleId, matched: true, blocked: true, decision: 'blocked-cleartext',
      });
      respondBlocked(res, 403, `Blocked by the varlock credential proxy: refusing to inject a secret into a cleartext (non-TLS) connection to ${t.host}.`, false);
      return;
    }

    const body = await readBody(req);
    const scanParts = [t.requestTarget, JSON.stringify(req.headers), body.toString('utf8')];
    const injectedKeys = shouldRewrite ? detectInjectedKeys(scanParts, hostItems) : [];

    // Helpful-failure guard: when NO rule injects anything on this route yet the
    // request carries a managed placeholder, the real value won't be substituted
    // and the upstream would reject it with a cryptic auth error — and the cause
    // is the proxy rules (wrong path/method, or wrong host). Explain it instead of
    // forwarding a doomed request. Scoped to `hostItems.length === 0` so a request
    // that DOES inject on this route can still carry an unrelated placeholder
    // (e.g. another item's, bound for a different host) through untouched.
    const leaked = hostItems.length === 0
      ? findUninjectedPlaceholder(scanParts, managedItems, hostItems)
      : undefined;
    if (leaked) {
      onActivity?.({
        ...baseActivity, ...ruleId, matched: shouldRewrite, blocked: true, decision: 'blocked-uninjected',
      });
      respondBlocked(res, 403, `Blocked by the varlock credential proxy: this request to ${t.host}${t.pathOnly} carries the placeholder for ${leaked.key}, `
        + 'but no @proxy rule injects it here — the real value was not substituted and the request would fail upstream. '
        + 'Add or broaden a @proxy rule so it matches this request (host + path + method).', t.tunnelTeardown);
      return;
    }

    // Invariant #8: a require-approval rule holds the request for an out-of-band,
    // request-bound decision. Fail closed (deny) unless explicitly approved.
    if (policyDecision?.verdict === 'require-approval') {
      const approved = await runApprovalGate({
        approvalProvider,
        method: t.method,
        host: t.host,
        path: t.pathOnly,
        body,
        ruleId: ruleIdStr,
        each: policyDecision.matchedRule?.approval?.each,
        maxDurationMs: policyDecision.matchedRule?.approval?.maxDurationMs,
        injectedKeys,
      });
      if (!approved) {
        onActivity?.({
          ...baseActivity, ...ruleId, matched: true, blocked: true, decision: 'approval-denied',
        });
        respondBlocked(res, 403, `Blocked by the varlock credential proxy: this request to ${t.host} required approval and it was not granted.`, t.tunnelTeardown);
        return;
      }
    }

    onActivity?.({
      ...baseActivity,
      ...ruleId,
      matched: shouldRewrite,
      blocked: false,
      decision: policyDecision?.verdict === 'require-approval' ? 'approval-granted' : 'allow',
      ...(injectedKeys.length ? { injectedKeys } : {}),
    });

    const rewrittenBody = shouldRewrite
      ? Buffer.from(replacePlaceholdersWithReal(body.toString('utf8'), hostItems), 'utf8')
      : body;
    const rewrittenPath = shouldRewrite
      ? replacePlaceholdersWithReal(t.requestTarget, hostItems)
      : t.requestTarget;

    const upstreamHeaders = transformHeaders(
      req.headers,
      shouldRewrite
        ? (value) => replacePlaceholdersWithReal(value, hostItems)
        : (value) => value,
    );
    delete upstreamHeaders['proxy-connection'];
    delete upstreamHeaders.connection;
    if (t.upstreamHostHeader !== undefined) upstreamHeaders.host = t.upstreamHostHeader;
    if (rewrittenBody.byteLength !== body.byteLength) {
      upstreamHeaders['content-length'] = String(rewrittenBody.byteLength);
    }

    const upstreamPort = t.port || (t.isHttps ? 443 : 80);

    // Invariant #1: for TLS upstreams, verify the identity on a connection we
    // control BEFORE writing any secret, then pin the request to the proven IP.
    // We can't reuse the verified socket directly (Bun's https client won't accept
    // a handed-in socket), so we pin by IP — the secret only ever reaches an
    // address already proven to hold a valid cert for the rule host, defeating
    // DNS-poison/rebind. Cleartext (http) upstreams never carry an injected secret
    // — the cleartext guard above fails closed when hostItems.length > 0 && !isHttps.
    let verifiedAddress: string | undefined;
    if (t.isHttps) {
      try {
        ({ address: verifiedAddress } = await verifyUpstreamIdentity(t.host, upstreamPort));
      } catch {
        // Fail closed: the upstream identity could not be verified, so the secret
        // was never transmitted.
        respondBlocked(res, 502, 'Upstream request failed', t.tunnelTeardown);
        return;
      }
    }

    // For DNS-name hosts, send SNI for (and re-check identity against) the rule
    // host even though we dial the pinned IP. For IP-literal hosts there is no SNI.
    const sni = t.isHttps && !net.isIP(t.host) ? t.host : undefined;
    const agent = t.isHttps ? https : http;
    const upstreamReq = agent.request({
      protocol: t.isHttps ? 'https:' : 'http:',
      // Pin to the verified peer IP (https) so the request can't be re-resolved to
      // a different host between verification and send.
      hostname: verifiedAddress ?? t.host,
      port: upstreamPort,
      method: req.method,
      path: rewrittenPath,
      headers: upstreamHeaders,
      ...(t.isHttps
        ? {
          ...(sni ? { servername: sni } : {}),
          rejectUnauthorized: true,
          // Defense-in-depth: re-check the cert identity against the rule host
          // (not the pinned IP we dialed). Redundant given the pinned-IP proof,
          // but cheap. (Some runtimes ignore this; the pinned-IP proof is the
          // real guarantee — see verifyUpstreamIdentity.)
          checkServerIdentity: (_sni: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(t.host, cert),
          ca: https.globalAgent.options.ca,
        }
        : {}),
    }, (upstreamRes) => {
      forwardUpstreamResponseWithRedaction(upstreamRes, res, hostItems, shouldRewrite, {
        host: t.host,
        method: t.method,
        path: t.pathOnly,
        onResponse,
      });
    });

    upstreamReq.on('error', () => {
      // Fail closed: the upstream identity could not be verified (or the connection
      // failed), so the secret was never transmitted.
      respondBlocked(res, 502, 'Upstream request failed', t.tunnelTeardown);
    });
    upstreamReq.end(rewrittenBody);
  };

  const handleInterceptRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const hostHeader = req.headers.host ?? '';
    const hostInfo = parseHostPort(hostHeader.includes(':') ? hostHeader : `${hostHeader}:443`);
    if (!hostInfo) {
      res.statusCode = 400;
      res.end('Invalid host');
      return;
    }
    const rawUrl = req.url ?? '/';
    await processProxiedRequest(req, res, {
      host: hostInfo.host,
      port: hostInfo.port || 443,
      isHttps: true, // the MITM tunnel is always TLS
      method: req.method ?? 'GET',
      pathOnly: rawUrl.split('?')[0] ?? '/',
      requestTarget: rawUrl,
      upstreamHostHeader: undefined, // pass the client's Host through
      tunnelTeardown: true,
    });
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
    if (!dataPlaneAuthOk(clientReq.socket.remoteAddress, clientReq.headers['proxy-authorization'], dataPlaneToken)) {
      clientRes.statusCode = 407;
      clientRes.setHeader('Proxy-Authenticate', 'Basic realm="varlock"');
      clientRes.end('Proxy authentication required');
      return;
    }

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

    const isHttps = destination.protocol === 'https:';
    const defaultPort = isHttps ? 443 : 80;
    await processProxiedRequest(clientReq, clientRes, {
      host: destination.hostname,
      port: destination.port ? Number(destination.port) : defaultPort,
      isHttps,
      method: clientReq.method ?? 'GET',
      pathOnly: destination.pathname,
      requestTarget: `${destination.pathname}${destination.search}`,
      upstreamHostHeader: destination.host, // absolute-form: client Host may be the proxy
      tunnelTeardown: false,
    });
  });

  proxyServer.on('connect', async (req, clientSocket, head) => {
    const hostInfo = parseHostPort(req.url ?? '');
    if (!hostInfo) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // A CONNECT tunnel to the internal host reaches handleInternalRequest via a
    // local MITM pipe, where the original peer address is no longer visible — so
    // the loopback-only assertion for the control plane must happen here.
    // clientSocket is typed as Duplex but is a net.Socket at runtime
    const connectPeer = (clientSocket as net.Socket).remoteAddress;
    if (normalizeHost(hostInfo.host) === VARLOCK_INTERNAL_HOST && !isLoopbackAddress(connectPeer)) {
      internalEndpoint?.onAuthFailure?.();
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // Data-plane auth for CONNECT: loopback is exempt, a non-loopback peer must
    // present the session token. Checked after the varlock.internal loopback gate
    // (which already rejected non-loopback control-plane attempts).
    if (!dataPlaneAuthOk(connectPeer, req.headers['proxy-authorization'], dataPlaneToken)) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="varlock"\r\nConnection: close\r\n\r\n');
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
      const blockedBody = `Blocked by the varlock credential proxy: ${hostInfo.host} is not allowed by your egress policy (strict mode only permits hosts with a matching @proxy rule). Add a @proxy rule for this host, or use permissive egress, to allow it.`;
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
    const onListenError = (err: NodeJS.ErrnoException) => {
      if (port !== undefined && err.code === 'EADDRINUSE') {
        reject(new Error(`varlock proxy: port ${port} is already in use. Choose a different --port or free it.`));
      } else {
        reject(err);
      }
    };
    proxyServer.once('error', onListenError);
    proxyServer.listen(port ?? 0, bindHost, () => {
      proxyServer.off('error', onListenError);
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

  // With a data-plane token (off-loopback bind), also serve the CONNECT-over-WS
  // tunnel on this same listener so a remote sandbox can reach the proxy through
  // provider HTTP ingress. The bootstrap hands the guest its child-view values
  // and the CA certs; each `connect` stream is bridged to this proxy's loopback
  // port (where it's exempt from the token check — the WS handshake already
  // authenticated it). The combined bundle mirrors what's written to disk.
  const combinedCaPem = `${ca.certPem}\n${tls.rootCertificates.join('\n')}\n`;
  const buildTunnelBootstrap = (): TunnelBootstrap => ({
    // The same encoded child-view payload the control endpoint serves, so a
    // remote guest adopts exactly what a local attach would (incl. the graph for
    // redaction). Empty-but-valid until the first setSessionEnvPayloadJson.
    payloadJson: sessionEnvPayloadJson ?? '{"env":{},"omittedKeys":[],"serializedGraph":{"config":{}}}',
    certs: { 'ca-cert.pem': ca.certPem, 'combined-ca.pem': combinedCaPem },
  });
  const tunnel = dataPlaneToken
    ? attachTunnelServer(proxyServer, {
      token: dataPlaneToken,
      proxyPort: address.port,
      buildBootstrap: buildTunnelBootstrap,
      onAuthFailure: () => internalEndpoint?.onAuthFailure?.(),
    })
    : undefined;

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
    setSessionEnvPayloadJson: (payloadJson, meta) => {
      sessionEnvPayloadJson = payloadJson;
      sessionEnvPayloadMeta = meta;
    },
    reconfigure: (next) => {
      managedItems = next.managedItems;
      rules = next.rules;
      egressMode = next.egressMode;
    },
    stop: async () => {
      // Detach the tunnel WS server first so it stops accepting upgrades.
      tunnel?.close();
      // `server.close()` only calls back once every connection has drained, and
      // an idle keep-alive socket never closes on its own — so without forcing
      // connections closed, stop() (and the daemon's SIGTERM cleanup) hangs
      // forever. Destroy live sockets first so close() resolves promptly.
      proxyServer.closeAllConnections?.();
      for (const { server } of hostMitmServers.values()) server.closeAllConnections?.();
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
      // A temp dir we created is removed wholesale; for a caller-provided dir,
      // remove only the cert files we wrote so we don't delete a dir the user owns.
      if (certDirIsUserProvided) {
        await rm(caCertPath, { force: true });
        await rm(combinedCaPath, { force: true });
      } else {
        await rm(certsDir, { recursive: true, force: true });
      }
    },
  };
}
