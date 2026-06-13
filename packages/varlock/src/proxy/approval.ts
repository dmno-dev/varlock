import { createHash, randomBytes } from 'node:crypto';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

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
  /** Secret keys (names, never values) that WOULD be injected if approved. */
  injectedKeys?: Array<string>;
};

export type ApprovalDecision = {
  approved: boolean;
  /** Echoes the request nonce the approver acted on; must match to be honored. */
  nonce: string;
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

export function createApprovalRequest(input: {
  method: string;
  host: string;
  path: string;
  body: Buffer | string;
  ttlMs?: number;
  ruleId?: string;
  injectedKeys?: Array<string>;
}): ApprovalRequest {
  return {
    method: input.method,
    host: input.host,
    path: input.path,
    bodyHash: hashBody(input.body),
    nonce: randomBytes(16).toString('hex'),
    expiresAt: Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS),
    ...(input.ruleId ? { ruleId: input.ruleId } : {}),
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

/** Always denies — the safe default when no interactive approver is available. */
export function createAutoDenyApprovalProvider(): ApprovalProvider {
  return {
    async requestApproval(req) {
      return { approved: false, nonce: req.nonce, reason: 'no approver available (auto-deny)' };
    },
  };
}

/**
 * Prompts for approval on the proxy process's controlling terminal. Suited to
 * `varlock proxy start`, where the agent runs elsewhere and the proxy owns the
 * TTY. Fails closed: denies on a non-TTY, timeout, EOF, or any answer other than
 * an explicit yes.
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

      const inj = req.injectedKeys?.length ? ` injecting [${req.injectedKeys.join(', ')}]` : '';
      const prompt = '\n🔐 varlock proxy — approval required\n'
        + `   ${req.method} https://${req.host}${req.path}${inj}\n${
          req.ruleId ? `   rule: ${req.ruleId}\n` : ''
        }   Approve this request? [y/N] `;

      const rl = readline.createInterface({ input, output });
      const answer = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          output.write('\n   (timed out — denied)\n');
          resolve('');
        }, timeoutMs);
        timer.unref?.();
        rl.question(prompt, (a) => {
          clearTimeout(timer);
          resolve(a);
        });
        rl.on('close', () => {
          clearTimeout(timer);
          resolve('');
        });
      });
      rl.close();

      const approved = /^y(es)?$/i.test(answer.trim());
      return {
        approved,
        nonce: req.nonce,
        reason: approved ? 'approved at terminal' : 'denied at terminal',
      };
    },
  };
}
