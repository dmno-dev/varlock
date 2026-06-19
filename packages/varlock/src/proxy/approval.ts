import { createHash, randomBytes } from 'node:crypto';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { ProxyApprovalEach } from './types';

/**
 * A request-bound approval request (Invariant #8). It commits to the EXACT
 * request — method + verified host + path + body hash + a nonce + an expiry —
 * so that when this local stub is replaced by the signed phone-approval relay,
 * an approval can only authorize the specific request it was shown, never a
 * substituted one. The runtime honors a decision only if it echoes this
 * request's `nonce` and arrives before `expiresAt`.
 */
export type ApprovalRequest = {
  method: string;
  /** Verified upstream host (Invariant #1), not the requested name. */
  host: string;
  /** Path only, no query, placeholder form. */
  path: string;
  /** sha256 of the final request body (no secret bytes — body is placeholder-form here). */
  bodyHash: string;
  /** Unique per request; the decision must echo it. */
  nonce: string;
  /** Epoch ms; the provider must decide before this. */
  expiresAt: number;
  ruleId?: string;
  /**
   * Key a standing grant is stored/matched under — `ruleId` plus the rule's
   * granularity (`each`). Absent ⇒ this request can't be remembered.
   */
  grantKey?: string;
  /**
   * Schema-enforced ceiling on how long a "yes" may be remembered, in ms.
   * `0` = always ask; `undefined` = up to the whole session.
   */
  maxDurationMs?: number;
  /** Secret keys (names, never values) that WOULD be injected if approved. */
  injectedKeys?: Array<string>;
};

/**
 * How long an approval lasts. `once` (default) authorizes only this request; the
 * others authorize future requests matching the same grant key (see
 * approval-grants.ts) until the session ends or the window elapses. (Granularity
 * — *which* requests — is a separate axis, captured by the grant key.)
 */
export type ApprovalLifetime = | { kind: 'once' }
  | { kind: 'session' }
  | { kind: 'duration'; durationMs: number };

export type ApprovalDecision = {
  approved: boolean;
  /** Echoes the request nonce the approver acted on; must match to be honored. */
  nonce: string;
  /** How long this approval lasts. Absent ⇒ `once`. */
  lifetime?: ApprovalLifetime;
  reason?: string;
};

export interface ApprovalProvider {
  /**
   * Resolve with a decision for the given request. Implementations must fail
   * closed — return `approved: false` (or reject) on timeout/error/unavailable.
   */
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export function hashBody(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

const DEFAULT_TTL_MS = 60_000;

/**
 * The grant key for a request: `ruleId` plus the part of the request that the
 * rule's granularity (`each`) distinguishes. So a broad rule can still yield
 * fine-grained grants (per-endpoint or per-exact-request) without many rules.
 */
function computeGrantKey(input: {
  ruleId: string;
  each: ProxyApprovalEach;
  method: string;
  host: string;
  path: string;
  bodyHash: string;
}): string {
  let eachPart: string;
  if (input.each === 'host') {
    eachPart = input.host;
  } else if (input.each === 'request') {
    eachPart = `${input.method} ${input.host}${input.path} ${input.bodyHash}`;
  } else {
    eachPart = `${input.method} ${input.host}${input.path}`; // endpoint (default)
  }
  return `${input.ruleId} ${eachPart}`;
}

export function createApprovalRequest(input: {
  method: string;
  host: string;
  path: string;
  body: Buffer | string;
  ttlMs?: number;
  ruleId?: string;
  each?: ProxyApprovalEach;
  maxDurationMs?: number;
  injectedKeys?: Array<string>;
}): ApprovalRequest {
  const bodyHash = hashBody(input.body);
  const grantKey = input.ruleId
    ? computeGrantKey({
      ruleId: input.ruleId,
      each: input.each ?? 'endpoint',
      method: input.method,
      host: input.host,
      path: input.path,
      bodyHash,
    })
    : undefined;
  return {
    method: input.method,
    host: input.host,
    path: input.path,
    bodyHash,
    nonce: randomBytes(16).toString('hex'),
    expiresAt: Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS),
    ...(input.ruleId ? { ruleId: input.ruleId } : {}),
    ...(grantKey ? { grantKey } : {}),
    ...(input.maxDurationMs !== undefined ? { maxDurationMs: input.maxDurationMs } : {}),
    ...(input.injectedKeys?.length ? { injectedKeys: input.injectedKeys } : {}),
  };
}

/**
 * Whether a decision actually authorizes a request: it must approve, echo the
 * request's nonce, and arrive before expiry. Centralizes the request-binding
 * check so every provider (local stub today, phone relay later) is held to it.
 */
export function isApprovalValid(req: ApprovalRequest, decision: ApprovalDecision): boolean {
  return decision.approved && decision.nonce === req.nonce && Date.now() < req.expiresAt;
}

/**
 * Clamp a decision's lifetime to the rule's `maxDurationMs` ceiling — the
 * schema-enforced cap. `0` ⇒ always once (never remembered); `undefined` ⇒ no
 * cap; a finite cap turns `session` into a bounded duration and shortens any
 * longer duration. This runs proxy-side so no approver (local or remote) can
 * exceed what the schema allows.
 */
export function clampLifetime(
  lifetime: ApprovalLifetime | undefined,
  maxDurationMs: number | undefined,
): ApprovalLifetime {
  if (!lifetime || lifetime.kind === 'once') return { kind: 'once' };
  if (maxDurationMs === 0) return { kind: 'once' };
  if (maxDurationMs === undefined) return lifetime;
  if (lifetime.kind === 'session') return { kind: 'duration', durationMs: maxDurationMs };
  return { kind: 'duration', durationMs: Math.min(lifetime.durationMs, maxDurationMs) };
}

/** Always denies — the safe default when no interactive approver is available. */
export function createAutoDenyApprovalProvider(): ApprovalProvider {
  return {
    async requestApproval(req) {
      return { approved: false, nonce: req.nonce, reason: 'no approver available (auto-deny)' };
    },
  };
}

/** Default window for a "for a while" (`m`) terminal approval when the rule sets no cap. */
export const DEFAULT_GRANT_DURATION_MS = 15 * 60_000;

function formatMinutes(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  return mins >= 60 && mins % 60 === 0 ? `${mins / 60} hr` : `${mins} min`;
}

/** Maps a single-key terminal answer to a decision, honoring which options were offered. */
function parseTtyAnswer(
  answer: string,
  nonce: string,
  opts: { allowSession: boolean; durationMs?: number },
): ApprovalDecision {
  const a = answer.trim().toLowerCase();
  if (a === 'y' || a === 'yes' || a === 'o') {
    return { approved: true, nonce, lifetime: { kind: 'once' } };
  }
  if (a === 's' && opts.allowSession) {
    return { approved: true, nonce, lifetime: { kind: 'session' } };
  }
  if (a === 'm' && opts.durationMs !== undefined) {
    return { approved: true, nonce, lifetime: { kind: 'duration', durationMs: opts.durationMs } };
  }
  return { approved: false, nonce, reason: 'denied at terminal' };
}

/**
 * Prompts for approval on the proxy process's controlling terminal. Suited to
 * `varlock proxy start`, where the agent runs elsewhere and the proxy owns the
 * TTY. The offered options adapt to the rule's `maxDurationMs` cap (always-ask
 * shows only once). Fails closed: denies on a non-TTY, timeout, EOF, or any
 * answer other than an explicit yes.
 */
export function createTtyApprovalProvider(opts?: {
  input?: Readable & { isTTY?: boolean };
  output?: Writable;
  timeoutMs?: number;
}): ApprovalProvider {
  const input = opts?.input ?? process.stdin;
  const output = opts?.output ?? process.stderr;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TTL_MS;

  return {
    async requestApproval(req) {
      if (!input.isTTY) {
        return { approved: false, nonce: req.nonce, reason: 'no interactive terminal to prompt for approval' };
      }

      // Offer only what the rule's cap permits: maxDurationMs===0 → once only;
      // undefined → session allowed; finite → a bounded window, no session.
      const allowGrants = req.grantKey !== undefined && req.maxDurationMs !== 0;
      const allowSession = allowGrants && req.maxDurationMs === undefined;
      const durationMs = allowGrants ? (req.maxDurationMs ?? DEFAULT_GRANT_DURATION_MS) : undefined;

      const options = ['[y] once'];
      if (allowSession) options.push('[s] this session');
      if (durationMs !== undefined) options.push(`[m] ${formatMinutes(durationMs)}`);
      options.push('[n] no');

      const inj = req.injectedKeys?.length ? ` injecting [${req.injectedKeys.join(', ')}]` : '';
      const prompt = '\n🔐 varlock proxy — approval required\n'
        + `   ${req.method} https://${req.host}${req.path}${inj}\n${
          req.ruleId ? `   rule: ${req.ruleId}\n` : ''
        }   Approve? ${options.join('  ')} `;

      const rl = readline.createInterface({ input, output });
      let answered = false;
      const answer = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          output.write('\n   (timed out — denied)\n');
          resolve('');
        }, timeoutMs);
        timer.unref?.();
        rl.question(prompt, (a) => {
          answered = true;
          clearTimeout(timer);
          resolve(a);
        });
        rl.on('close', () => {
          clearTimeout(timer);
          // 'close' without an answer means EOF on the terminal — which happens
          // when `proxy start` isn't the foreground process of an interactive
          // terminal (e.g. started with `&`, under a supervisor, or stdin
          // redirected). Surface that rather than denying silently.
          if (!answered) {
            output.write(
              '\n   (couldn\'t read your answer — run `varlock proxy start` in the '
                + 'foreground of an interactive terminal to approve requests)\n',
            );
          }
          resolve('');
        });
      });
      rl.close();

      return parseTtyAnswer(answer, req.nonce, { allowSession, durationMs });
    },
  };
}
