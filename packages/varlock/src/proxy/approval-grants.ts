import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  appendFile, mkdir, readFile, rm,
} from 'node:fs/promises';
import { join } from 'node:path';

import { getUserVarlockDir } from '../lib/user-config-dir';
import type { ApprovalProvider } from './approval';

/**
 * A standing approval grant: the approver's choice to extend an interactive
 * approval to *future* requests matching the same policy rule, for a scope.
 * Holds no secret values. Stored per session so it can't outlive its session and
 * cleans up trivially. The file is the source of truth (read on each
 * require-approval), which is what lets an external approver (the future phone /
 * native app) write a grant the proxy immediately honors.
 */
export type ApprovalGrant = {
  id: string;
  /** The approve-rule (describeRule) this grant covers — the match key. */
  ruleId: string;
  /** For display/audit; the rule already constrains host/path/method. */
  host: string;
  scope: 'session' | 'duration';
  /** Epoch ms; required for `duration` scope. */
  expiresAt?: number;
  grantedAt: string;
  /** Provenance — `tty` now, `phone`/`app` later. */
  grantedBy: string;
};

function grantsDir(): string {
  return join(getUserVarlockDir(), 'proxy', 'grants');
}

export function getGrantFilePath(sessionUuid: string): string {
  return join(grantsDir(), `${sessionUuid}.jsonl`);
}

function isGrantValid(grant: ApprovalGrant, now: number): boolean {
  if (grant.scope === 'session') return true;
  if (grant.scope === 'duration') return typeof grant.expiresAt === 'number' && now < grant.expiresAt;
  return false;
}

/** File-backed, append-only grant store scoped to one proxy session. */
export function createApprovalGrantStore(sessionUuid: string) {
  const filePath = getGrantFilePath(sessionUuid);

  const list = async (): Promise<Array<ApprovalGrant>> => {
    if (!existsSync(filePath)) return [];
    const raw = await readFile(filePath, 'utf8');
    const grants: Array<ApprovalGrant> = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        grants.push(JSON.parse(trimmed) as ApprovalGrant);
      } catch {
        // skip a torn line rather than fail the whole read
      }
    }
    return grants;
  };

  return {
    filePath,
    list,
    /** Append a grant. Best-effort: never throws (grant persistence must not break the proxy). */
    async add(grant: Omit<ApprovalGrant, 'id' | 'grantedAt'> & { id?: string; grantedAt?: string }): Promise<ApprovalGrant> {
      const full: ApprovalGrant = {
        id: grant.id ?? randomBytes(8).toString('hex'),
        grantedAt: grant.grantedAt ?? new Date().toISOString(),
        ruleId: grant.ruleId,
        host: grant.host,
        scope: grant.scope,
        grantedBy: grant.grantedBy,
        ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
      };
      try {
        await mkdir(grantsDir(), { recursive: true, mode: 0o700 });
        await appendFile(filePath, `${JSON.stringify(full)}\n`, { mode: 0o600 });
      } catch {
        // best-effort
      }
      return full;
    },
    /** The first still-valid grant covering `ruleId`, or undefined. */
    async findMatch(ruleId: string): Promise<ApprovalGrant | undefined> {
      const now = Date.now();
      return (await list()).find((g) => g.ruleId === ruleId && isGrantValid(g, now));
    },
    /** Remove the session's grant file (called on session stop). */
    async destroy(): Promise<void> {
      await rm(filePath, { force: true }).catch(() => undefined);
    },
  };
}

export type ApprovalGrantStore = ReturnType<typeof createApprovalGrantStore>;

/**
 * Wrap a base approval provider (TTY now, phone later) with a standing-grant
 * store: honor an existing grant for the request's rule without prompting, and
 * persist a new grant when the approver chooses a `session`/`duration` scope.
 * This is the seam where remembering decisions is decoupled from making them.
 */
export function createGrantingApprovalProvider(opts: {
  inner: ApprovalProvider;
  store: ApprovalGrantStore;
  grantedBy?: string;
}): ApprovalProvider {
  return {
    async requestApproval(req) {
      if (req.ruleId) {
        const grant = await opts.store.findMatch(req.ruleId);
        if (grant) {
          return {
            approved: true,
            nonce: req.nonce,
            scope: { kind: 'once' }, // already persisted; don't re-store
            reason: `auto-approved by ${grant.scope} grant (${grant.grantedBy})`,
          };
        }
      }

      const decision = await opts.inner.requestApproval(req);

      if (decision.approved && req.ruleId && decision.scope && decision.scope.kind !== 'once') {
        await opts.store.add({
          ruleId: req.ruleId,
          host: req.host,
          scope: decision.scope.kind === 'session' ? 'session' : 'duration',
          grantedBy: opts.grantedBy ?? 'tty',
          ...(decision.scope.kind === 'duration'
            ? { expiresAt: Date.now() + decision.scope.durationMs }
            : {}),
        });
      }

      return decision;
    },
  };
}
