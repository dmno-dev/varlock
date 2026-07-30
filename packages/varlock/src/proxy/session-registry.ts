import crypto from 'node:crypto';
import net from 'node:net';
import { existsSync } from 'node:fs';
import {
  mkdir, readdir, readFile, rename, rm, writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getUserVarlockDir } from '../lib/user-config-dir';
import { getAncestorPids } from './process-ancestry';
import type { ProxyResolutionView } from '../env-graph';
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
  /** A long-lived `proxy start` daemon that can hot-reload its policy on `proxy reload` (via the file reload channel). One-shot `proxy run` sessions are not reloadable. */
  reloadable?: boolean;
  /**
   * Pids of `proxy run` processes that attached to this (shared daemon) session.
   * Ancestry detection matches these so a process under an *attached* run is
   * recognized as proxied even if it scrubs the `__VARLOCK_PROXY_*` env markers —
   * the daemon's `ownerPid` is not in an attached child's ancestor chain, but the
   * attaching `proxy run` process is. Self-owned runs don't need this (their
   * `ownerPid` is already an ancestor). Dead pids are harmless and pruned on read.
   */
  attachedPids?: Array<number>;
  egressMode: ProxyEgressMode;
  /**
   * Bearer credential for the session's `varlock.internal` control endpoint.
   * Deliberately SEPARATE from `uuid`: the uuid is a display identifier (printed
   * by `proxy status`, exported into the child env) while this token is never
   * shown anywhere — it lives only in this 0600 record and the owner's memory,
   * so a pasted status output or shared screen can't leak endpoint access.
   */
  endpointToken?: string;
  /**
   * Per-session data-plane credential, present only when the proxy binds a
   * non-loopback address (so a remote sandbox can reach it). A non-loopback peer
   * must present it as `Proxy-Authorization: Basic base64(varlock:<token>)`;
   * loopback peers are exempt. Like `endpointToken`, never displayed — lives only
   * in this 0600 record and owner memory. `proxy guest-env` embeds it into the
   * guest proxy URL so the sandbox authenticates automatically.
   */
  dataPlaneToken?: string;
  schemaFingerprint?: string;
  /**
   * Sensitive item key → placeholder shown to the child. Covers `@proxy`-managed
   * (wire-injected) items and, by default, every other sensitive item. The child
   * re-resolves these to the placeholder instead of the real value.
   */
  placeholderOverrides?: Record<string, string>;
  /** Keys explicitly `@proxy=omit` — absent from the child env and resolved to undefined. */
  omittedKeys?: Array<string>;
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

/**
 * Write a session record atomically (tmp + rename) so a concurrent reader never
 * sees a half-written file. The daemon rewrites session.json on a debounce as
 * traffic flows, and any varlock invocation reads it — a bare truncate-then-write
 * would expose torn JSON, which `parseSessionRecord` must never delete (doing so
 * would silently drop the live record and let a proxied child re-resolve real
 * secrets). The `.tmp` suffix isn't `session.json`, so `listProxySessions` ignores it.
 */
async function writeSessionRecordAtomic(filePath: string, record: ProxySessionRecord): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  await rename(tmp, filePath);
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomShortId(length = 5): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  // crypto.randomInt is uniform; mapping raw random bytes with `% alphabet.length`
  // would bias the first few characters. This is a human-friendly handle (the real
  // session token is the crypto.randomUUID() `uuid`), but an unbiased id costs nothing.
  let out = '';
  while (out.length < length) {
    out += alphabet[crypto.randomInt(alphabet.length)];
  }
  return out;
}

function parseSessionRecord(raw: string): ProxySessionRecord | undefined {
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
      ...(parsed.reloadable ? { reloadable: true } : {}),
      ...(Array.isArray(parsed.attachedPids)
        ? { attachedPids: parsed.attachedPids.map((v) => Number(v)).filter((n) => Number.isFinite(n)) }
        : {}),
      egressMode: parsed.egressMode as ProxyEgressMode,
      ...(parsed.endpointToken ? { endpointToken: String(parsed.endpointToken) } : {}),
      ...(parsed.dataPlaneToken ? { dataPlaneToken: String(parsed.dataPlaneToken) } : {}),
      ...(parsed.schemaFingerprint ? { schemaFingerprint: String(parsed.schemaFingerprint) } : {}),
      ...(parsed.placeholderOverrides && typeof parsed.placeholderOverrides === 'object'
        ? {
          placeholderOverrides: Object.fromEntries(
            Object.entries(parsed.placeholderOverrides as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          ),
        }
        : {}),
      ...(Array.isArray(parsed.omittedKeys)
        ? { omittedKeys: parsed.omittedKeys.map((v) => String(v)) }
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
    // Skip an unparseable record — never delete it. Writes are atomic (tmp +
    // rename), so a reader sees either the old or the new complete file; a parse
    // failure therefore means genuine corruption, not a torn read. Deleting here
    // would be far worse than leaving it: dropping a still-live record removes the
    // proxy's placeholder/omit overlay and lets a proxied child re-resolve REAL
    // secrets. A genuinely corrupt orphan just lingers (a rare, harmless disk
    // leak) rather than risking a secret leak.
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

/** The loopback port a session's proxy listens on (from `HTTPS_PROXY=http://127.0.0.1:PORT`). */
export function getProxySessionPort(session: ProxySessionRecord): number | undefined {
  const url = session.env?.HTTPS_PROXY ?? session.env?.https_proxy;
  if (!url) return undefined;
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves true if something is accepting connections on the loopback port. */
function isPortAccepting(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Authoritative liveness for a session. A bare pid check (`isProcessRunning`) is
 * fooled by **PID reuse**: when a proxy dies, the OS can recycle its pid to an
 * unrelated process and the record then looks "active" forever (a ghost). We
 * also probe the session's proxy port — a dead proxy isn't listening, so the
 * ghost is caught. Both must hold (pid recycled AND that random high port
 * re-bound by something else is vanishingly unlikely).
 */
export async function isProxySessionAlive(session: ProxySessionRecord): Promise<boolean> {
  if (session.endedAt) return false;
  if (!isProcessRunning(session.ownerPid)) return false;
  const port = getProxySessionPort(session);
  if (port == null) return true; // no port to probe (older record) — trust the pid
  return isPortAccepting(port);
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

    const parsed = parseSessionRecord(raw);
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
  const existing = parseSessionRecord(raw);
  if (!existing || existing.endedAt) return;
  const ts = nowIso();
  const next: ProxySessionRecord = { ...existing, endedAt: ts, updatedAt: ts };
  await writeSessionRecordAtomic(filePath, next);
}

/**
 * Mark any session whose owner process has died (but wasn't marked ended — e.g.
 * a hard kill that skipped the graceful cleanup) as ended, so the active list
 * stays accurate. The record and its co-located audit/grants are kept.
 */
export async function cleanupStaleProxySessions() {
  const all = await listProxySessions({ includeEnded: true });
  await Promise.all(all.map(async (session) => {
    if (session.endedAt) return;
    if (await isProxySessionAlive(session)) return;
    await markProxySessionEnded(session.uuid);
  }));
}

/**
 * Permanently delete a single session's directory (record + audit + grants) by
 * uuid. Used to clean up one specific session; callers ensure it isn't live.
 */
export async function deleteProxySession(uuid: string): Promise<void> {
  await rm(getProxySessionDir(uuid), { recursive: true, force: true });
}

/**
 * Permanently delete the durable directories of ended sessions (record + audit +
 * grants). Active sessions are never touched. Returns the ids removed. Optional
 * `olderThanMs` keeps recent history (e.g. prune only sessions ended > 24h ago).
 */
export async function pruneEndedProxySessions(opts?: { olderThanMs?: number }): Promise<Array<string>> {
  const all = await listProxySessions({ includeEnded: true });
  const cutoff = opts?.olderThanMs != null ? Date.now() - opts.olderThanMs : undefined;
  const removed: Array<string> = [];
  for (const session of all) {
    if (!session.endedAt) continue;
    if (cutoff != null && new Date(session.endedAt).getTime() > cutoff) continue;
    await deleteProxySession(session.uuid).catch(() => undefined);
    removed.push(session.id);
  }
  return removed;
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
  await writeSessionRecordAtomic(getSessionFilePath(next.uuid), next);
  return next;
}

export async function getProxySessionByToken(
  token: string,
  opts?: { includeEnded?: boolean },
): Promise<ProxySessionRecord | undefined> {
  // Default active-only (callers like env/reload act on live sessions). Explicit
  // lookups (stop/prune by id) pass includeEnded so you can always target a
  // record by its id — including a ghost cleanup just marked ended.
  const sessions = await listProxySessions({ includeEnded: opts?.includeEnded });
  return sessions.find((s) => s.uuid === token || s.id === token);
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
    (s) => ancestors.has(s.ownerPid)
      || (s.childPid !== undefined && ancestors.has(s.childPid))
      || (s.attachedPids?.some((pid) => ancestors.has(pid)) ?? false),
  );
}

/**
 * Memoized authoritative "what proxy session is this process running under?".
 * Proxy-child status is invariant for a process's lifetime (its place in the
 * process tree and its injected env don't change), so we resolve it at most once
 * per process for the real `process.env` path — the ancestry walk can spawn `ps`
 * on non-Linux, so repeating it on every guard/load would be wasteful. Explicit
 * `env` args (tests) bypass the cache so each scenario resolves fresh.
 *
 * This is the single seam every consumer (context guard, fingerprint guard,
 * load-graph placeholder/omit view) should use, so detection lives in one place.
 */
let memoizedDefaultSession: Promise<ProxySessionRecord | undefined> | undefined;

export async function getActiveProxySession(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProxySessionRecord | undefined> {
  if (env !== process.env) return resolveActiveProxySession(env);
  memoizedDefaultSession ??= resolveActiveProxySession(env).catch((err) => {
    // Don't cache a rejection — allow a later call to retry.
    memoizedDefaultSession = undefined;
    throw err;
  });
  return memoizedDefaultSession;
}

/** Test-only: clear the per-process memoized detection result. */
export function resetActiveProxySessionCache() {
  memoizedDefaultSession = undefined;
}

/**
 * Whether this process is running inside a proxy session. The injected env marker
 * is the fast path; the session token and process ancestry (via
 * `getActiveProxySession`) are the authoritative fallbacks a child can't shed by
 * clearing `__VARLOCK_PROXY_CHILD`.
 */
export async function isProxyChildContext(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env[PROXY_CHILD_ENV_VAR] === '1') return true;
  return !!(await getActiveProxySession(env));
}

/**
 * The proxy-child resolution view for the active session: each placeholder key →
 * a placeholder directive, each omitted key → an omit directive. Consumed by
 * `load-graph` to force sensitive items to placeholders (or unset) during a
 * proxied re-resolution. Returns undefined outside a proxy context.
 */
export async function getProxyResolutionViewForEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProxyResolutionView | undefined> {
  const session = await getActiveProxySession(env);
  if (!session) return undefined;
  const view: ProxyResolutionView = {};
  for (const [key, value] of Object.entries(session.placeholderOverrides ?? {})) {
    view[key] = { kind: 'placeholder', value };
  }
  for (const key of session.omittedKeys ?? []) {
    view[key] = { kind: 'omit' };
  }
  return Object.keys(view).length ? view : undefined;
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
  await writeSessionRecordAtomic(getSessionFilePath(existing.uuid), next);
  return next;
}

/**
 * Register an attaching `proxy run` process pid on a (shared daemon) session so
 * ancestry detection recognizes processes under that run. Read-modify-write on
 * the shared record; concurrent attaches race but that's tolerable for the local
 * single-user MVP. Dead pids are pruned here.
 */
export async function addProxySessionAttachment(uuid: string, pid: number) {
  const existing = await getProxySessionByToken(uuid);
  if (!existing) return;
  const live = (existing.attachedPids ?? []).filter((p) => isProcessRunning(p));
  const next = Array.from(new Set([...live, pid]));
  await updateProxySessionRecord(uuid, { attachedPids: next });
}

export async function removeProxySessionAttachment(uuid: string, pid: number) {
  const existing = await getProxySessionByToken(uuid);
  if (!existing?.attachedPids) return;
  const next = existing.attachedPids.filter((p) => p !== pid && isProcessRunning(p));
  await updateProxySessionRecord(uuid, { attachedPids: next });
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
