import path from 'node:path';

import { define } from 'gunshi';
import { gracefulExit } from 'exit-hook';

import { exec } from '../../lib/exec';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { startLocalProxyRuntime, type ProxyResponseInfo } from '../../proxy/runtime-proxy';
import {
  createProxyAuditLog,
  readProxyAuditLines,
  type ProxyActivity,
  type ProxyAuditEntry,
  type ProxyAuditLog,
} from '../../proxy/audit';
import {
  createAutoDenyApprovalProvider,
  createTtyApprovalProvider,
  type ApprovalProvider,
} from '../../proxy/approval';
import {
  createApprovalGrantStore,
  createGrantingApprovalProvider,
  type ApprovalGrantStore,
} from '../../proxy/approval-grants';
import {
  addProxySessionAttachment,
  cleanupStaleProxySessions,
  createProxySessionRecord,
  markProxySessionEnded,
  getProxySessionByToken,
  getProxySessionExportEnv,
  isProcessRunning,
  listProxySessions,
  removeProxySessionAttachment,
  reserveProxySessionIdentity,
  resolveProxySessionForCommand,
  updateProxySessionRecord,
  type ProxySessionStats,
  type ProxySessionRecord,
} from '../../proxy/session-registry';
import {
  PROXY_PARENT_PID_ENV_VAR,
} from '../../proxy/env-vars';
import {
  newReloadRequestId,
  readReloadRequest,
  readReloadResult,
  writeReloadRequest,
  writeReloadResult,
  type ProxyReloadResult,
} from '../../proxy/reload-channel';
import type { ProxyManagedItem, ProxyRule } from '../../proxy/types';
import { generateProxyPlaceholderForItem } from '../../proxy/placeholder';
import { isVarlockReservedKey } from '../../env-graph/lib/reserved-vars';
import { resetRedactionMap } from '../../runtime/env';
import { createRedactedStreamWriter } from '../../runtime/lib/redact-stream';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import {
  checkForConfigErrors,
  checkForNoEnvFiles,
  checkForSchemaErrors,
} from '../helpers/error-checks';
import { buildProxySchemaFingerprint } from '../helpers/proxy-schema-fingerprint';

export const commandSpec = define({
  name: 'proxy',
  description: 'Manage proxy sessions for placeholder-based agent workflows',
  args: {
    session: {
      type: 'string',
      short: 's',
      description: 'Proxy session ID/alias',
    },
    all: {
      type: 'boolean',
      description: 'Target all sessions (supported by stop/status)',
    },
    format: {
      type: 'string',
      short: 'f',
      description: 'Output format: `proxy env` → shell (default) or json; `proxy audit` → text (default) or json',
    },
    watch: {
      type: 'boolean',
      description: 'Continuously refresh status output (used by `proxy status`).',
    },
    interval: {
      type: 'string',
      description: 'Polling interval in milliseconds for `proxy status --watch` (default: 1000).',
    },
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file or directory to use as the entry point (can be specified multiple times)',
    },
    'no-redact-stdout': {
      type: 'boolean',
      description: 'Disable stdout/stderr redaction and use stdio inherit for full TTY pass-through',
    },
    inject: {
      type: 'string',
      short: 'i',
      description: 'Control what gets injected into child env for `proxy run`: "all" (default), "vars", or "blob"',
    },
    new: {
      type: 'boolean',
      description: 'For `proxy run`: start a fresh proxy instead of attaching to a running one for this directory',
    },
  },
  examples: `
Proxy command surface:
  varlock proxy run -- claude                   # attaches to a running proxy for this dir, else starts one
  varlock proxy run --session abc12 -- claude   # attach to a specific session (approvals prompt in its terminal)
  varlock proxy run --new -- claude             # force a fresh, separate proxy
  varlock proxy start
  varlock proxy env --session abc12
  varlock proxy status
  varlock proxy audit --session abc12
  varlock proxy refresh --session abc12
  varlock proxy stop --session abc12
  varlock proxy stop --all
  `.trim(),
});

type PreparedProxyPolicy = {
  resolvedEnv: Record<string, string>;
  serializedGraph: any;
  schemaFingerprint: string;
  proxyManagedItems: Array<ProxyManagedItem>;
  proxyRules: Array<ProxyRule>;
  egressMode: 'permissive' | 'strict';
  /**
   * Every sensitive item key → the placeholder the child sees (managed/wire items
   * plus every other sensitive item, which gets a placeholder by default). Stored
   * on the session so a proxied re-resolution yields the same placeholders.
   */
  placeholderByKey: Record<string, string>;
  /** Keys explicitly `@proxy=omit` — withheld from the child env entirely. */
  omittedKeys: Array<string>;
};

const EMPTY_PROXY_SESSION_STATS: ProxySessionStats = {
  totalRequests: 0,
  matchedRequests: 0,
  blockedRequests: 0,
};

function cloneSessionStats(stats?: ProxySessionStats): ProxySessionStats {
  return {
    totalRequests: stats?.totalRequests ?? 0,
    matchedRequests: stats?.matchedRequests ?? 0,
    blockedRequests: stats?.blockedRequests ?? 0,
    ...(stats?.lastActivityAt ? { lastActivityAt: stats.lastActivityAt } : {}),
  };
}

function createSessionStatsWriter(sessionUuid: string, initial?: ProxySessionStats) {
  const stats = cloneSessionStats(initial);
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const flush = async () => {
    if (stopped) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    await updateProxySessionRecord(sessionUuid, {
      stats: cloneSessionStats(stats),
    }).catch(() => undefined);
  };

  const scheduleFlush = () => {
    if (stopped || flushTimer) return;
    flushTimer = setTimeout(() => {
      flush().catch(() => undefined);
    }, 500);
  };

  return {
    stats,
    onActivity(activity: {
      matched: boolean;
      blocked: boolean;
    }) {
      if (stopped) return;
      stats.totalRequests += 1;
      if (activity.matched) stats.matchedRequests += 1;
      if (activity.blocked) stats.blockedRequests += 1;
      stats.lastActivityAt = new Date().toISOString();
      scheduleFlush();
    },
    async flushNow() {
      await flush();
    },
    stop() {
      stopped = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    },
  };
}

/** The value-form `@proxy` mode for an item: `@proxy=passthrough` / `@proxy=omit` (or undefined). */
function getProxyValueMode(
  item: { getDec: (name: string) => { resolvedValue?: any } | undefined },
): 'passthrough' | 'omit' | undefined {
  const mode = item.getDec('proxy')?.resolvedValue;
  return mode === 'passthrough' || mode === 'omit' ? mode : undefined;
}

/**
 * The proxy view of the child env, computed from the resolved (real-value) graph:
 *  - `placeholderByKey`: every sensitive item the child should see a placeholder
 *    for — the `@proxy`-managed/wire items plus, by default, every other sensitive
 *    item (least privilege: the agent never sees a real secret unless explicitly
 *    opted in). Managed placeholders are passed in so the two share uniqueness.
 *  - `omittedKeys`: items explicitly marked `@proxy=omit` — withheld entirely.
 *
 * `@proxy=passthrough` and non-sensitive items keep their real values.
 * `_VARLOCK_*` reserved keys are internal infra and never touched.
 */
export async function computeProxyChildView(
  envGraph: Awaited<ReturnType<typeof loadVarlockEnvGraph>>,
  proxyManagedItems: Array<ProxyManagedItem>,
): Promise<{ placeholderByKey: Record<string, string>; omittedKeys: Array<string> }> {
  const managedKeys = new Set(proxyManagedItems.map((item) => item.key));
  const placeholderByKey: Record<string, string> = {};
  for (const item of proxyManagedItems) placeholderByKey[item.key] = item.placeholder;

  // Seed uniqueness with the managed placeholders so default-sensitive placeholders
  // can't collide (collisions would corrupt wire scrubbing).
  const usedPlaceholders = new Set(proxyManagedItems.map((item) => item.placeholder));
  const omittedKeys: Array<string> = [];

  for (const key of envGraph.sortedConfigKeys) {
    if (isVarlockReservedKey(key)) continue;
    if (managedKeys.has(key)) continue;
    const item = envGraph.configSchema[key];
    if (!item || item.resolvedValue === undefined) continue;
    const mode = getProxyValueMode(item);
    if (mode === 'passthrough') continue; // inject the real value
    if (mode === 'omit') {
      omittedKeys.push(key);
      continue;
    }
    if (!item.isSensitive) continue; // non-sensitive with no policy → injected normally
    const { placeholder } = await generateProxyPlaceholderForItem(item, usedPlaceholders);
    placeholderByKey[key] = placeholder; // sensitive default → placeholder
  }

  return { placeholderByKey, omittedKeys };
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function toShellExports(env: Record<string, string>): string {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `export ${k}=${quoteForShell(v)}`)
    .join('\n');
}

function getAction(ctx: any): string {
  const positionals = (ctx.positionals ?? []).slice(ctx.commandPath?.length ?? 0);
  const action = positionals[0];
  if (!action) {
    throw new CliExitError(
      'Missing proxy action.',
      { suggestion: 'Use one of: run, start, env, status, audit, refresh, stop' },
    );
  }
  return action;
}

function getRunCommandArgs(): Array<string> {
  const argv = process.argv.slice(2);
  const doubleDashIndex = argv.indexOf('--');
  if (doubleDashIndex === -1) {
    throw new CliExitError(
      'No command to run. Use `varlock proxy run -- <your-command>`.',
    );
  }
  const rest = argv.slice(doubleDashIndex + 1);
  if (!rest.length) {
    throw new CliExitError(
      'No command to run. Use `varlock proxy run -- <your-command>`.',
    );
  }
  return rest;
}

async function prepareProxyPolicy(entryFilePaths?: Array<string>): Promise<PreparedProxyPolicy> {
  const envGraph = await loadVarlockEnvGraph({
    entryFilePaths,
    // The proxy command manages the session fingerprint itself; don't subject
    // its own loads to the nested-context guard (would block `proxy refresh`).
    skipProxyFingerprintGuard: true,
  });
  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);

  await envGraph.generateTypesIfNeeded();
  await envGraph.resolveEnvValues();
  checkForConfigErrors(envGraph);

  const resolvedEnv = envGraph.getResolvedEnvObject();
  const serializedGraph = envGraph.getSerializedGraph();
  const schemaFingerprint = buildProxySchemaFingerprint(envGraph);
  const proxyManagedItems = await envGraph.getProxyManagedItems();
  const proxyRules = await envGraph.getProxyRules();

  const genericPlaceholderKeys = proxyManagedItems
    .filter((item) => item.placeholderIsGenericFallback)
    .map((item) => item.key);
  if (genericPlaceholderKeys.length) {
    console.error(
      `⚠️  Proxy items using a generic placeholder: ${genericPlaceholderKeys.join(', ')}`,
    );
    console.error(
      '   A generic placeholder may fail an SDK\'s key-format validation (e.g. an `sk-…` prefix check) '
        + 'at client construction. Add an explicit `@placeholder` or a data type with a known format.',
    );
  }

  // Least privilege by default: every sensitive item the child sees is a
  // placeholder (managed/wire items plus the rest), unless explicitly opted out
  // with @proxy=passthrough (real value) or @proxy=omit (withheld entirely).
  const { placeholderByKey, omittedKeys } = await computeProxyChildView(envGraph, proxyManagedItems);

  for (const [key, placeholder] of Object.entries(placeholderByKey)) {
    resolvedEnv[key] = placeholder;
    if (serializedGraph.config[key]) {
      serializedGraph.config[key].value = placeholder;
    }
  }
  for (const key of omittedKeys) {
    delete resolvedEnv[key];
    delete serializedGraph.config[key];
  }

  return {
    resolvedEnv,
    serializedGraph,
    schemaFingerprint,
    proxyManagedItems,
    proxyRules,
    egressMode: serializedGraph.settings?.proxyEgress ?? 'permissive',
    placeholderByKey,
    omittedKeys,
  };
}

// The live request log and an interactive approval prompt share the same TTY
// (stderr). While a prompt is awaiting input, defer log lines so a concurrent
// request can't clobber the readline prompt; flush them once the prompt resolves.
let activeApprovalPrompts = 0;
const deferredProxyLogLines: Array<string> = [];

function emitProxyLog(line: string): void {
  if (activeApprovalPrompts > 0) {
    deferredProxyLogLines.push(line);
    return;
  }
  console.error(line);
}

function flushDeferredProxyLogs(): void {
  if (activeApprovalPrompts > 0) return;
  for (const line of deferredProxyLogLines.splice(0)) console.error(line);
}

/** Wrap an approval provider so the live log defers (rather than corrupts) the TTY while it prompts. */
function guardApprovalPromptForLogging(inner: ApprovalProvider): ApprovalProvider {
  return {
    async requestApproval(req) {
      activeApprovalPrompts += 1;
      try {
        return await inner.requestApproval(req);
      } finally {
        activeApprovalPrompts -= 1;
        flushDeferredProxyLogs();
      }
    },
  };
}

/** A one-line live log of a request decision: `→ POST host/path  inject: KEY` (or `✗ … blocked-egress`). */
function formatProxyRequestLog(a: ProxyActivity): string {
  const arrow = a.blocked ? '✗' : '→';
  const decision = a.decision === 'allow' ? '' : `  ${a.decision}`;
  const inject = a.injectedKeys?.length ? `  inject: ${a.injectedKeys.join(', ')}` : '';
  return `${arrow} ${a.method} ${a.host}${a.path}${decision}${inject}`;
}

/** A one-line live log of a forwarded response: `← POST host/path  200  scrubbed: KEY`. */
function formatProxyResponseLog(info: ProxyResponseInfo): string {
  const scrub = info.scrubbedKeys.length ? `  scrubbed: ${info.scrubbedKeys.join(', ')}` : '';
  const streamed = info.streamed ? ' (streamed)' : '';
  return `← ${info.method} ${info.host}${info.path}  ${info.statusCode}${scrub}${streamed}`;
}

async function createRuntimeAndSession(opts: {
  policy: PreparedProxyPolicy;
  entryPaths?: Array<string>;
  command?: Array<string>;
  approvalProvider: ApprovalProvider;
  /** Persist session/duration approval scopes as standing grants (interactive sessions only). */
  enableApprovalGrants?: boolean;
  /** Mark the session as a hot-reloadable daemon (so `proxy refresh` can reload it). */
  reloadable?: boolean;
  /** Print a live per-request/response log to stderr (for the `proxy start` terminal). */
  logRequests?: boolean;
}): Promise<{
  runtime: Awaited<ReturnType<typeof startLocalProxyRuntime>>;
  session: ProxySessionRecord;
  statsWriter: ReturnType<typeof createSessionStatsWriter>;
  auditLog: ProxyAuditLog;
  grantStore?: ApprovalGrantStore;
}> {
  const identity = await reserveProxySessionIdentity();
  const statsWriter = createSessionStatsWriter(identity.uuid, EMPTY_PROXY_SESSION_STATS);
  // When grants are enabled, a session/duration approval is remembered so future
  // matching requests auto-approve without re-prompting (the seam the phone
  // approver reuses). Keyed to this session's uuid; torn down on stop.
  const grantStore = opts.enableApprovalGrants ? createApprovalGrantStore(identity.uuid) : undefined;
  const approvalProvider = grantStore
    ? createGrantingApprovalProvider({ inner: opts.approvalProvider, store: grantStore })
    : opts.approvalProvider;
  const now = new Date().toISOString();
  // Append-only audit log (Invariant #7): one entry per request decision, no
  // secret values. Persists after the session record is deleted on cleanup.
  const auditLog = createProxyAuditLog(identity.uuid, {
    ts: now,
    id: identity.id,
    uuid: identity.uuid,
    cwd: process.cwd(),
    egressMode: opts.policy.egressMode,
    ...(opts.command?.length ? { command: opts.command } : {}),
  });
  const runtime = await startLocalProxyRuntime({
    managedItems: opts.policy.proxyManagedItems,
    rules: opts.policy.proxyRules,
    egressMode: opts.policy.egressMode,
    approvalProvider,
    onActivity: (activity) => {
      statsWriter.onActivity(activity);
      auditLog.record(activity);
      if (opts.logRequests) emitProxyLog(formatProxyRequestLog(activity));
    },
    onResponse: opts.logRequests
      ? (info) => emitProxyLog(formatProxyResponseLog(info))
      : undefined,
  });
  const session = await createProxySessionRecord({
    id: identity.id,
    uuid: identity.uuid,
    ownerPid: process.pid,
    cwd: process.cwd(),
    startedAt: now,
    egressMode: opts.policy.egressMode,
    schemaFingerprint: opts.policy.schemaFingerprint,
    placeholderOverrides: opts.policy.placeholderByKey,
    ...(opts.policy.omittedKeys.length ? { omittedKeys: opts.policy.omittedKeys } : {}),
    stats: cloneSessionStats(statsWriter.stats),
    env: Object.fromEntries(
      Object.entries(runtime.env).filter((entry): entry is [string, string] => !!entry[1]),
    ),
    ...(opts.entryPaths?.length ? { entryPaths: opts.entryPaths } : {}),
    ...(opts.command?.length ? { command: opts.command } : {}),
    ...(opts.reloadable ? { reloadable: true } : {}),
  });

  return {
    runtime, session, statsWriter, auditLog, grantStore,
  };
}

function applyInjectModeFromFlags(ctx: any): {
  injectVars: boolean;
  injectBlob: boolean;
} {
  const injectMode = ctx.values.inject ?? 'all';
  const validModes = ['all', 'vars', 'blob'];
  if (!validModes.includes(injectMode)) {
    throw new CliExitError(`Invalid --inject mode: "${injectMode}". Must be one of: ${validModes.join(', ')}`);
  }

  return {
    injectVars: injectMode === 'all' || injectMode === 'vars',
    injectBlob: injectMode === 'all' || injectMode === 'blob',
  };
}

function formatSessionStatus(session: ProxySessionRecord): string {
  const child = session.childPid ? ` child=${session.childPid}` : '';
  const stats = session.stats ?? EMPTY_PROXY_SESSION_STATS;
  const last = stats.lastActivityAt ? ` last=${stats.lastActivityAt}` : '';
  const state = session.endedAt ? ` ended=${session.endedAt}` : '';
  return `[${session.id}] ${session.uuid} pid=${session.ownerPid}${child} egress=${session.egressMode} `
    + `cwd=${session.cwd} req=${stats.totalRequests} matched=${stats.matchedRequests} `
    + `blocked=${stats.blockedRequests}${last}${state}`;
}

function printSessionStatus(session: ProxySessionRecord) {
  console.log(formatSessionStatus(session));
}

function parseStatusWatchInterval(ctx: any): number {
  const raw = ctx.values.interval ?? '1000';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 100 || parsed > 60_000) {
    throw new CliExitError('Invalid --interval. Use a number between 100 and 60000 (milliseconds).');
  }
  return Math.floor(parsed);
}

async function collectStatusSessions(ctx: any): Promise<Array<ProxySessionRecord>> {
  if (ctx.values.session) {
    const session = await resolveProxySessionForCommand({
      explicitSession: ctx.values.session,
      env: process.env,
      defaultToSingleActive: false,
    }).catch((error) => {
      throw new CliExitError((error as Error).message);
    });
    return [session];
  }

  // `proxy status` shows active sessions by default; `--all` also includes the
  // durable records of ended sessions.
  return await listProxySessions({ includeEnded: !!ctx.values.all });
}

/** True when `cwd` is the session's directory or a subdirectory of it. */
export function isCwdWithin(cwd: string, sessionCwd: string): boolean {
  if (cwd === sessionCwd) return true;
  const rel = path.relative(sessionCwd, cwd);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve the running proxy session to attach `proxy run` to: an explicit
 * `--session`, else the single session whose cwd contains this one. Returns
 * undefined (→ start a fresh proxy) when nothing matches. Validates the schema
 * fingerprint and fails loudly on drift, so an attached command can't route
 * through a proxy started with a different `.env.schema`.
 */
async function resolveAttachSession(ctx: any, schemaFingerprint: string): Promise<ProxySessionRecord | undefined> {
  await cleanupStaleProxySessions();

  let candidate: ProxySessionRecord | undefined;
  if (ctx.values.session) {
    candidate = await resolveProxySessionForCommand({
      explicitSession: ctx.values.session,
      env: process.env,
      defaultToSingleActive: false,
    }).catch((error) => {
      throw new CliExitError((error as Error).message);
    });
  } else {
    const cwd = process.cwd();
    const matches = (await listProxySessions()).filter((s) => isCwdWithin(cwd, s.cwd));
    if (matches.length === 0) return undefined; // → start a fresh proxy
    if (matches.length > 1) {
      throw new CliExitError(
        `Multiple proxy sessions match this directory: ${matches.map((s) => s.id).join(', ')}.`,
        { suggestion: 'Pass --session <id> to choose one, or --new to start a separate proxy.' },
      );
    }
    [candidate] = matches;
  }

  if (candidate.schemaFingerprint && candidate.schemaFingerprint !== schemaFingerprint) {
    throw new CliExitError(
      `The running proxy session ${candidate.id} was started with a different .env.schema.`,
      {
        details: "Its placeholders and rules no longer match this directory's schema.",
        suggestion: 'Restart it (or run `varlock proxy refresh`), or use --new to start a separate proxy.',
      },
    );
  }
  return candidate;
}

/** How often a proxy owner polls for a reload request. */
const RELOAD_POLL_INTERVAL_MS = 500;
/** How often `proxy refresh` polls for its result, and how long it waits. */
const REFRESH_POLL_INTERVAL_MS = 250;
const REFRESH_TIMEOUT_MS = 15 * 60_000;

/**
 * Poll the session's reload-request file and, when a new request appears,
 * hot-reload the live runtime: re-resolve the schema in this (trusted) process,
 * swap the policy via `runtime.reconfigure`, update the session record, and write
 * a result the blocking `proxy refresh` reads. Returns `stop()` to clear the poller.
 *
 * No approval step yet — the reload is applied directly. When the native/phone
 * approver lands it inserts a gate at the marked point (the out-of-band approver
 * is the real trust boundary; see notes.ignore/proxy-refresh-reload-design.md).
 */
function startReloadServicer(opts: {
  session: ProxySessionRecord;
  runtime: Awaited<ReturnType<typeof startLocalProxyRuntime>>;
  defaultEntryPaths?: Array<string>;
  log: (message: string) => void;
}): { stop: () => void } {
  let lastRequestId: string | undefined;
  let initialized = false;
  let busy = false;

  const apply = async (requestId: string, entryPaths?: Array<string>): Promise<ProxyReloadResult> => {
    try {
      const latest = await getProxySessionByToken(opts.session.uuid).catch(() => undefined);
      const paths = entryPaths ?? latest?.entryPaths ?? opts.defaultEntryPaths;
      // TODO(approval): when a native/phone approver exists, request approval for
      // this schema change here and return status 'denied' if refused. Today the
      // reload is applied directly.
      const next = await prepareProxyPolicy(paths);
      opts.runtime.reconfigure({
        managedItems: next.proxyManagedItems,
        rules: next.proxyRules,
        egressMode: next.egressMode,
      });
      await updateProxySessionRecord(opts.session.uuid, {
        schemaFingerprint: next.schemaFingerprint,
        egressMode: next.egressMode,
        placeholderOverrides: next.placeholderByKey,
        omittedKeys: next.omittedKeys,
      });
      opts.log(`Reloaded proxy session ${opts.session.id} from schema (${next.proxyManagedItems.length} managed item(s)).`);
      return {
        requestId, status: 'done', completedAt: new Date().toISOString(), managedItemCount: next.proxyManagedItems.length,
      };
    } catch (error) {
      opts.log(`Proxy reload failed: ${(error as Error).message}`);
      return {
        requestId, status: 'error', completedAt: new Date().toISOString(), error: (error as Error).message,
      };
    }
  };

  const tick = async () => {
    if (busy || !initialized) return;
    const request = await readReloadRequest(opts.session.uuid);
    if (!request || request.requestId === lastRequestId) return;
    lastRequestId = request.requestId;
    busy = true;
    try {
      const result = await apply(request.requestId, request.entryPaths);
      await writeReloadResult(opts.session.uuid, result).catch(() => undefined);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => {
    tick().catch(() => undefined);
  }, RELOAD_POLL_INTERVAL_MS);
  timer.unref?.();
  // Ignore a request file left over from a previous run of this session uuid:
  // seed lastRequestId before the first tick can fire.
  readReloadRequest(opts.session.uuid)
    .then((existing) => { lastRequestId = existing?.requestId; })
    .catch(() => undefined)
    .finally(() => { initialized = true; });

  return { stop: () => clearInterval(timer) };
}

async function runAction(ctx: any) {
  const commandToRunAsArgs = getRunCommandArgs();
  const rawCommand = commandToRunAsArgs[0]!;
  const commandArgsOnly = commandToRunAsArgs.slice(1);
  const commandToRunStr = commandToRunAsArgs.join(' ');

  const policy = await prepareProxyPolicy(ctx.values.path);

  // Attach to a running proxy for this directory (a `proxy start` daemon) when
  // possible — its terminal handles approvals — instead of a new auto-deny proxy.
  // --new forces a fresh proxy.
  const attachSession = ctx.values.new ? undefined : await resolveAttachSession(ctx, policy.schemaFingerprint);

  let session: ProxySessionRecord;
  let statsWriter: ReturnType<typeof createSessionStatsWriter> | undefined;
  let cleanup: () => Promise<void>;

  if (attachSession) {
    // Use the daemon's authoritative view so the child's values are exactly what
    // the running proxy expects: its placeholders for sensitive items, and its
    // omitted keys withheld entirely.
    for (const [key, placeholder] of Object.entries(attachSession.placeholderOverrides ?? {})) {
      policy.resolvedEnv[key] = placeholder;
      if (policy.serializedGraph.config[key]) policy.serializedGraph.config[key].value = placeholder;
    }
    for (const key of attachSession.omittedKeys ?? []) {
      delete policy.resolvedEnv[key];
      delete policy.serializedGraph.config[key];
    }
    session = attachSession;
    // Register this `proxy run` process on the (shared daemon) session so ancestry
    // detection recognizes the agent as proxied even if it scrubs the env markers —
    // the daemon's ownerPid isn't in the agent's parent chain, but this pid is.
    await addProxySessionAttachment(session.uuid, process.pid);
    console.error(`Attached to proxy session ${session.id}. Approval prompts (if any) appear in its terminal.`);
    cleanup = async () => {
      await removeProxySessionAttachment(session.uuid, process.pid).catch(() => undefined);
    };
  } else {
    const created = await createRuntimeAndSession({
      policy,
      entryPaths: ctx.values.path,
      command: commandToRunAsArgs,
      // The child owns this terminal's stdio, so we can't safely prompt here —
      // require-approval requests fail closed. Use `proxy start` (or attach to one)
      // for interactive approval.
      approvalProvider: createAutoDenyApprovalProvider(),
      reloadable: true,
    });
    session = created.session;
    statsWriter = created.statsWriter;
    console.error(`Proxy session ${session.id} active. Monitor with \`varlock proxy status --session ${session.id} --watch\`.`);
    // This run owns its proxy, so it services its own `proxy refresh` reloads.
    // Notices go to stderr (the child owns stdout).
    const reloadServicer = startReloadServicer({
      session,
      runtime: created.runtime,
      defaultEntryPaths: ctx.values.path,
      log: (message) => console.error(message),
    });
    cleanup = async () => {
      reloadServicer.stop();
      await created.statsWriter.flushNow();
      created.statsWriter.stop();
      await created.runtime.stop().catch(() => undefined);
      await created.auditLog.flush().catch(() => undefined);
      await markProxySessionEnded(session.uuid).catch(() => undefined);
    };
  }

  const { injectVars, injectBlob } = applyInjectModeFromFlags(ctx);
  const sessionEnv = getProxySessionExportEnv(session);
  const fullInjectedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...sessionEnv,
    [PROXY_PARENT_PID_ENV_VAR]: String(process.pid),
    ...(injectVars ? policy.resolvedEnv : {}),
    __VARLOCK_RUN: '1',
    ...(injectBlob ? { __VARLOCK_ENV: JSON.stringify(policy.serializedGraph) } : {}),
  };

  if (injectBlob && !injectVars && process.env._VARLOCK_ENV_KEY) {
    fullInjectedEnv._VARLOCK_ENV_KEY = process.env._VARLOCK_ENV_KEY;
  }

  let commandProcess: ReturnType<typeof exec> | undefined;

  const redactLogs = policy.serializedGraph.settings?.redactLogs ?? true;
  const noRedactStdout = ctx.values['no-redact-stdout'] ?? false;

  if (redactLogs) {
    const redactionGraph = {
      ...policy.serializedGraph,
      config: { ...policy.serializedGraph.config },
    };

    for (const managedItem of policy.proxyManagedItems) {
      const schemaItem = policy.serializedGraph.config[managedItem.key];
      if (!schemaItem?.isSensitive) continue;
      if (!managedItem.realValue || managedItem.realValue === schemaItem.value) continue;
      redactionGraph.config[`__PROXY_REAL__${managedItem.key}`] = {
        value: managedItem.realValue,
        isSensitive: true,
      };
    }

    resetRedactionMap(redactionGraph);
  }

  if (noRedactStdout) {
    commandProcess = exec(rawCommand, commandArgsOnly, {
      stdio: 'inherit',
      env: fullInjectedEnv,
    });
  } else {
    let redactEnv: NodeJS.ProcessEnv = fullInjectedEnv;
    if (
      process.stdout.isTTY
      && process.env.NO_COLOR === undefined
      && process.env.FORCE_COLOR === undefined
    ) {
      let forceColorLevel = '1';
      if (process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit') {
        forceColorLevel = '3';
      } else if (process.env.TERM?.includes('256color') || process.env.TERM_PROGRAM === 'iTerm.app') {
        forceColorLevel = '2';
      }
      redactEnv = { ...fullInjectedEnv, FORCE_COLOR: forceColorLevel };
    }

    commandProcess = exec(rawCommand, commandArgsOnly, {
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'pipe',
      env: redactEnv,
    });
    // Pipe child output through the shared chunk-boundary-buffered redactor (the
    // same one `varlock run` uses) so a secret split across two chunks is still
    // caught — the proxy must redact the real values it injects at the wire.
    if (redactLogs) {
      const stdoutWriter = createRedactedStreamWriter(process.stdout);
      const stderrWriter = createRedactedStreamWriter(process.stderr);
      commandProcess.stdout?.on('data', stdoutWriter.write);
      commandProcess.stdout?.on('close', stdoutWriter.flush);
      commandProcess.stderr?.on('data', stderrWriter.write);
      commandProcess.stderr?.on('close', stderrWriter.flush);
    } else {
      commandProcess.stdout?.on('data', (chunk: Buffer | string) => process.stdout.write(chunk));
      commandProcess.stderr?.on('data', (chunk: Buffer | string) => process.stderr.write(chunk));
    }
  }

  if (commandProcess.pid && !attachSession) {
    await updateProxySessionRecord(session.uuid, { childPid: commandProcess.pid });
  }

  process.on('exit', () => {
    commandProcess?.kill(9);
  });

  ['SIGTERM', 'SIGINT'].forEach((signal) => {
    process.on(signal, () => {
      commandProcess?.kill(9);
      gracefulExit(1);
    });
  });

  let exitCode = 0;
  try {
    const result = await commandProcess;
    exitCode = result.exitCode;
  } catch (error) {
    if ((error as any).signal === 'SIGINT' || (error as any).signal === 'SIGKILL') {
      exitCode = 1;
    } else {
      console.log((error as Error).message);
      console.log(`command [${commandToRunStr}] failed`);
      console.log('try running the same command without varlock');
      console.log('if you get a different result, varlock may be the problem...');
      exitCode = (error as any).exitCode || 1;
    }
  } finally {
    await cleanup();
    if (statsWriter) {
      const stats = statsWriter.stats;
      console.error(`Proxy session ${session.id} summary: req=${stats.totalRequests} matched=${stats.matchedRequests} blocked=${stats.blockedRequests}`);
    }
  }

  return gracefulExit(exitCode);
}

async function startAction(ctx: any) {
  const policy = await prepareProxyPolicy(ctx.values.path);
  const {
    runtime, session, statsWriter, auditLog,
  } = await createRuntimeAndSession({
    policy,
    entryPaths: ctx.values.path,
    // The proxy owns this terminal (the agent runs elsewhere and routes through
    // it), so require-approval requests can prompt here — and session/duration
    // approvals can be remembered as standing grants. Wrapped so the live request
    // log defers while the prompt is reading input (shared TTY).
    approvalProvider: guardApprovalPromptForLogging(createTtyApprovalProvider()),
    enableApprovalGrants: true,
    reloadable: true,
    // The daemon owns this terminal, so tail a live per-request/response log here.
    logRequests: true,
  });

  console.log(`Started proxy session ${session.id} (${session.uuid})`);
  console.log(`Use \`varlock proxy env --session ${session.id}\` to print env exports.`);
  console.log(`Use \`varlock proxy status --session ${session.id} --watch\` to monitor activity.`);
  console.log(`Use \`varlock proxy refresh --session ${session.id}\` to reload after editing your schema.`);
  console.log('Live request log (→ request · ← response):');

  // Service `proxy refresh` requests: hot-reload the live policy without dropping
  // the proxy. The daemon owns this terminal, so reload notices print here.
  const reloadServicer = startReloadServicer({
    session,
    runtime,
    defaultEntryPaths: ctx.values.path,
    log: (message) => console.log(message),
  });

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    reloadServicer.stop();
    await statsWriter.flushNow();
    statsWriter.stop();
    await runtime.stop().catch(() => undefined);
    await auditLog.flush().catch(() => undefined);
    // Grants stay as part of the session's durable record — not destroyed on stop.
    await markProxySessionEnded(session.uuid).catch(() => undefined);
  };

  await new Promise<void>((resolve) => {
    const close = () => {
      cleanup().finally(resolve);
    };

    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  });
}

async function envAction(ctx: any) {
  const session = await resolveProxySessionForCommand({
    explicitSession: ctx.values.session,
    env: process.env,
    defaultToSingleActive: true,
  }).catch((error) => {
    throw new CliExitError((error as Error).message);
  });

  const format = (ctx.values.format ?? 'shell').toLowerCase();
  if (format !== 'shell' && format !== 'json') {
    throw new CliExitError('Invalid --format for `proxy env`. Use "shell" or "json".');
  }

  const env = getProxySessionExportEnv(session);
  if (format === 'json') {
    console.log(JSON.stringify(env, null, 2));
    return;
  }

  console.log(toShellExports(env));
}

async function statusAction(ctx: any) {
  const watch = ctx.values.watch ?? false;
  const printSnapshot = async () => {
    await cleanupStaleProxySessions();
    const sessions = await collectStatusSessions(ctx);
    if (!sessions.length) {
      console.log('No active proxy sessions.');
      return false;
    }
    for (const session of sessions) {
      printSessionStatus(session);
    }
    return true;
  };

  if (!watch) {
    await printSnapshot();
    return;
  }

  const intervalMs = parseStatusWatchInterval(ctx);
  let shouldStop = false;
  const stopWatching = () => {
    shouldStop = true;
  };

  process.on('SIGINT', stopWatching);
  process.on('SIGTERM', stopWatching);

  console.log(`Watching proxy status every ${intervalMs}ms. Press Ctrl+C to stop.`);
  while (!shouldStop) {
    if (process.stdout.isTTY) {
      process.stdout.write('\u001Bc');
    }
    console.log(`proxy status @ ${new Date().toISOString()}`);
    try {
      await printSnapshot();
    } catch (error) {
      if (ctx.values.session) {
        console.log((error as Error).message);
        break;
      }
      throw error;
    }
    if (shouldStop) break;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  process.off('SIGINT', stopWatching);
  process.off('SIGTERM', stopWatching);
}

async function refreshAction(ctx: any) {
  const session = await resolveProxySessionForCommand({
    explicitSession: ctx.values.session,
    env: process.env,
    defaultToSingleActive: true,
  }).catch((error) => {
    throw new CliExitError((error as Error).message);
  });

  // Only a session that owns a live runtime (`proxy start`, or a self-owned
  // `proxy run`) can hot-reload. An attached run has no runtime of its own — it
  // routes through a daemon, which is the session resolved here anyway.
  if (!session.reloadable) {
    throw new CliExitError(
      `Proxy session ${session.id} is not reloadable.`,
      { suggestion: 'Refresh applies to a `proxy start` daemon (or a self-owned `proxy run`).' },
    );
  }
  if (!isProcessRunning(session.ownerPid)) {
    throw new CliExitError(`Proxy session ${session.id} is no longer running.`);
  }

  // Validate the new schema here (in this context) so an obviously broken edit
  // fails loudly at the call site, not only in the owner's logs.
  const refreshPaths = ctx.values.path ?? session.entryPaths;
  await prepareProxyPolicy(refreshPaths).catch((error) => {
    throw new CliExitError(`Schema does not resolve: ${(error as Error).message}`);
  });

  // Hand the reload to the process that owns the runtime via the file channel,
  // then block until it reports a result. (When the native/phone approver lands,
  // the wait also spans the approval step — same blocking contract.)
  const requestId = newReloadRequestId();
  await writeReloadRequest(session.uuid, {
    requestId,
    requestedAt: new Date().toISOString(),
    ...(ctx.values.path?.length ? { entryPaths: ctx.values.path } : {}),
  });

  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  const deadline = Date.now() + REFRESH_TIMEOUT_MS;
  let result: ProxyReloadResult | undefined;
  try {
    console.log(`Requested reload of proxy session ${session.id}; waiting…`);
    while (!interrupted) {
      const latest = await readReloadResult(session.uuid);
      if (latest?.requestId === requestId) {
        // `done`/`error` are both terminal — the servicer only writes a result once.
        result = latest;
        break;
      }
      if (Date.now() > deadline) break;
      if (!isProcessRunning(session.ownerPid)) {
        throw new CliExitError(`Proxy session ${session.id} stopped before the reload completed.`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, REFRESH_POLL_INTERVAL_MS);
      });
    }
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }

  if (interrupted) {
    console.log('Stopped waiting for the reload (it may still complete).');
    return;
  }
  if (!result) {
    throw new CliExitError(`Timed out waiting for proxy session ${session.id} to reload.`);
  }
  if (result.status === 'error') {
    throw new CliExitError(`Proxy reload failed: ${result.error ?? 'unknown error'}`);
  }

  console.log(`✓ Schema change reloaded for proxy session ${session.id}.`);
  console.log('  • Commands run via `varlock run -- …` now use the updated variables.');
  console.log('  • Run `varlock load` to see the current variable set (placeholders).');
}

async function stopAction(ctx: any) {
  await cleanupStaleProxySessions();

  if (ctx.values.all) {
    const sessions = await listProxySessions();
    if (!sessions.length) {
      console.log('No active proxy sessions.');
      return;
    }

    for (const session of sessions) {
      try {
        process.kill(session.ownerPid, 'SIGTERM');
        console.log(`Sent SIGTERM to proxy session ${session.id} (pid ${session.ownerPid}).`);
      } catch {
        await markProxySessionEnded(session.uuid);
      }
    }
    return;
  }

  const session = await resolveProxySessionForCommand({
    explicitSession: ctx.values.session,
    env: process.env,
    defaultToSingleActive: true,
  }).catch((error) => {
    throw new CliExitError((error as Error).message);
  });

  try {
    process.kill(session.ownerPid, 'SIGTERM');
    console.log(`Sent SIGTERM to proxy session ${session.id} (pid ${session.ownerPid}).`);
  } catch {
    await markProxySessionEnded(session.uuid);
    console.log(`Marked stale proxy session ${session.id} ended.`);
  }
}

function formatAuditEntry(entry: ProxyAuditEntry): string {
  const injected = entry.injected && entry.injectedKeys?.length
    ? ` injected=${entry.injectedKeys.join(',')}`
    : '';
  const rule = entry.ruleId ? ` rule="${entry.ruleId}"` : '';
  return `${entry.ts} ${entry.decision.padEnd(16)} ${entry.method.padEnd(7)} ${entry.host}${entry.path}${injected}${rule}`;
}

async function auditAction(ctx: any) {
  const format = (ctx.values.format ?? 'text').toLowerCase();
  if (format !== 'text' && format !== 'json') {
    throw new CliExitError('Invalid --format for `proxy audit`. Use "text" or "json".');
  }

  // Resolve the session uuid. Prefer the live registry (accepts short ids and
  // ancestry), but fall back to treating an explicit value as a uuid, since an
  // ended session is excluded from the active registry while its audit log
  // remains in the session's directory.
  let uuid: string;
  try {
    const session = await resolveProxySessionForCommand({
      explicitSession: ctx.values.session,
      env: process.env,
      defaultToSingleActive: true,
    });
    uuid = session.uuid;
  } catch (error) {
    if (!ctx.values.session) throw new CliExitError((error as Error).message);
    uuid = ctx.values.session;
  }

  const lines = await readProxyAuditLines(uuid);
  if (format === 'json') {
    console.log(JSON.stringify(lines, null, 2));
    return;
  }

  const entries = lines.filter((line): line is ProxyAuditEntry => line.type === 'request');
  if (!entries.length) {
    console.log('No audit entries for this session.');
    return;
  }
  for (const entry of entries) {
    console.log(formatAuditEntry(entry));
  }
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const action = getAction(ctx);

  switch (action) {
    case 'run':
      return await runAction(ctx);
    case 'start':
      return await startAction(ctx);
    case 'env':
      return await envAction(ctx);
    case 'status':
      return await statusAction(ctx);
    case 'audit':
      return await auditAction(ctx);
    case 'refresh':
      return await refreshAction(ctx);
    case 'stop':
      return await stopAction(ctx);
    default:
      throw new CliExitError(
        `Unknown proxy action "${action}".`,
        { suggestion: 'Use one of: run, start, env, status, audit, refresh, stop' },
      );
  }
};
