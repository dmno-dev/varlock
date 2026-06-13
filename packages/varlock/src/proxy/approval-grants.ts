import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  appendFile, mkdir, readFile, rm,
} from 'node:fs/promises';
import { join } from 'node:path';

import { getUserVarlockDir } from '../lib/user-config-dir';
import { clampLifetime, type ApprovalProvider } from './approval';

/**
 * A standing approval grant: the approver's choice to extend an interactive
 * approval to *future* requests with the same grant key, for a lifetime. Holds
 * no secret values. Stored per session so it can't outlive its session and
 * cleans up trivially. The file is the source of truth (read on each
 * require-approval), which is what lets an external approver (the future phone /
 * native app) write a grant the proxy immediately honors.
 */
export type ApprovalGrant = {
  id: string;
  /** Match key: rule + granularity (`each`). The actual lookup key. */
  grantKey: string;
  /** The approve-rule (describeRule) — for display/audit. */
  ruleId: string;
  /** For display/audit; the rule already constrains host/path/method. */
  host: string;
  kind: 'session' | 'duration';
  /** Epoch ms; required for `duration` kind. */
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
  if (grant.kind === 'session') return true;
  if (grant.kind === 'duration') return typeof grant.expiresAt === 'number' && now < grant.expiresAt;
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
        grantKey: grant.grantKey,
        ruleId: grant.ruleId,
        host: grant.host,
        kind: grant.kind,
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
    /** The first still-valid grant for `grantKey`, or undefined. */
    async findMatch(grantKey: string): Promise<ApprovalGrant | undefined> {
      const now = Date.now();
      return (await list()).find((g) => g.grantKey === grantKey && isGrantValid(g, now));
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
 * store: honor an existing grant for the request's grant key without prompting,
 * and persist a new grant when the approver chooses a lifetime beyond `once`.
 * The chosen lifetime is **clamped to the rule's `maxDuration`** before storing,
 * so no approver can exceed the schema-set ceiling (`maxDurationMs===0` ⇒ never
 * remembered — always ask). This is the seam where remembering decisions is
 * decoupled from making them.
 */
export function createGrantingApprovalProvider(opts: {
  inner: ApprovalProvider;
  store: ApprovalGrantStore;
  grantedBy?: string;
}): ApprovalProvider {
  return {
    async requestApproval(req) {
      // Always-ask rules (maxDurationMs===0) never honor or store grants.
      const grantsAllowed = req.grantKey !== undefined && req.maxDurationMs !== 0;

      if (grantsAllowed && req.grantKey) {
        const grant = await opts.store.findMatch(req.grantKey);
        if (grant) {
          return {
            approved: true,
            nonce: req.nonce,
            lifetime: { kind: 'once' }, // already persisted; don't re-store
            reason: `auto-approved by ${grant.kind} grant (${grant.grantedBy})`,
          };
        }
      }

      const decision = await opts.inner.requestApproval(req);

      if (decision.approved && grantsAllowed && req.grantKey) {
        const lifetime = clampLifetime(decision.lifetime, req.maxDurationMs);
        if (lifetime.kind !== 'once') {
          await opts.store.add({
            grantKey: req.grantKey,
            ruleId: req.ruleId ?? '',
            host: req.host,
            kind: lifetime.kind === 'session' ? 'session' : 'duration',
            grantedBy: opts.grantedBy ?? 'tty',
            ...(lifetime.kind === 'duration' ? { expiresAt: Date.now() + lifetime.durationMs } : {}),
          });
        }
      }

      return decision;
    },
  };
}
