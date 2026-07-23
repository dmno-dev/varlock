import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getProxySessionDir } from './session-registry';

/** The security decision the proxy reached for a single request. */
export type ProxyAuditDecision = | 'allow' // forwarded upstream (a secret may or may not have been injected)
  | 'deny' // matched a `block` rule — never reached upstream
  | 'blocked-egress' // strict egress mode rejected a non-allowlisted host
  | 'blocked-uninjected' // request carried a placeholder no rule injects on this route (misconfig)
  | 'blocked-cleartext' // refused to inject a secret into a non-TLS connection
  | 'blocked-location' // placeholder appeared in a request location the rule doesn't allow substituting in
  | 'blocked-occurrences' // placeholder appeared more times than the rule's occurrence cap allows
  | 'approval-granted' // require-approval rule matched and the approver allowed it
  | 'approval-denied'; // require-approval rule matched and approval was denied/timed-out

/**
 * Structured per-request activity emitted by the proxy runtime. It carries
 * everything the audit log needs but **never** a secret value: `path`/`url` are
 * the child's *placeholder-form* request (injection happens after this is
 * emitted), and `injectedKeys` are item keys (names), not values.
 */
export type ProxyActivity = {
  /** Whether the host matched a configured `@proxy` rule. */
  matched: boolean;
  /** Whether the request was blocked (egress, policy, or cleartext guard). */
  blocked: boolean;
  host: string;
  method: string;
  /** Path only, no query string, in placeholder form. */
  path: string;
  /** Full path + query in placeholder form — used only to compute the fingerprint hash. */
  url?: string;
  decision: ProxyAuditDecision;
  /** Stable descriptor of the matched rule (see `describeRule`), if any. */
  ruleId?: string;
  /** Keys (names, never values) of the managed items actually injected into this request. */
  injectedKeys?: Array<string>;
};

/** First line of every audit file — makes the file self-describing after the session record is gone. */
export type ProxyAuditHeader = {
  type: 'session-start';
  ts: string;
  id: string;
  uuid: string;
  cwd: string;
  egressMode: string;
  command?: Array<string>;
};

/** One persisted request line in the audit log. Holds no secret values or raw bodies. */
export type ProxyAuditEntry = {
  type: 'request';
  ts: string;
  host: string;
  method: string;
  /** Path only, no query, placeholder form. */
  path: string;
  /** sha256 of `${method} ${host} ${url}` (placeholder form) — a stable request fingerprint. */
  requestHash: string;
  decision: ProxyAuditDecision;
  matched: boolean;
  injected: boolean;
  injectedKeys?: Array<string>;
  ruleId?: string;
};

export type ProxyAuditLine = ProxyAuditHeader | ProxyAuditEntry;

// Resolved lazily (not a module-load const) so it honors the active
// XDG_CONFIG_HOME / legacy-dir resolution at call time. Co-located in the
// session's directory so a session's audit travels with its record.
export function getProxyAuditFilePath(uuid: string): string {
  return join(getProxySessionDir(uuid), 'audit.jsonl');
}

/** Stable request fingerprint. Inputs are placeholder-form, so this hashes no secret. */
export function hashRequest(method: string, host: string, url: string): string {
  return createHash('sha256').update(`${method} ${host} ${url}`).digest('hex');
}

function activityToEntry(activity: ProxyActivity, ts: string): ProxyAuditEntry {
  const injectedKeys = activity.injectedKeys?.length ? activity.injectedKeys : undefined;
  return {
    type: 'request',
    ts,
    host: activity.host,
    method: activity.method,
    path: activity.path,
    requestHash: hashRequest(activity.method, activity.host, activity.url ?? activity.path),
    decision: activity.decision,
    matched: activity.matched,
    injected: !!injectedKeys,
    ...(injectedKeys ? { injectedKeys } : {}),
    ...(activity.ruleId ? { ruleId: activity.ruleId } : {}),
  };
}

/**
 * Append-only JSONL audit log for one proxy session (Invariant #7). Writes are
 * serialized through a promise chain so concurrent requests can't interleave
 * partial lines, and every failure is swallowed and disables further writes —
 * audit logging must never crash or stall the proxy hot path. Holds no secrets.
 */
export function createProxyAuditLog(uuid: string, header?: Omit<ProxyAuditHeader, 'type'>) {
  const filePath = getProxyAuditFilePath(uuid);
  let chain: Promise<void> = Promise.resolve();
  let disabled = false;

  const enqueue = (line: ProxyAuditLine) => {
    chain = chain.then(async () => {
      if (disabled) return;
      try {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        await appendFile(filePath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      } catch {
        disabled = true; // never let audit I/O break the proxy
      }
    });
  };

  if (header) enqueue({ type: 'session-start', ...header });

  return {
    filePath,
    /** Record a request's decision. Returns immediately; the write is queued. */
    record(activity: ProxyActivity) {
      enqueue(activityToEntry(activity, new Date().toISOString()));
    },
    /** Resolve once all queued writes have flushed to disk. */
    async flush() {
      await chain;
    },
  };
}

export type ProxyAuditLog = ReturnType<typeof createProxyAuditLog>;

/** Read and parse a session's audit log, skipping any malformed lines. Empty if none exists. */
export async function readProxyAuditLines(uuid: string): Promise<Array<ProxyAuditLine>> {
  const filePath = getProxyAuditFilePath(uuid);
  if (!existsSync(filePath)) return [];
  const raw = await readFile(filePath, 'utf8');
  const lines: Array<ProxyAuditLine> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as ProxyAuditLine);
    } catch {
      // skip a torn/partial trailing line rather than fail the whole read
    }
  }
  return lines;
}
