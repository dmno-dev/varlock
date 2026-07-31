import {
  mkdir, mkdtemp, readFile, rm, writeFile,
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
  dataPlaneAuthOk, isLoopbackAddress, isLoopbackBind, tokenMatches,
} from '@varlock/proxy-core/auth';
import {
  getHeaderValue, isTextLikeResponse, isUncompressedResponse,
  redactOutgoingHeaders, shouldRedactResponseBody, transformHeaders,
} from '@varlock/proxy-core/headers';
import {
  evaluateProxiedRequestPreBody, evaluateProxiedRequestWithBody, hostMatchesProxyRules,
  type ApprovalGateFn, type ProxiedRequestFacts, type ProxyPolicyState,
} from '@varlock/proxy-core/pipeline';
import { normalizeHost } from '@varlock/proxy-core/policy';
import {
  detectScrubbedKeys, findRealLeak, StreamingScrubber,
} from '@varlock/proxy-core/scrub';
import { replaceRealWithPlaceholders } from '@varlock/proxy-core/substitution';
import type {
  ProxyEgressMode, ProxyManagedItem, ProxyRule,
} from '@varlock/proxy-core/types';

import {
  createApprovalRequest, isApprovalValid, type ApprovalProvider,
} from './approval';
import type { ProxyActivity } from './audit';
import {
  createEphemeralCa, createHostCert, exportCaPrivateKeyPem, loadCa,
} from './cert-authority';
import {
  PROXY_TOKEN_HEADER, SESSION_ENV_ENDPOINT_PATH, VARLOCK_INTERNAL_HOST,
} from './session-env-payload';
import { attachTunnelServer, type TunnelBootstrap } from './tunnel';

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
   * Keep the CA (cert **and private key**) in `certDir` and reuse it on the next
   * start, so a restart doesn't invalidate clients that already trust this CA.
   * For long-lived brokers; requires `certDir`. Off by default: the key normally
   * never touches disk.
   */
  persistCa?: boolean;
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

/**
 * Scrub real values back to placeholders on an *unbounded text stream* (e.g.
 * SSE), chunk by chunk, so a reflected secret in a streamed response is still
 * replaced for the child without buffering the whole stream. A StringDecoder
 * keeps multi-byte UTF-8 chars intact across chunks; the hold-back of trailing
 * partial real values lives in the shared StreamingScrubber.
 */
function createScrubbingTransform(
  managedItems: Array<ProxyManagedItem>,
  matchedKeys?: Set<string>,
): Transform {
  const decoder = new StringDecoder('utf8');
  const scrubber = new StreamingScrubber(
    managedItems,
    matchedKeys ? (key) => matchedKeys.add(key) : undefined,
  );
  return new Transform({
    transform(chunk, _enc, cb) {
      cb(null, Buffer.from(scrubber.push(decoder.write(chunk as Buffer)), 'utf8'));
    },
    flush(cb) {
      cb(null, Buffer.from(scrubber.flush(decoder.end()), 'utf8'));
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
 * How long a persisted CA is valid. Effectively indefinite (10 years, the same
 * convention as mkcert/Caddy local roots): any expiry is a scheduled outage for
 * agents still running when it hits, which is exactly what persisting the CA is
 * meant to prevent, and it buys no security here. Nothing checks revocation for
 * this CA, and it is only ever trusted by clients that fetched it from this
 * broker over an authenticated tunnel, so a leaked key is answered by deleting
 * the file and restarting, not by waiting. The short-lived material that does
 * matter is the per-host leaf certs.
 *
 * Not literally "no expiry" (RFC 5280's 9999-12-31): a year past 2049 has to be
 * encoded as GeneralizedTime, a far less trodden path through TLS verifiers, and
 * a bounded life means a forgotten cert directory does not stay valid forever.
 */
const PERSISTED_CA_VALIDITY_DAYS = 3650;
/** Rotate a persisted CA this far ahead of expiry, so it can't lapse mid-session. */
const PERSISTED_CA_ROTATE_BEFORE_MS = 24 * 60 * 60 * 1000;

/**
 * Reuse the CA in `certDir` if it's still valid, else mint one and persist it.
 * Reusing keeps clients that already trust this CA working across a restart —
 * what a long-lived broker needs, and why the private key is written (0600)
 * rather than kept in memory. An unreadable/corrupt/expiring pair is replaced
 * rather than fatal: a broker should still come up.
 */
async function loadOrCreatePersistedCa(caCertPath: string, caKeyPath: string) {
  try {
    const [certPem, keyPem] = await Promise.all([
      readFile(caCertPath, 'utf8'),
      readFile(caKeyPath, 'utf8'),
    ]);
    const existing = await loadCa(certPem, keyPem);
    if (existing.notAfter.getTime() - Date.now() > PERSISTED_CA_ROTATE_BEFORE_MS) return existing;
  } catch { /* no usable CA on disk — mint one below */ }

  const ca = await createEphemeralCa(PERSISTED_CA_VALIDITY_DAYS);
  await writeFile(caKeyPath, await exportCaPrivateKeyPem(ca), { encoding: 'utf8', mode: 0o600 });
  return ca;
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
  persistCa,
  listenHost,
  dataPlaneToken,
}: StartLocalProxyRuntimeInput): Promise<ProxyRuntimeContext> {
  const bindHost = listenHost ?? LOCALHOST;
  if (!isLoopbackBind(bindHost) && !dataPlaneToken) {
    // Belt-and-suspenders: the command layer mints a token whenever it passes a
    // non-loopback listenHost. If we got here without one, refuse to expose an
    // unauthenticated proxy off-loopback rather than fail open.
    throw new Error('varlock proxy: serving the tunnel off-loopback requires a data-plane token.');
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
  const caCertPath = path.join(certsDir, 'ca-cert.pem');
  const combinedCaPath = path.join(certsDir, 'combined-ca.pem');
  const caKeyPath = path.join(certsDir, 'ca-key.pem');
  if (persistCa && !certDirIsUserProvided) {
    throw new Error('varlock proxy: persisting the CA requires a cert directory to keep it in.');
  }
  const ca = persistCa
    ? await loadOrCreatePersistedCa(caCertPath, caKeyPath)
    : await createEphemeralCa();
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

  // Shared request pipeline for both transports (MITM tunnel + absolute-form http).
  // The decision order — egress gate → per-call policy (block) → cleartext guard →
  // uninjected-placeholder guard → substitution guards → approval gate →
  // scrub+inject — lives in @varlock/proxy-core's two-phase pipeline; this
  // adapter buffers the body between phases, records activity, responds to
  // blocked outcomes (every failure path fails closed via respondBlocked), and
  // forwards allowed requests upstream over a verified-identity connection.
  const processProxiedRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    t: ProxiedRequestTransport,
  ) => {
    if (normalizeHost(t.host) === VARLOCK_INTERNAL_HOST) {
      handleInternalRequest(req, res, t);
      return;
    }

    // One policy snapshot per request: `reconfigure` swaps the bindings, and a
    // request must not see a mix of old and new policy across its phases.
    const policy: ProxyPolicyState = { rules, managedItems, egressMode };
    const facts: ProxiedRequestFacts = {
      host: t.host,
      isHttps: t.isHttps,
      method: t.method,
      pathOnly: t.pathOnly,
      requestTarget: t.requestTarget,
    };

    const pre = evaluateProxiedRequestPreBody(facts, policy);
    if (pre.kind === 'blocked') {
      onActivity?.(pre.activity);
      respondBlocked(res, pre.status, pre.message, pre.teardownOnTunnel && t.tunnelTeardown);
      return;
    }

    const body = await readBody(req);
    const bodyText = body.toString('utf8');

    // Bridge the transport's approval provider into the pipeline's gate: build an
    // ApprovalRequest committed to this exact request (body hash included) and
    // honor only a decision bound to it (Invariant #8). The pipeline fails closed
    // around this (missing gate or thrown error ⇒ denied).
    const approvalGate: ApprovalGateFn | undefined = approvalProvider
      ? async (input) => {
        const request = createApprovalRequest({ ...input, body });
        const decision = await approvalProvider.requestApproval(request);
        return isApprovalValid(request, decision);
      }
      : undefined;

    const outcome = await evaluateProxiedRequestWithBody(
      pre,
      facts,
      policy,
      { headers: req.headers, bodyText },
      { approvalGate },
    );
    if (outcome.kind === 'blocked') {
      onActivity?.(outcome.activity);
      respondBlocked(res, outcome.status, outcome.message, outcome.teardownOnTunnel && t.tunnelTeardown);
      return;
    }
    onActivity?.(outcome.activity);
    const { hostItems, shouldRewrite } = outcome;

    const rewrittenBody = shouldRewrite
      ? Buffer.from(outcome.rewrittenBodyText, 'utf8')
      : body;
    const rewrittenPath = outcome.rewrittenTarget;

    const upstreamHeaders = transformHeaders(req.headers, outcome.transformHeaderValue);
    delete upstreamHeaders['proxy-connection'];
    delete upstreamHeaders.connection;
    // Hop-by-hop: addressed to this proxy, never the upstream. A client with
    // credentials in its proxy url (e.g. a copied HTTPS_PROXY with userinfo)
    // must not have them forwarded to the destination host.
    delete upstreamHeaders['proxy-authorization'];
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
    // — the pipeline's cleartext guard fails closed when items are in scope.
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
      CARGO_HTTP_CAINFO: combinedCaPath,
      // Node's built-in fetch (undici) ignores HTTP(S)_PROXY unless this flag
      // is set (node >= 24; older nodes ignore the flag and still bypass).
      // Without it, fetch traffic silently goes DIRECT to the upstream,
      // skipping substitution and egress policy entirely.
      NODE_USE_ENV_PROXY: '1',
      // Deno honors HTTP(S)_PROXY but reads its CA trust from DENO_CERT,
      // not SSL_CERT_FILE.
      DENO_CERT: combinedCaPath,
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
      // With --persist-ca the whole point is that they outlive the session, so
      // everything (including ca-key.pem) stays put.
      if (persistCa) {
        // keep the persisted CA for the next start
      } else if (certDirIsUserProvided) {
        await rm(caCertPath, { force: true });
        await rm(combinedCaPath, { force: true });
      } else {
        await rm(certsDir, { recursive: true, force: true });
      }
    },
  };
}
