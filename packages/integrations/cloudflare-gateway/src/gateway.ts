import {
  detectScrubbedKeys, evaluateProxiedRequestPreBody, evaluateProxiedRequestWithBody,
  findRealLeak, getHeaderValue, isTextLikeResponse, isUncompressedResponse,
  parseProxyAuthToken, redactOutgoingHeaders, replaceRealWithPlaceholders,
  shouldRedactResponseBody, StreamingScrubber, tokenMatches, transformHeaders,
  type HeadersRecord, type ProxiedRequestFacts,
  type ProxyManagedItem, type ProxyPolicyState, type RequestScopedManagedItem,
} from 'varlock/proxy-core';

import type { VarlockGatewayConfig, WaitUntilContext } from './types';

/** Reported after an upstream response is forwarded (mirrors the local runtime's ProxyResponseInfo). */
export type GatewayResponseInfo = {
  host: string;
  method: string;
  path: string;
  statusCode: number;
  scrubbedKeys: Array<string>;
  streamed?: boolean;
};

type ResolvedConfig = Required<Pick<VarlockGatewayConfig, 'rules' | 'egressMode' | 'placeholders'>> & {
  getSecretValue: NonNullable<VarlockGatewayConfig['getSecretValue']>;
  getToken: NonNullable<VarlockGatewayConfig['getToken']>;
  onAudit: NonNullable<VarlockGatewayConfig['onAudit']>;
  onResponse?: (info: GatewayResponseInfo) => void;
};

/** Header that carries the true destination (`host` or `host:port`) in explicit-gateway mode. */
export const GATEWAY_TARGET_HEADER = 'x-varlock-target';
/** Raw-token alternative to `Proxy-Authorization: Basic varlock:<token>` in explicit-gateway mode. */
export const GATEWAY_TOKEN_HEADER = 'x-varlock-token';

/** Gateway-internal headers: consumed here, never forwarded upstream. */
const GATEWAY_INTERNAL_HEADERS = [GATEWAY_TARGET_HEADER, GATEWAY_TOKEN_HEADER];

function headersToRecord(headers: Headers): HeadersRecord {
  const out: HeadersRecord = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function recordToHeaders(record: Record<string, string | Array<string>>): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      for (const v of value) out.append(key, v);
    } else {
      out.set(key, value);
    }
  }
  return out;
}

function textResponse(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain' } });
}

/**
 * Scrub real values back to placeholders on an unbounded text stream, chunk by
 * chunk (the Web-streams sibling of the node runtime's scrubbing Transform).
 * A streaming TextDecoder keeps multi-byte UTF-8 intact across chunks; the
 * hold-back of trailing partial real values lives in the shared StreamingScrubber.
 */
function createScrubbingTransformStream(
  managedItems: Array<ProxyManagedItem>,
  onDone: (matchedKeys: Set<string>) => void,
  initialMatchedKeys: Iterable<string>,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();
  const matched = new Set(initialMatchedKeys);
  const scrubber = new StreamingScrubber(managedItems, (key) => matched.add(key));
  return new TransformStream({
    transform(chunk, controller) {
      const text = scrubber.push(decoder.decode(chunk, { stream: true }));
      if (text) controller.enqueue(encoder.encode(text));
    },
    flush(controller) {
      const text = scrubber.flush(decoder.decode());
      if (text) controller.enqueue(encoder.encode(text));
      onDone(matched);
    },
  });
}

/** Everything the shared pipeline needs to know about one gateway request, mode-independent. */
type GatewayTarget = {
  host: string;
  port: number;
  isHttps: boolean;
  /** Path + query forwarded upstream. */
  requestTarget: string;
  /** Path only (no query), for policy facts. */
  pathOnly: string;
};

/**
 * Parse `host` / `host:port` (the target header). URL-based so bracketed IPv6
 * literals are handled; mirrors the local runtime's parseHostPort.
 */
function parseTargetHost(value: string): { host: string; port: number } | null {
  try {
    const url = new URL(`https://${value}`);
    if (url.pathname !== '/' || url.search || url.hash || url.username) return null;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host) return null;
    const port = url.port ? Number(url.port) : 443;
    if (Number.isNaN(port)) return null;
    return { host, port };
  } catch {
    return null;
  }
}

/** The Web-streams sibling of the local runtime's forwardUpstreamResponseWithRedaction. */
async function forwardResponseWithRedaction(
  upstreamRes: Response,
  managedItems: Array<ProxyManagedItem>,
  shouldRedact: boolean,
  responseCtx: { host: string; method: string; path: string; onResponse?: (info: GatewayResponseInfo) => void },
): Promise<Response> {
  const statusCode = upstreamRes.status;
  const report = (scrubbedKeys: Iterable<string>, streamed: boolean) => {
    responseCtx.onResponse?.({
      host: responseCtx.host,
      method: responseCtx.method,
      path: responseCtx.path,
      statusCode,
      scrubbedKeys: [...new Set(scrubbedKeys)],
      ...(streamed ? { streamed: true } : {}),
    });
  };

  const respHeaderRecord = headersToRecord(upstreamRes.headers);
  // Detect keys reflected in the (original) response headers, scrubbed regardless of body path.
  const headerKeys = shouldRedact ? detectScrubbedKeys(JSON.stringify(respHeaderRecord), managedItems) : [];
  const outgoingHeaders = shouldRedact
    ? recordToHeaders(redactOutgoingHeaders(respHeaderRecord, managedItems))
    : new Headers(upstreamRes.headers);

  if (!shouldRedact || !shouldRedactResponseBody(respHeaderRecord)) {
    // Scrub unbounded uncompressed text streams (e.g. SSE) chunk-by-chunk so a
    // reflected secret is still replaced. Bounded text bodies take the buffered
    // path below; compressed/binary bodies pass through unchanged.
    const hasContentLength = getHeaderValue(respHeaderRecord, 'content-length') !== undefined;
    const canScrubStream = shouldRedact
      && managedItems.length > 0
      && !hasContentLength
      && isUncompressedResponse(respHeaderRecord)
      && isTextLikeResponse(respHeaderRecord)
      && !!upstreamRes.body;

    if (canScrubStream) {
      const scrubbed = upstreamRes.body!.pipeThrough(createScrubbingTransformStream(
        managedItems,
        (matched) => report(matched, true),
        headerKeys,
      ));
      return new Response(scrubbed, { status: statusCode, headers: outgoingHeaders });
    }
    report(headerKeys, false);
    return new Response(upstreamRes.body, { status: statusCode, headers: outgoingHeaders });
  }

  const originalBody = await upstreamRes.text();
  const bodyKeys = detectScrubbedKeys(originalBody, managedItems);
  const redactedBody = replaceRealWithPlaceholders(originalBody, managedItems);

  // Fail-safe (Invariant #6): if a real value somehow survived scrubbing, do
  // NOT forward it — fail closed rather than leak a secret to the workload.
  if (findRealLeak(redactedBody, managedItems)) {
    return textResponse(502, 'Response withheld: a sensitive value could not be redacted');
  }

  outgoingHeaders.delete('content-length'); // the runtime recomputes it for the redacted body
  outgoingHeaders.delete('transfer-encoding');
  outgoingHeaders.delete('etag');

  report([...headerKeys, ...bodyKeys], false);
  return new Response(redactedBody, { status: statusCode, headers: outgoingHeaders });
}

/**
 * The shared request path for both modes: policy → guards → substitution via the
 * proxy-core two-phase pipeline, then a verified-TLS `fetch()` upstream
 * (workerd validates upstream certificates before any request bytes are sent,
 * which is what the local runtime's verifyUpstreamIdentity exists to guarantee),
 * then response redaction/scrubbing. Every failure path fails closed.
 */
async function handleGatewayRequest(
  request: Request,
  env: unknown,
  target: GatewayTarget,
  config: ResolvedConfig,
): Promise<Response> {
  const managedItems: Array<ProxyManagedItem> = Object.entries(config.placeholders)
    .map(([key, placeholder]) => ({ key, placeholder, realValue: '' }));
  const policy: ProxyPolicyState = {
    rules: config.rules,
    managedItems,
    egressMode: config.egressMode,
  };
  const facts: ProxiedRequestFacts = {
    host: target.host,
    isHttps: target.isHttps,
    method: request.method,
    pathOnly: target.pathOnly,
    requestTarget: target.requestTarget,
  };

  const pre = evaluateProxiedRequestPreBody(facts, policy);
  if (pre.kind === 'blocked') {
    config.onAudit(pre.activity);
    return textResponse(pre.status, pre.message);
  }

  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  const bodyText = new TextDecoder().decode(bodyBytes);
  const headersRecord = headersToRecord(request.headers);

  // Resolve real values lazily, only for the items this request puts in scope.
  // Fail closed if a carried placeholder's value is unavailable (forwarding it
  // un-substituted would just fail upstream with a cryptic auth error); items
  // whose placeholder is NOT in the request are simply dropped from scope.
  const scanParts = [facts.requestTarget, JSON.stringify(headersRecord), bodyText];
  const keptItems: Array<RequestScopedManagedItem> = [];
  for (const item of pre.hostItems) {
    const value = await config.getSecretValue(item.key, env);
    if (typeof value === 'string' && value.length > 0) {
      item.realValue = value;
      keptItems.push(item);
    } else if (scanParts.some((part) => part.includes(item.placeholder))) {
      config.onAudit({
        host: target.host,
        method: facts.method,
        path: facts.pathOnly,
        url: facts.requestTarget,
        matched: true,
        blocked: true,
        decision: 'blocked-uninjected',
      });
      return textResponse(502, `varlock gateway: no value available for ${item.key} - `
        + 'check the worker secret (or getSecretValue) that should provide it.');
    }
  }
  pre.hostItems = keptItems;

  const outcome = await evaluateProxiedRequestWithBody(
    pre,
    facts,
    policy,
    { headers: headersRecord, bodyText },
    {}, // tier 0: no approval provider — require-approval rules fail closed in the pipeline
  );
  config.onAudit(outcome.activity);
  if (outcome.kind === 'blocked') {
    return textResponse(outcome.status, outcome.message);
  }
  const { hostItems, shouldRewrite } = outcome;

  const upstreamHeaderRecord = transformHeaders(headersRecord, outcome.transformHeaderValue);
  delete upstreamHeaderRecord['proxy-connection'];
  delete upstreamHeaderRecord.connection;
  // Hop-by-hop: addressed to this gateway, never the upstream.
  delete upstreamHeaderRecord['proxy-authorization'];
  for (const name of GATEWAY_INTERNAL_HEADERS) delete upstreamHeaderRecord[name];
  // fetch() derives host and content-length itself; a stale value from the
  // placeholder-form request would conflict with the rewritten body.
  delete upstreamHeaderRecord.host;
  delete upstreamHeaderRecord['content-length'];

  const scheme = target.isHttps ? 'https' : 'http';
  const defaultPort = target.isHttps ? 443 : 80;
  const portSuffix = target.port && target.port !== defaultPort ? `:${target.port}` : '';
  const upstreamUrl = `${scheme}://${target.host}${portSuffix}${outcome.rewrittenTarget}`;

  const method = request.method.toUpperCase();
  let upstreamBody: Uint8Array | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    // Non-rewritten bodies forward the original bytes (binary-safe); rewritten
    // ones are re-encoded from the substituted text.
    upstreamBody = shouldRewrite ? new TextEncoder().encode(outcome.rewrittenBodyText) : bodyBytes;
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: request.method,
      headers: recordToHeaders(upstreamHeaderRecord),
      ...(upstreamBody !== undefined && upstreamBody.byteLength > 0 ? { body: upstreamBody } : {}),
      // Proxy semantics: hand redirects back to the workload rather than
      // following them here (a redirect Location must go through policy too).
      redirect: 'manual',
    });
  } catch {
    // Fail closed: the connection failed (workerd verifies upstream TLS before
    // sending), so the secret was never transmitted to an unverified peer.
    return textResponse(502, 'Upstream request failed');
  }

  return forwardResponseWithRedaction(upstreamRes, hostItems, shouldRewrite, {
    host: target.host,
    method: facts.method,
    path: facts.pathOnly,
    onResponse: config.onResponse,
  });
}

function resolveConfig(config: VarlockGatewayConfig): ResolvedConfig {
  // Tier 0 has no approval provider: a require-approval rule would silently deny
  // every matching request, so surface the misconfiguration loudly at startup.
  const approvalRule = config.rules.find((rule) => rule.approval);
  if (approvalRule) {
    throw new Error('varlock gateway: @proxy approval rules require an approval provider, which this gateway does not support yet. '
      + 'Remove the approval requirement from the rule, or enforce it with a locally-run proxy instead.');
  }
  return {
    rules: config.rules,
    egressMode: config.egressMode ?? 'strict',
    placeholders: config.placeholders,
    getSecretValue: config.getSecretValue
      ?? ((itemKey, env) => {
        const value = (env as Record<string, unknown> | undefined)?.[itemKey];
        return typeof value === 'string' ? value : undefined;
      }),
    getToken: config.getToken
      ?? ((env) => {
        const value = (env as Record<string, unknown> | undefined)?._VARLOCK_GATEWAY_TOKEN;
        return typeof value === 'string' ? value : undefined;
      }),
    onAudit: config.onAudit
      ?? ((activity) => {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ source: 'varlock-gateway', ...activity }));
      }),
    ...(config.onResponse ? { onResponse: config.onResponse } : {}),
  };
}

/**
 * A varlock credential gateway for Cloudflare Workers: the same policy →
 * substitution guards → substitution → response scrubbing pipeline as
 * `varlock proxy run`, exposed through the two ways traffic can reach a worker.
 */
export function createVarlockGateway(configInput: VarlockGatewayConfig) {
  const config = resolveConfig(configInput);

  return {
    /**
     * Outbound handler for the Cloudflare Sandbox SDK / Containers (transparent
     * mode). Cloudflare terminates the sandbox's TLS and invokes this with the
     * ORIGINAL request (real URL intact), so nothing inside the sandbox needs a
     * gateway URL or a varlock binary. Attach it to your Sandbox class:
     *
     *   MySandbox.outbound = gateway.asSandboxOutbound();
     *
     * and remember to `export { ContainerProxy } from '@cloudflare/sandbox'`.
     * No token gate: only the platform can route sandbox egress here.
     */
    asSandboxOutbound() {
      return async (request: Request, env?: unknown, _ctx?: unknown): Promise<Response> => {
        const url = new URL(request.url);
        const isHttps = url.protocol === 'https:';
        const defaultPort = isHttps ? 443 : 80;
        return handleGatewayRequest(request, env, {
          host: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port ? Number(url.port) : defaultPort,
          isHttps,
          requestTarget: `${url.pathname}${url.search}`,
          pathOnly: url.pathname,
        }, config);
      };
    },

    /**
     * Explicit-gateway fetch handler (for workloads OUTSIDE Cloudflare: E2B,
     * Fly, CI, ...). Requests arrive as ordinary HTTPS with the true
     * destination in the `x-varlock-target` header (`host` or `host:port`,
     * always https) and the data-plane token via
     * `Proxy-Authorization: Basic varlock:<token>` or `x-varlock-token`.
     * Auth is checked before anything else; without a configured token every
     * request is refused (fail closed).
     *
     *   export default { fetch: gateway.asFetchHandler() };
     */
    asFetchHandler() {
      return async (request: Request, env?: unknown, _ctx?: WaitUntilContext): Promise<Response> => {
        const expectedToken = config.getToken(env);
        if (!expectedToken) {
          return textResponse(403, 'varlock gateway: no data-plane token configured - set the _VARLOCK_GATEWAY_TOKEN secret.');
        }
        const provided = parseProxyAuthToken(request.headers.get('proxy-authorization') ?? undefined)
          ?? request.headers.get(GATEWAY_TOKEN_HEADER)
          ?? undefined;
        if (!tokenMatches(provided, expectedToken)) {
          return textResponse(401, 'varlock gateway: missing or invalid data-plane token.');
        }

        const targetRaw = request.headers.get(GATEWAY_TARGET_HEADER);
        if (!targetRaw) {
          return textResponse(400, `varlock gateway: missing ${GATEWAY_TARGET_HEADER} header (expected the destination host, e.g. api.stripe.com or host:port).`);
        }
        const parsed = parseTargetHost(targetRaw);
        if (!parsed) {
          return textResponse(400, `varlock gateway: invalid ${GATEWAY_TARGET_HEADER} header ${JSON.stringify(targetRaw)}.`);
        }

        const url = new URL(request.url);
        return handleGatewayRequest(request, env, {
          host: parsed.host,
          port: parsed.port,
          isHttps: true, // explicit-gateway upstreams are always TLS
          requestTarget: `${url.pathname}${url.search}`,
          pathOnly: url.pathname,
        }, config);
      };
    },
  };
}

export type VarlockGateway = ReturnType<typeof createVarlockGateway>;
