import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';

import type {
  ApprovalDecision,
  ApprovalLifetime,
  ApprovalPendingNotification,
  ApprovalProvider,
  ApprovalRequest,
} from './approval';

type CreateApprovalResponse = {
  approvalUrl?: unknown;
  statusUrl?: unknown;
  pollIntervalMs?: unknown;
};

type ApprovalStatusResponse = {
  status?: unknown;
  nonce?: unknown;
  lifetime?: unknown;
  reason?: unknown;
  pollIntervalMs?: unknown;
  proof?: unknown;
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 10_000;

export interface HttpApprovalAuth {
  /** Authentication headers for one service request. Called again while polling so future auth can refresh. */
  getHeaders(): Promise<Record<string, string>>;
}

export interface ApprovalDecisionVerifier {
  verify(input: {
    proof: unknown;
    request: ApprovalRequest;
    lifetime: ApprovalLifetime;
  }): Promise<boolean>;
}

export function createBearerHttpApprovalAuth(token: string): HttpApprovalAuth {
  return {
    async getHeaders() {
      return { authorization: `Bearer ${token}` };
    },
  };
}

function deny(req: ApprovalRequest, reason: string): ApprovalDecision {
  return { approved: false, nonce: req.nonce, reason };
}

function responseError(response: Response): string {
  return `approval service returned HTTP ${response.status}`;
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('approval service returned a non-object JSON response');
  }
  return body as Record<string, unknown>;
}

function parseUrl(value: unknown, base: string, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`approval service response is missing ${field}`);
  }
  const parsed = new URL(value, base);
  const isLoopback = parsed.hostname === 'localhost'
    || parsed.hostname === '::1'
    || parsed.hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error(`approval service returned an insecure ${field}; HTTPS is required outside loopback`);
  }
  return parsed.toString();
}

function parsePollInterval(value: unknown, fallback = DEFAULT_POLL_INTERVAL_MS): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, Math.round(value)));
}

function parseLifetime(value: unknown): ApprovalLifetime {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('approval service returned an invalid lifetime');
  }
  const lifetime = value as Record<string, unknown>;
  if (lifetime.kind === 'once' || lifetime.kind === 'session') return { kind: lifetime.kind };
  if (lifetime.kind === 'duration'
    && typeof lifetime.durationMs === 'number'
    && Number.isFinite(lifetime.durationMs)
    && lifetime.durationMs > 0) {
    return { kind: 'duration', durationMs: lifetime.durationMs };
  }
  throw new Error('approval service returned an invalid lifetime');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function requestHeaders(auth: HttpApprovalAuth): Promise<Record<string, string>> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(await auth.getHeaders()),
  };
}

function approvalDecisionPayload(req: ApprovalRequest, lifetime: ApprovalLifetime): string {
  return JSON.stringify([
    'varlock-approval-decision-v1',
    req.method,
    req.host,
    req.path,
    req.bodyHash,
    req.nonce,
    req.expiresAt,
    req.ruleId ?? null,
    req.grantKey ?? null,
    req.maxDurationMs ?? null,
    req.injectedKeys ?? [],
    lifetime.kind,
    lifetime.kind === 'duration' ? lifetime.durationMs : null,
  ]);
}

function importEd25519PublicKey(encoded: string): KeyObject {
  const key = encoded.includes('-----BEGIN PUBLIC KEY-----')
    ? createPublicKey(encoded)
    : createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('approval decision public key must be Ed25519');
  }
  return key;
}

export function createEd25519DecisionVerifier(
  publicKeys: ReadonlyMap<string, string>,
): ApprovalDecisionVerifier {
  const importedKeys = new Map<string, KeyObject>();
  for (const [keyId, encoded] of publicKeys) {
    importedKeys.set(keyId, importEd25519PublicKey(encoded));
  }
  if (importedKeys.size === 0) throw new Error('at least one approval decision public key is required');

  return {
    async verify({ proof, request, lifetime }) {
      if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
      const candidate = proof as Record<string, unknown>;
      if (candidate.algorithm !== 'ed25519'
        || typeof candidate.keyId !== 'string'
        || typeof candidate.signature !== 'string'
        || !/^[A-Za-z\d_-]{86}$/u.test(candidate.signature)) return false;
      const publicKey = importedKeys.get(candidate.keyId);
      if (!publicKey) return false;
      try {
        return verifySignature(
          null,
          Buffer.from(approvalDecisionPayload(request, lifetime)),
          publicKey,
          Buffer.from(candidate.signature, 'base64url'),
        );
      } catch {
        return false;
      }
    },
  };
}

function requestSignal(expiresAt: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, expiresAt - Date.now()));
}

/**
 * Create an approval provider backed by an HTTP service. The configured endpoint
 * accepts an ApprovalRequest via POST and returns approvalUrl + statusUrl. Varlock
 * polls statusUrl until it returns approved, denied, or expired.
 */
export function createHttpApprovalProvider(opts: {
  url: string;
  auth: HttpApprovalAuth;
  decisionVerifier: ApprovalDecisionVerifier;
  onPending?: (notification: ApprovalPendingNotification) => void | Promise<void>;
}): ApprovalProvider {
  const createUrl = parseUrl(opts.url, opts.url, 'approval URL');

  return {
    async requestApproval(req) {
      try {
        const createResponse = await fetch(createUrl, {
          method: 'POST',
          headers: await requestHeaders(opts.auth),
          body: JSON.stringify(req),
          redirect: 'error',
          signal: requestSignal(req.expiresAt),
        });
        if (!createResponse.ok) return deny(req, responseError(createResponse));

        const created = await readObject(createResponse) as CreateApprovalResponse;
        const approvalUrl = parseUrl(created.approvalUrl, createUrl, 'approvalUrl');
        const statusUrl = parseUrl(created.statusUrl, createUrl, 'statusUrl');
        if (new URL(statusUrl).origin !== new URL(createUrl).origin) {
          return deny(req, 'approval service returned a cross-origin statusUrl');
        }
        let pollIntervalMs = parsePollInterval(created.pollIntervalMs);

        await opts.onPending?.({
          approvalUrl,
          method: req.method,
          host: req.host,
          path: req.path,
          expiresAt: req.expiresAt,
          ...(req.ruleId ? { ruleId: req.ruleId } : {}),
          ...(req.injectedKeys?.length ? { injectedKeys: req.injectedKeys } : {}),
        });

        while (Date.now() < req.expiresAt) {
          await sleep(Math.min(pollIntervalMs, Math.max(1, req.expiresAt - Date.now())));
          if (Date.now() >= req.expiresAt) break;

          const statusResponse = await fetch(statusUrl, {
            method: 'GET',
            headers: await requestHeaders(opts.auth),
            redirect: 'error',
            signal: requestSignal(req.expiresAt),
          });
          if (!statusResponse.ok) return deny(req, responseError(statusResponse));

          const result = await readObject(statusResponse) as ApprovalStatusResponse;
          pollIntervalMs = parsePollInterval(result.pollIntervalMs, pollIntervalMs);
          if (result.status === 'pending') continue;
          if (result.status === 'denied' || result.status === 'expired') {
            return deny(req, typeof result.reason === 'string' ? result.reason : `approval ${result.status}`);
          }
          if (result.status !== 'approved') {
            return deny(req, 'approval service returned an unknown status');
          }
          if (result.nonce !== req.nonce) {
            return deny(req, 'approval service returned a decision for a different request');
          }
          const lifetime = parseLifetime(result.lifetime);
          if (!await opts.decisionVerifier.verify({ proof: result.proof, request: req, lifetime })) {
            return deny(req, 'approval service returned an invalid decision proof');
          }
          return {
            approved: true,
            nonce: req.nonce,
            lifetime,
            ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
          };
        }
        return deny(req, 'approval request expired');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return deny(req, `approval service unavailable: ${reason}`);
      }
    },
  };
}
