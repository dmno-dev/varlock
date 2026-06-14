import { define } from 'gunshi';
import { gracefulExit } from 'exit-hook';

import { exec } from '../../lib/exec';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { startLocalProxyRuntime } from '../../proxy/runtime-proxy';
import {
  createProxyAuditLog,
  readProxyAuditLines,
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
  cleanupStaleProxySessions,
  createProxySessionRecord,
  deleteProxySessionRecord,
  getProxySessionExportEnv,
  listProxySessions,
  reserveProxySessionIdentity,
  resolveProxySessionForCommand,
  updateProxySessionRecord,
  type ProxySessionStats,
  type ProxySessionRecord,
} from '../../proxy/session-registry';
import {
  PROXY_PARENT_PID_ENV_VAR,
} from '../../proxy/env-vars';
import type { ProxyManagedItem, ProxyRule } from '../../proxy/types';
import {
  buildSandboxWiring,
  formatAppleContainerRunFlags,
  parseBindAddress,
} from '../../proxy/sandbox-wiring';
import { isVarlockReservedKey } from '../../env-graph/lib/reserved-vars';
import { resetRedactionMap, redactSensitiveConfig } from '../../runtime/env';
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
      description: 'Output format: `proxy env` → shell (default), json, or apple-container; `proxy audit` → text (default) or json',
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
    bind: {
      type: 'string',
      description: 'For `proxy start`: bind the proxy to host[:port] so a sandboxed guest can reach it (e.g. a `container` network gateway). Default: 127.0.0.1 on a random port.',
    },
  },
  examples: `
Proxy command surface:
  varlock proxy run -- claude
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
 * Keys withheld (omitted) from the proxied child. An item is omitted when it's
 * not `@proxy`-managed (placeholder) and not `@proxy=passthrough` (real value),
 * and is either sensitive (omitted by default — least privilege) or explicitly
 * marked `@proxy=omit`. `_VARLOCK_*` reserved keys are internal infra, never
 * omitted. Returns `{ explicit }` so the caller can warn only about implicit
 * omits ("no proxy policy set").
 */
export function getProxyOmittedKeys(
  envGraph: Awaited<ReturnType<typeof loadVarlockEnvGraph>>,
  proxyManagedItems: Array<ProxyManagedItem>,
): Array<{ key: string; explicit: boolean }> {
  const managedKeys = new Set(proxyManagedItems.map((item) => item.key));
  const omitted: Array<{ key: string; explicit: boolean }> = [];
  for (const key of envGraph.sortedConfigKeys) {
    if (isVarlockReservedKey(key)) continue;
    const item = envGraph.configSchema[key];
    if (!item || item.resolvedValue === undefined) continue;
    if (managedKeys.has(key)) continue;
    const mode = getProxyValueMode(item);
    if (mode === 'passthrough') continue; // inject the real value
    if (mode === 'omit') {
      omitted.push({ key, explicit: true });
      continue;
    }
    if (!item.isSensitive) continue; // non-sensitive with no policy → injected normally
    omitted.push({ key, explicit: false }); // sensitive default → omit (and warn)
  }
  return omitted;
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

  // Default-omit (least privilege): a sensitive item with no @proxy policy (and no
  // @proxy=passthrough) is withheld from the child entirely — dropped from both
  // the individual vars and the injected blob, so the agent never sees it.
  const omittedKeys = getProxyOmittedKeys(envGraph, proxyManagedItems);
  if (omittedKeys.length) {
    for (const { key } of omittedKeys) {
      delete resolvedEnv[key];
      delete serializedGraph.config[key];
    }
    // Only warn about items omitted by default — items explicitly marked
    // @proxy=omit were an intentional choice and don't need a warning.
    const warnKeys = omittedKeys.filter((o) => !o.explicit).map((o) => o.key);
    if (warnKeys.length) {
      console.error(
        `⚠️  The following sensitive var(s) were omitted from the proxied child because no proxy policy is set for them: ${warnKeys.join(', ')}`,
      );
      console.error(
        '   Add @proxy(...) to route a value through the proxy (agent sees a placeholder), '
          + '@proxy=passthrough to inject the real value, or @proxy=omit to omit it explicitly.',
      );
    }
  }

  for (const managedItem of proxyManagedItems) {
    resolvedEnv[managedItem.key] = managedItem.placeholder;
    if (serializedGraph.config[managedItem.key]) {
      serializedGraph.config[managedItem.key].value = managedItem.placeholder;
    }
  }

  return {
    resolvedEnv,
    serializedGraph,
    schemaFingerprint,
    proxyManagedItems,
    proxyRules,
    egressMode: serializedGraph.settings?.proxyEgress ?? 'permissive',
  };
}

async function createRuntimeAndSession(opts: {
  policy: PreparedProxyPolicy;
  entryPaths?: Array<string>;
  command?: Array<string>;
  approvalProvider: ApprovalProvider;
  /** Persist session/duration approval scopes as standing grants (interactive sessions only). */
  enableApprovalGrants?: boolean;
  /** Bind the front proxy to a reachable address (sandbox gateway) instead of loopback. */
  listen?: { host?: string; port?: number };
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
    },
    ...(opts.listen ? { listen: opts.listen } : {}),
  });
  const session = await createProxySessionRecord({
    id: identity.id,
    uuid: identity.uuid,
    ownerPid: process.pid,
    cwd: process.cwd(),
    startedAt: now,
    egressMode: opts.policy.egressMode,
    schemaFingerprint: opts.policy.schemaFingerprint,
    placeholderOverrides: Object.fromEntries(
      opts.policy.proxyManagedItems.map((item) => [item.key, item.placeholder]),
    ),
    stats: cloneSessionStats(statsWriter.stats),
    env: Object.fromEntries(
      Object.entries(runtime.env).filter((entry): entry is [string, string] => !!entry[1]),
    ),
    ...(opts.entryPaths?.length ? { entryPaths: opts.entryPaths } : {}),
    ...(opts.command?.length ? { command: opts.command } : {}),
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
  return `[${session.id}] ${session.uuid} pid=${session.ownerPid}${child} egress=${session.egressMode} `
    + `cwd=${session.cwd} req=${stats.totalRequests} matched=${stats.matchedRequests} `
    + `blocked=${stats.blockedRequests}${last}`;
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

  return await listProxySessions();
}

async function runAction(ctx: any) {
  const commandToRunAsArgs = getRunCommandArgs();
  const rawCommand = commandToRunAsArgs[0]!;
  const commandArgsOnly = commandToRunAsArgs.slice(1);
  const commandToRunStr = commandToRunAsArgs.join(' ');

  const policy = await prepareProxyPolicy(ctx.values.path);
  const {
    runtime, session, statsWriter, auditLog,
  } = await createRuntimeAndSession({
    policy,
    entryPaths: ctx.values.path,
    command: commandToRunAsArgs,
    // The child owns this terminal's stdio, so we can't safely prompt here —
    // require-approval requests fail closed. Use `proxy start` for interactive
    // approval (the proxy owns the terminal there).
    approvalProvider: createAutoDenyApprovalProvider(),
  });
  console.error(`Proxy session ${session.id} active. Monitor with \`varlock proxy status --session ${session.id} --watch\`.`);

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
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await statsWriter.flushNow();
    statsWriter.stop();
    await runtime.stop().catch(() => undefined);
    await auditLog.flush().catch(() => undefined);
    await deleteProxySessionRecord(session.uuid).catch(() => undefined);
  };

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

  const writeRedacted = (stream: NodeJS.WriteStream, chunk: Buffer | string) => {
    const str = chunk.toString();
    stream.write(redactLogs ? redactSensitiveConfig(str) : str);
  };

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
    commandProcess.stdout?.on('data', (chunk: Buffer | string) => writeRedacted(process.stdout, chunk));
    commandProcess.stderr?.on('data', (chunk: Buffer | string) => writeRedacted(process.stderr, chunk));
  }

  if (commandProcess.pid) {
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
    const stats = statsWriter.stats;
    console.error(`Proxy session ${session.id} summary: req=${stats.totalRequests} matched=${stats.matchedRequests} blocked=${stats.blockedRequests}`);
  }

  return gracefulExit(exitCode);
}

async function startAction(ctx: any) {
  let listen: { host?: string; port?: number } | undefined;
  if (ctx.values.bind) {
    const bind = parseBindAddress(ctx.values.bind);
    listen = { host: bind.host, ...(bind.port ? { port: bind.port } : {}) };
  }

  const policy = await prepareProxyPolicy(ctx.values.path);
  const {
    runtime, session, statsWriter, auditLog, grantStore,
  } = await createRuntimeAndSession({
    policy,
    entryPaths: ctx.values.path,
    // The proxy owns this terminal (the agent runs elsewhere and routes through
    // it), so require-approval requests can prompt here — and session/duration
    // approvals can be remembered as standing grants.
    approvalProvider: createTtyApprovalProvider(),
    enableApprovalGrants: true,
    ...(listen ? { listen } : {}),
  });

  console.log(`Started proxy session ${session.id} (${session.uuid})`);
  if (listen?.host && listen.host !== '127.0.0.1' && listen.host !== 'localhost') {
    console.log(`Proxy bound to ${session.env.HTTPS_PROXY} — reachable from a sandbox guest on that network.`);
    console.log(`Use \`varlock proxy env --session ${session.id} --format apple-container\` for container-run flags.`);
  }
  console.log(`Use \`varlock proxy env --session ${session.id}\` to print env exports.`);
  console.log(`Use \`varlock proxy status --session ${session.id} --watch\` to monitor activity.`);

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await statsWriter.flushNow();
    statsWriter.stop();
    await runtime.stop().catch(() => undefined);
    await auditLog.flush().catch(() => undefined);
    await grantStore?.destroy().catch(() => undefined);
    await deleteProxySessionRecord(session.uuid).catch(() => undefined);
  };

  await new Promise<void>((resolve) => {
    const close = () => {
      cleanup().finally(resolve);
    };

    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  });
}

/**
 * Emit the env + CA bind-mount a `container` (Apple) guest needs to route egress
 * through this proxy session. Pair with a `--internal` network and a proxy bound
 * to that network's gateway (`proxy start --bind <gateway>:<port>`).
 */
function printAppleContainerEnv(session: ProxySessionRecord) {
  const wiring = buildSandboxWiring(session);
  if (wiring.proxyIsLoopback) {
    console.error(
      'Warning: this proxy session is bound to loopback, so a container guest cannot reach it.\n'
      + 'Restart it bound to your network gateway, e.g. `varlock proxy start --bind 192.168.64.1:8888`.',
    );
  }
  console.log('# `container run` flags for this proxy session. Wrap with your network/image/command:');
  console.log('#   container run --network <internal-net> \\');
  console.log('#     <flags below> \\');
  console.log('#     <image> <command>');
  console.log(formatAppleContainerRunFlags(wiring));
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
  if (format !== 'shell' && format !== 'json' && format !== 'apple-container') {
    throw new CliExitError('Invalid --format for `proxy env`. Use "shell", "json", or "apple-container".');
  }

  if (format === 'apple-container') {
    printAppleContainerEnv(session);
    return;
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

  const refreshPaths = ctx.values.path ?? session.entryPaths;
  const policy = await prepareProxyPolicy(refreshPaths);

  await updateProxySessionRecord(session.uuid, {
    schemaFingerprint: policy.schemaFingerprint,
    egressMode: policy.egressMode,
    placeholderOverrides: Object.fromEntries(
      policy.proxyManagedItems.map((item) => [item.key, item.placeholder]),
    ),
    ...(refreshPaths?.length ? { entryPaths: refreshPaths } : {}),
  });

  console.log(`Refreshed proxy session ${session.id}.`);
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
        await deleteProxySessionRecord(session.uuid);
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
    await deleteProxySessionRecord(session.uuid);
    console.log(`Removed stale proxy session ${session.id}.`);
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
  // ancestry), but fall back to treating an explicit value as a uuid, since the
  // audit log outlives the (deleted-on-stop) session record.
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
