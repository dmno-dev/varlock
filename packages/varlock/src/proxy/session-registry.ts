import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir, readdir, readFile, rm, writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { getUserVarlockDir } from '../lib/user-config-dir';
import { getAncestorPids } from './process-ancestry';
import type { ProxyEgressMode } from './types';
import {
  PROXY_CHILD_ENV_VAR,
  PROXY_SCHEMA_FINGERPRINT_ENV_VAR,
  PROXY_SESSION_ID_ENV_VAR,
  PROXY_SESSION_UUID_ENV_VAR,
} from './env-vars';

export type ProxySessionRecord = {
  id: string;
  uuid: string;
  ownerPid: number;
  childPid?: number;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  /** Set once the session's process has stopped. A session dir is a durable record; it's marked ended, not deleted. */
  endedAt?: string;
  egressMode: ProxyEgressMode;
  schemaFingerprint?: string;
  placeholderOverrides?: Record<string, string>;
  stats?: ProxySessionStats;
  env: Record<string, string>;
  entryPaths?: Array<string>;
  command?: Array<string>;
};

export type ProxySessionStats = {
  totalRequests: number;
  matchedRequests: number;
  blockedRequests: number;
  lastActivityAt?: string;
};

// Resolved lazily (not a module-load const) so it honors the active
// XDG_CONFIG_HOME / legacy-dir resolution at call time — tests redirect it.
function getSessionsDir(): string {
  return join(getUserVarlockDir(), 'proxy', 'sessions');
}

async function ensureSessionsDir() {
  await mkdir(getSessionsDir(), { recursive: true, mode: 0o700 });
}

/**
 * Per-session directory: the durable record of one run, holding `session.json`
 * plus its co-located `audit.jsonl` and `grants.jsonl`. The audit and grant
 * modules build their paths off this so everything for a session lives together
 * and survives the process (cleaned up deliberately, never on stop).
 */
export function getProxySessionDir(uuid: string): string {
  return join(getSessionsDir(), uuid);
}

function getSessionFilePath(uuid: string): string {
  return join(getProxySessionDir(uuid), 'session.json');
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomShortId(length = 5): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  while (out.length < length) {
    const byte = crypto.randomBytes(1)[0]!;
    out += alphabet[byte % alphabet.length];
  }
  return out;
}

function parseSessionRecord(raw: string, filePath: string): ProxySessionRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ProxySessionRecord>;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (!parsed.uuid || !parsed.id || !parsed.ownerPid) return undefined;
    if (!parsed.cwd || !parsed.startedAt || !parsed.updatedAt) return undefined;
    if (!parsed.egressMode || !parsed.env) return undefined;

    return {
      id: String(parsed.id),
      uuid: String(parsed.uuid),
      ownerPid: Number(parsed.ownerPid),
      ...(parsed.childPid ? { childPid: Number(parsed.childPid) } : {}),
      cwd: String(parsed.cwd),
      startedAt: String(parsed.startedAt),
      updatedAt: String(parsed.updatedAt),
      ...(parsed.endedAt ? { endedAt: String(parsed.endedAt) } : {}),
      egressMode: parsed.egressMode as ProxyEgressMode,
      ...(parsed.schemaFingerprint ? { schemaFingerprint: String(parsed.schemaFingerprint) } : {}),
      ...(parsed.placeholderOverrides && typeof parsed.placeholderOverrides === 'object'
        ? {
          placeholderOverrides: Object.fromEntries(
            Object.entries(parsed.placeholderOverrides as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          ),
        }
        : {}),
      ...(parsed.stats && typeof parsed.stats === 'object'
        ? {
          stats: {
            totalRequests: Number((parsed.stats as any).totalRequests ?? 0),
            matchedRequests: Number((parsed.stats as any).matchedRequests ?? 0),
            blockedRequests: Number((parsed.stats as any).blockedRequests ?? 0),
            ...((parsed.stats as any).lastActivityAt
              ? { lastActivityAt: String((parsed.stats as any).lastActivityAt) }
              : {}),
          },
        }
        : {}),
      env: Object.fromEntries(
        Object.entries(parsed.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      ),
      ...(Array.isArray(parsed.entryPaths)
        ? { entryPaths: parsed.entryPaths.map((v) => String(v)) }
        : {}),
      ...(Array.isArray(parsed.command)
        ? { command: parsed.command.map((v) => String(v)) }
        : {}),
    };
  } catch {
    rm(filePath, { force: true }).catch(() => undefined);
    return undefined;
  }
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === 'EPERM';
  }
}

/**
 * List proxy session records. By default returns only **active** sessions —
 * not ended and with a live owner process. Pass `{ includeEnded: true }` to
 * include the durable records of stopped sessions (e.g. `proxy status --all`).
 */
export async function listProxySessions(opts?: {
  includeEnded?: boolean;
}): Promise<Array<ProxySessionRecord>> {
  await ensureSessionsDir();

  const sessionsDir = getSessionsDir();
  const dirEntries = await readdir(sessionsDir, { withFileTypes: true });
  const sessions: Array<ProxySessionRecord> = [];

  for (const dirEntry of dirEntries) {
    if (!dirEntry.isDirectory()) continue;
    const filePath = join(sessionsDir, dirEntry.name, 'session.json');
    const raw = await readFile(filePath, 'utf8').catch(() => undefined);
    if (!raw) continue;

    const parsed = parseSessionRecord(raw, filePath);
    if (!parsed) continue;

    if (!opts?.includeEnded) {
      if (parsed.endedAt) continue;
      if (!isProcessRunning(parsed.ownerPid)) continue;
    }

    sessions.push(parsed);
  }

  return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * Mark a session ended (stamp `endedAt`) while keeping its directory and the
 * co-located audit/grants as a durable record. Idempotent: a session already
 * marked ended is left as-is. Reads the file directly by uuid so it works even
 * after the owner process has died (when the active-only listing wouldn't find it).
 */
export async function markProxySessionEnded(uuid: string) {
  const filePath = getSessionFilePath(uuid);
  const raw = await readFile(filePath, 'utf8').catch(() => undefined);
  if (!raw) return;
  const existing = parseSessionRecord(raw, filePath);
  if (!existing || existing.endedAt) return;
  const ts = nowIso();
  const next: ProxySessionRecord = { ...existing, endedAt: ts, updatedAt: ts };
  await writeFile(filePath, JSON.stringify(next, null, 2), { mode: 0o600 });
}

/**
 * Mark any session whose owner process has died (but wasn't marked ended — e.g.
 * a hard kill that skipped the graceful cleanup) as ended, so the active list
 * stays accurate. The record and its co-located audit/grants are kept.
 */
export async function cleanupStaleProxySessions() {
  const all = await listProxySessions({ includeEnded: true });
  for (const session of all) {
    if (!session.endedAt && !isProcessRunning(session.ownerPid)) {
      await markProxySessionEnded(session.uuid);
    }
  }
}

export async function reserveProxySessionIdentity(): Promise<{ id: string; uuid: string }> {
  const sessions = await listProxySessions();
  const usedIds = new Set(sessions.map((s) => s.id));
  let id = randomShortId(5);
  while (usedIds.has(id)) id = randomShortId(6);
  const uuid = crypto.randomUUID();
  return { id, uuid };
}

export async function createProxySessionRecord(session: Omit<ProxySessionRecord, 'updatedAt'>) {
  await mkdir(getProxySessionDir(session.uuid), { recursive: true, mode: 0o700 });
  const next: ProxySessionRecord = {
    ...session,
    updatedAt: nowIso(),
  };
  await writeFile(getSessionFilePath(next.uuid), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export async function getProxySessionByToken(token: string): Promise<ProxySessionRecord | undefined> {
  const sessions = await listProxySessions();
  const direct = sessions.find((s) => s.uuid === token || s.id === token);
  return direct;
}

/**
 * Resolve the proxy session the current process is running under, if any.
 *
 * Tries the explicit env-injected session token first (fast path), then falls
 * back to **process ancestry** — matching a running session's ownerPid/childPid
 * against this process's parent chain. The ancestry check is what makes the
 * guards robust: a child can't escape by clearing `__VARLOCK_PROXY_CHILD`,
 * because its place in the proxy's process tree is not something it controls.
 *
 * Returns undefined cheaply when there are no active sessions (the common case),
 * so the ancestry walk only runs when a proxy session actually exists.
 */
export async function resolveActiveProxySession(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProxySessionRecord | undefined> {
  // Fast exit for the common case (proxy never used): don't create or read the
  // sessions dir on every varlock invocation.
  if (!existsSync(getSessionsDir())) return undefined;

  const sessions = await listProxySessions();
  if (!sessions.length) return undefined;

  const sessionToken = env[PROXY_SESSION_ID_ENV_VAR] ?? env[PROXY_SESSION_UUID_ENV_VAR];
  if (sessionToken) {
    const byToken = sessions.find((s) => s.uuid === sessionToken || s.id === sessionToken);
    if (byToken) return byToken;
  }

  const ancestors = new Set(getAncestorPids());
  return sessions.find(
    (s) => ancestors.has(s.ownerPid) || (s.childPid !== undefined && ancestors.has(s.childPid)),
  );
}

export async function getProxyPlaceholderOverridesForEnv(env: NodeJS.ProcessEnv = process.env) {
  const session = await resolveActiveProxySession(env);
  if (!session?.placeholderOverrides) return undefined;
  return session.placeholderOverrides;
}

export async function updateProxySessionRecord(
  uuid: string,
  patch: Partial<Omit<ProxySessionRecord, 'uuid' | 'id'>>,
): Promise<ProxySessionRecord | undefined> {
  const existing = await getProxySessionByToken(uuid);
  if (!existing) return undefined;
  const next: ProxySessionRecord = {
    ...existing,
    ...patch,
    updatedAt: nowIso(),
  };
  await writeFile(getSessionFilePath(existing.uuid), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export async function resolveProxySessionForCommand(opts?: {
  explicitSession?: string;
  env?: NodeJS.ProcessEnv;
  defaultToSingleActive?: boolean;
}): Promise<ProxySessionRecord> {
  await cleanupStaleProxySessions();

  const explicit = opts?.explicitSession?.trim();
  if (explicit) {
    const byToken = await getProxySessionByToken(explicit);
    if (!byToken) {
      throw new Error(`Proxy session "${explicit}" not found.`);
    }
    return byToken;
  }

  const envSessionId = opts?.env?.[PROXY_SESSION_ID_ENV_VAR];
  if (envSessionId) {
    const byEnvId = await getProxySessionByToken(envSessionId);
    if (byEnvId) return byEnvId;
  }

  const envSessionUuid = opts?.env?.[PROXY_SESSION_UUID_ENV_VAR];
  if (envSessionUuid) {
    const byEnvUuid = await getProxySessionByToken(envSessionUuid);
    if (byEnvUuid) return byEnvUuid;
  }

  if (opts?.defaultToSingleActive === false) {
    throw new Error('No proxy session selected. Pass --session <id>.');
  }

  const sessions = await listProxySessions();
  if (sessions.length === 1) return sessions[0]!;
  if (sessions.length === 0) {
    throw new Error('No active proxy sessions.');
  }

  const ids = sessions.map((s) => `${s.id}`).join(', ');
  throw new Error(`Multiple active proxy sessions (${ids}). Pass --session <id>.`);
}

export function getProxySessionExportEnv(session: ProxySessionRecord): Record<string, string> {
  const env = {
    ...session.env,
    [PROXY_CHILD_ENV_VAR]: '1',
    [PROXY_SESSION_ID_ENV_VAR]: session.id,
    [PROXY_SESSION_UUID_ENV_VAR]: session.uuid,
  } as Record<string, string>;

  if (session.schemaFingerprint) {
    env[PROXY_SCHEMA_FINGERPRINT_ENV_VAR] = session.schemaFingerprint;
  }

  return env;
}
