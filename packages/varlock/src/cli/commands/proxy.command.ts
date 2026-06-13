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

export function getBlockedSensitiveKeys(
  envGraph: Awaited<ReturnType<typeof loadVarlockEnvGraph>>,
  proxyManagedItems: Array<ProxyManagedItem>,
): Array<string> {
  const managedKeys = new Set(proxyManagedItems.map((item) => item.key));
  const blockedKeys: Array<string> = [];
  for (const key of envGraph.sortedConfigKeys) {
    const item = envGraph.configSchema[key];
    if (!item?.isSensitive) continue;
    if (item.resolvedValue === undefined) continue;
    if (managedKeys.has(key)) continue;
    if (item.getDec('proxyPassthrough')) continue;
    blockedKeys.push(key);
  }
  return blockedKeys;
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

  const blockedSensitiveKeys = getBlockedSensitiveKeys(envGraph, proxyManagedItems);
  if (blockedSensitiveKeys.length) {
    throw new CliExitError(
      [
        'Proxy session blocked: found sensitive items without proxy handling.',
        `Keys: ${blockedSensitiveKeys.join(', ')}`,
      ].join('\n'),
      {
        suggestion: 'Attach @proxy(...) to manage these values, or add @proxyPassthrough for explicit passthrough.',
      },
    );
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
}): Promise<{
  runtime: Awaited<ReturnType<typeof startLocalProxyRuntime>>;
  session: ProxySessionRecord;
  statsWriter: ReturnType<typeof createSessionStatsWriter>;
  auditLog: ProxyAuditLog;
}> {
  const identity = await reserveProxySessionIdentity();
  const statsWriter = createSessionStatsWriter(identity.uuid, EMPTY_PROXY_SESSION_STATS);
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
    onActivity: (activity) => {
      statsWriter.onActivity(activity);
      auditLog.record(activity);
    },
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
    runtime, session, statsWriter, auditLog,
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
  const policy = await prepareProxyPolicy(ctx.values.path);
  const {
    runtime, session, statsWriter, auditLog,
  } = await createRuntimeAndSession({
    policy,
    entryPaths: ctx.values.path,
  });

  console.log(`Started proxy session ${session.id} (${session.uuid})`);
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
