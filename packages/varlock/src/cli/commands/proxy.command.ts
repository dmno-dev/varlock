import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { watch as fsWatch, existsSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

import ansis from 'ansis';
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
  deleteProxySession,
  markProxySessionEnded,
  getProxySessionByToken,
  getProxySessionExportEnv,
  getProxySessionPort,
  isProcessRunning,
  isProxySessionAlive,
  listProxySessions,
  pruneEndedProxySessions,
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
  type ProxyReloadRequest,
  type ProxyReloadResult,
} from '../../proxy/reload-channel';
import { isInProxyContext } from '../helpers/proxy-context-guard';
import { buildInjectedBlobEnv } from '../helpers/injected-env-blob';
import { resolveInjectMode } from '../helpers/inject-mode';
import {
  buildSessionEnvPayload,
  decodeSessionEnvPayload,
  encodeSessionEnvPayload,
  PROXY_TOKEN_HEADER,
  SESSION_ENV_ENDPOINT_PATH,
  VARLOCK_INTERNAL_HOST,
  type SessionEnvPayload,
} from '../../proxy/session-env-payload';
import { isCancel } from '@clack/prompts';
import { select } from '../helpers/prompts';
import { wrapCommandWithSandbox } from '../../proxy/sandbox-seatbelt';
import { runContainerSandbox } from '../../proxy/sandbox-docker';
import {
  parseSandboxSpec, isContainerKind, checkSandboxAvailable, type SandboxSpec,
} from '../../proxy/sandbox';
import type { ProxyManagedItem, ProxyRule } from '../../proxy/types';
import { generateProxyPlaceholderForItem } from '../../proxy/placeholder';
import { isVarlockReservedKey } from '../../env-graph/lib/reserved-vars';
import { resetRedactionMap } from '../../runtime/env';
import { REDACT_STDOUT_ARG, resolveStdoutRedaction, pipeRedactedStreams } from '../helpers/stdout-redaction';
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
    yes: {
      type: 'boolean',
      short: 'y',
      description: 'Skip the confirmation prompt (for `proxy prune`)',
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
    ...REDACT_STDOUT_ARG,
    inject: {
      type: 'string',
      short: 'i',
      description: 'Control what gets injected into child env for `proxy run`: "all" (default), "vars", or "blob"',
    },
    new: {
      type: 'boolean',
      description: 'For `proxy run`: start a fresh proxy instead of attaching to a running one for this directory',
    },
    sandbox: {
      type: 'custom',
      // Bare `--sandbox` → built-in; `--sandbox=docker|podman` → container backend.
      parse: (value: string) => (value === '' || value == null ? 'builtin' : value),
      description: 'For `proxy run`: run the child in a sandbox whose only egress is the proxy. Bare '
        + '`--sandbox` uses the built-in minimal OS jail (macOS `sandbox-exec`); `--sandbox=docker` (or '
        + '`=podman`) runs the child in a container on an internal network, with a dumb forwarder bridging '
        + 'to the host proxy (secrets stay on the host). Opt-in.',
    },
    'sandbox-image': {
      type: 'string',
      description: 'For `proxy run --sandbox=docker|podman`: the container image the child runs in (must '
        + 'contain your command, e.g. a devcontainer image with `claude` installed).',
    },
    'allow-reload': {
      type: 'boolean',
      negatable: true,
      description: 'Override the reload posture for this `proxy start`/`run`: `--allow-reload` forces `manual` '
        + '(human-applied from a trusted terminal; reloads requested from inside the agent are refused), '
        + '`--no-allow-reload` forces `off`. Otherwise `@proxyConfig={reload=...}` applies, defaulting to `auto` '
        + '(manual for an interactive `proxy start`, off for headless or one-shot `proxy run`).',
    },
  },
  examples: `
Proxy command surface:
  varlock proxy run -- claude                   # attaches to a running proxy for this dir, else starts one
  varlock proxy run --session abc12 -- claude   # attach to a specific session (approvals prompt in its terminal)
  varlock proxy run --new -- claude             # force a fresh, separate proxy
  varlock proxy run --sandbox -- claude         # run the child in a minimal OS sandbox (macOS)
  varlock proxy run --sandbox=docker --sandbox-image my-agent -- claude   # run the child in a container
  varlock proxy start
  varlock proxy rules                           # summarize the effective @proxy config (no proxy started)
  varlock proxy env --session abc12
  varlock proxy status
  varlock proxy audit --session abc12
  varlock proxy reload --session abc12
  varlock proxy stop --session abc12
  varlock proxy stop --all
  varlock proxy prune                           # delete ALL ended session records (+ audit logs)
  varlock proxy prune --session abc12           # delete one session's record
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
    if (!item) continue;
    const mode = getProxyValueMode(item);
    if (mode === 'passthrough') continue; // inject the real value
    if (mode === 'omit') {
      omittedKeys.push(key);
      continue;
    }
    if (!item.isSensitive) continue; // non-sensitive with no policy → injected normally
    // Default-deny: if a sensitive item's value didn't resolve at snapshot time
    // (its resolver threw / returned undefined), we can't base a placeholder on it
    // AND can't assume it stays unresolved in the child — a later successful
    // re-resolution (e.g. a warm credential session) would surface the REAL value.
    // Omit it so the child gets `unset`, never the real secret.
    if (item.resolvedValue === undefined) {
      omittedKeys.push(key);
      continue;
    }
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
      { suggestion: 'Use one of: run, start, rules, env, status, audit, reload, stop, prune' },
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

/**
 * Load + resolve + validate the schema in the proxy command's own (trusted)
 * context, throwing on any schema/config error. This is the part `proxy reload`
 * needs to fail loudly on a broken edit; `prepareProxyPolicy` builds the full
 * policy on top of it.
 */
async function loadResolvedProxyGraph(entryFilePaths?: Array<string>) {
  const envGraph = await loadVarlockEnvGraph({
    entryFilePaths,
    // The proxy command manages the session fingerprint itself; don't subject
    // its own loads to the nested-context guard (would block `proxy reload`).
    skipProxyFingerprintGuard: true,
  });
  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);

  await envGraph.generateTypesIfNeeded();
  await envGraph.resolveEnvValues();
  checkForConfigErrors(envGraph);
  return envGraph;
}

async function prepareProxyPolicy(entryFilePaths?: Array<string>): Promise<PreparedProxyPolicy> {
  const envGraph = await loadResolvedProxyGraph(entryFilePaths);

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

/**
 * Assemble the env for a proxied child from a session-env payload. Pure (no
 * process access) so the layering rules are unit-testable:
 *  - payload values (placeholders included) win over the launching shell's
 *    ambient values, so a real key accidentally exported in the shell can't
 *    reach the child when the schema manages it
 *  - omitted keys are absent entirely, even if the shell exports them
 */
export function buildProxiedChildEnv(opts: {
  payload: SessionEnvPayload;
  sessionExportEnv: Record<string, string>;
  parentPid: number;
  injectVars: boolean;
  injectBlob: boolean;
  baseEnv: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const fullInjectedEnv: NodeJS.ProcessEnv = {
    ...opts.baseEnv,
    ...opts.sessionExportEnv,
    [PROXY_PARENT_PID_ENV_VAR]: String(opts.parentPid),
    ...(opts.injectVars ? opts.payload.env : {}),
    __VARLOCK_RUN: '1',
    // honors @encryptInjectedEnv in blob-only mode; reuses/forwards an ambient key
    ...buildInjectedBlobEnv({
      serializedGraph: opts.payload.serializedGraph,
      injectVars: opts.injectVars,
      injectBlob: opts.injectBlob,
      ambientEnvKey: opts.baseEnv._VARLOCK_ENV_KEY,
    }),
  };

  // An omitted key must be absent from the child env entirely, even when the
  // launching/attaching shell happens to export a value for it.
  for (const key of opts.payload.omittedKeys) {
    delete fullInjectedEnv[key];
  }

  return fullInjectedEnv;
}

/**
 * Count of sensitive items whose REAL value the child (and the session-env
 * payload) carries: `@proxy=passthrough` items. Placeholdered items are in
 * `placeholderByKey`; omitted ones are already deleted from the graph.
 */
function countPassthroughSecrets(policy: PreparedProxyPolicy): number {
  return Object.entries(policy.serializedGraph.config as Record<string, { isSensitive?: boolean }>)
    .filter(([key, item]) => item.isSensitive && !(key in policy.placeholderByKey))
    .length;
}

/**
 * Spawn the proxied child from a session-env payload: the ONLY consumer of the
 * payload, shared by one-shot (in-memory payload) and attach (fetched payload)
 * so the two paths cannot diverge. Assembles the child env, seeds stdout
 * redaction, and wires the redacted streams.
 */
function spawnProxiedChild(opts: {
  payload: SessionEnvPayload;
  session: ProxySessionRecord;
  rawCommand: string;
  commandArgsOnly: Array<string>;
  injectVars: boolean;
  injectBlob: boolean;
  redactStdoutFlag?: boolean;
  /**
   * Wire real values for redaction seeding: self-owned runs only. An attached
   * run never holds them (the payload has placeholders + passthrough values,
   * which the serialized graph already covers).
   */
  redactionManagedItems?: Array<ProxyManagedItem>;
  /** Wrap the child in the built-in minimal OS sandbox (`--sandbox`). */
  sandbox?: boolean;
}) {
  const fullInjectedEnv = buildProxiedChildEnv({
    payload: opts.payload,
    sessionExportEnv: getProxySessionExportEnv(opts.session),
    parentPid: process.pid,
    injectVars: opts.injectVars,
    injectBlob: opts.injectBlob,
    baseEnv: process.env,
  });

  // Per-stream TTY auto-detect (interactive terminal -> raw inherit so tools like `claude`
  // work; piped/redirected -> redact). Shared with `varlock run` so they can't diverge.
  const { redactStdout, redactStderr } = resolveStdoutRedaction({
    redactStdoutFlag: opts.redactStdoutFlag,
    redactLogs: opts.payload.serializedGraph.settings?.redactLogs ?? true,
  });

  // Seed the redaction map from the child-view graph (placeholders + passthrough
  // values), plus the REAL values the proxy injects at the wire when this run owns
  // the proxy, so if the child ever echoes an injected value back it is scrubbed.
  if (redactStdout || redactStderr) {
    const redactionGraph = {
      ...opts.payload.serializedGraph,
      config: { ...opts.payload.serializedGraph.config },
    };
    for (const managedItem of opts.redactionManagedItems ?? []) {
      const schemaItem = opts.payload.serializedGraph.config[managedItem.key];
      if (!schemaItem?.isSensitive) continue;
      if (!managedItem.realValue || managedItem.realValue === schemaItem.value) continue;
      redactionGraph.config[`__PROXY_REAL__${managedItem.key}`] = {
        value: managedItem.realValue,
        isSensitive: true,
      };
    }
    resetRedactionMap(redactionGraph);
  }

  // Optionally wrap the child in the built-in credential + egress jail. This
  // must be the outermost layer: the sandbox has to constrain the command AND
  // any process it spawns, so we sandbox the command itself (not varlock).
  const { command: execCommand, args: execArgs } = opts.sandbox
    ? wrapCommandWithSandbox(opts.rawCommand, opts.commandArgsOnly)
    : { command: opts.rawCommand, args: opts.commandArgsOnly };

  // An inherited stream (both false) yields raw TTY pass-through, same as stdio: 'inherit'.
  const commandProcess = exec(execCommand, execArgs, {
    stdin: 'inherit',
    stdout: redactStdout ? 'pipe' : 'inherit',
    stderr: redactStderr ? 'pipe' : 'inherit',
    env: fullInjectedEnv,
  });
  pipeRedactedStreams(commandProcess, { redactStdout, redactStderr });
  return commandProcess;
}

const SESSION_ENV_FETCH_TIMEOUT_MS = 5000;

/**
 * Fetch the session-env payload from a running session's `varlock.internal`
 * endpoint (via its own proxy port). Adopting this env is what attach MEANS:
 * the owner resolved it in its own context (its shell overrides, its env
 * selection); no schema load, resolution, or unlock prompt happens here.
 *
 * Any failure gets one clear message: never branch on the connect errno (Node
 * and Bun report a dead endpoint differently).
 */
async function fetchSessionEnvPayload(session: ProxySessionRecord): Promise<SessionEnvPayload> {
  const unreachable = (details: string) => new CliExitError(
    `Proxy session ${session.id} is not responding.`,
    {
      details,
      suggestion: 'The session may have stopped or predate this varlock version. Restart it, or use `--new` to start a separate proxy.',
    },
  );

  let proxyUrl: URL;
  try {
    proxyUrl = new URL(session.env.HTTP_PROXY ?? '');
  } catch {
    throw unreachable('Its record has no usable proxy address.');
  }
  if (!session.endpointToken) {
    throw unreachable('Its record has no endpoint token.');
  }

  const raw = await new Promise<string>((resolve, reject) => {
    // `timer` and `req` reference each other (timer destroys req; req's handlers
    // clear timer), so one must be a let declared first.
    // eslint-disable-next-line @nofix/prefer-const
    let timer: ReturnType<typeof setTimeout> | undefined;
    const req = httpRequest({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port),
      method: 'GET',
      // absolute-form request target, the shape proxies receive
      path: `http://${VARLOCK_INTERNAL_HOST}${SESSION_ENV_ENDPOINT_PATH}`,
      headers: {
        host: VARLOCK_INTERNAL_HOST,
        [PROXY_TOKEN_HEADER]: session.endpointToken,
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        res.resume();
        reject(new Error(`endpoint returned status ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve(body);
      });
      res.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // Own the timeout with a real timer: Bun's compiled runtime does not
    // reliably emit the http `timeout` (or a subsequent `error`) event for the
    // request `timeout` option — the socket just dies and the promise would
    // never settle, so the process would exit 0 silently mid-await.
    timer = setTimeout(() => {
      reject(new Error('timed out'));
      req.destroy();
    }, SESSION_ENV_FETCH_TIMEOUT_MS);
    req.end();
  }).catch((error) => {
    throw unreachable(`Fetching its env failed: ${(error as Error).message}.`);
  });

  try {
    return decodeSessionEnvPayload(raw);
  } catch (error) {
    throw unreachable(`It served an unusable env payload: ${(error as Error).message}.`);
  }
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

/** The daemon's raw-mode keypress controls (reload/quit); paused while an approval prompt owns stdin. */
let daemonKeyControls: { pauseForPrompt(): void; resumeAfterPrompt(): void; stop(): void } | undefined;

/**
 * Wrap an approval provider so the live log defers (rather than corrupts) the TTY while it
 * prompts, and the reload keypress reader yields stdin to the prompt (both readline and the
 * raw-mode key listener would otherwise fight over stdin).
 */
function guardApprovalPromptForLogging(inner: ApprovalProvider): ApprovalProvider {
  return {
    async requestApproval(req) {
      activeApprovalPrompts += 1;
      daemonKeyControls?.pauseForPrompt();
      try {
        return await inner.requestApproval(req);
      } finally {
        activeApprovalPrompts -= 1;
        daemonKeyControls?.resumeAfterPrompt();
        flushDeferredProxyLogs();
      }
    },
  };
}

/** The session short-id, colored so it stands out in the log preamble. */
function fmtSessionId(id: string): string {
  return ansis.magenta.bold(id);
}

/** Color an HTTP status by class: 2xx/3xx green, 4xx yellow, 5xx red. */
function colorProxyStatus(code: number): string {
  const text = String(code);
  if (code >= 500) return ansis.red(text);
  if (code >= 400) return ansis.yellow(text);
  return ansis.green(text);
}

/** `METHOD host/path` with the method + path dimmed so the host stands out. */
function formatProxyTarget(method: string, host: string, pathName: string): string {
  return `${ansis.dim(`${method} `)}${host}${ansis.dim(pathName)}`;
}

/** A one-line live log of a request decision: `→ POST host/path  inject: KEY` (or `✗ … blocked-egress`). */
function formatProxyRequestLog(a: ProxyActivity): string {
  const arrow = a.blocked ? ansis.red('✗') : ansis.green('→');
  let decision = '';
  if (a.decision !== 'allow') {
    decision = `  ${(a.blocked ? ansis.red : ansis.green)(a.decision)}`;
  }
  const inject = a.injectedKeys?.length
    ? `  ${ansis.dim('inject:')} ${ansis.yellow(a.injectedKeys.join(', '))}`
    : '';
  return `${arrow} ${formatProxyTarget(a.method, a.host, a.path)}${decision}${inject}`;
}

/** A one-line live log of a forwarded response: `← POST host/path  200  scrubbed: KEY`. */
function formatProxyResponseLog(info: ProxyResponseInfo): string {
  const arrow = ansis.cyan('←');
  const scrub = info.scrubbedKeys.length
    ? `  ${ansis.dim('scrubbed:')} ${ansis.yellow(info.scrubbedKeys.join(', '))}`
    : '';
  const streamed = info.streamed ? ansis.dim(' (streamed)') : '';
  return `${arrow} ${formatProxyTarget(info.method, info.host, info.path)}  ${colorProxyStatus(info.statusCode)}${scrub}${streamed}`;
}

async function createRuntimeAndSession(opts: {
  policy: PreparedProxyPolicy;
  entryPaths?: Array<string>;
  command?: Array<string>;
  approvalProvider: ApprovalProvider;
  /** Persist session/duration approval scopes as standing grants (interactive sessions only). */
  enableApprovalGrants?: boolean;
  /** Mark the session as a hot-reloadable daemon (so `proxy reload` can reload it). */
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
  // Bearer credential for the varlock.internal endpoint. Separate from the uuid
  // on purpose: the uuid is a DISPLAYED identifier (status output, child env),
  // this token is never printed anywhere (0600 record + owner memory only).
  const endpointToken = randomUUID();
  let lastEndpointAuthWarnAt = 0;
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
    internalEndpoint: {
      token: endpointToken,
      onAuthFailure: () => {
        // Throttled: a misbehaving prober shouldn't be able to flood the owner's log.
        if (Date.now() - lastEndpointAuthWarnAt < 5000) return;
        lastEndpointAuthWarnAt = Date.now();
        emitProxyLog(
          '⚠️  Refused a request to this session\'s control endpoint (bad or missing token). '
          + 'Another process on this machine may be probing the proxy.',
        );
      },
      onServed: (meta) => {
        // Visibility when real secrets leave the owner: placeholders/non-secrets are
        // routine (the attach watcher already logs the client), passthrough is not.
        if (!meta?.passthroughCount) return;
        emitProxyLog(
          `${ansis.green('⊕')} served session env to an attaching client ${ansis.dim(`(includes ${meta.passthroughCount} passthrough secret${meta.passthroughCount === 1 ? '' : 's'})`)}`,
        );
      },
    },
  });
  // Serve the child view to attaching `proxy run` processes (adopt semantics);
  // applyTrustedReload re-sets this after each reload so fetches stay current.
  runtime.setSessionEnvPayloadJson(
    encodeSessionEnvPayload(buildSessionEnvPayload(opts.policy)),
    { passthroughCount: countPassthroughSecrets(opts.policy) },
  );
  const session = await createProxySessionRecord({
    id: identity.id,
    uuid: identity.uuid,
    ownerPid: process.pid,
    cwd: process.cwd(),
    startedAt: now,
    egressMode: opts.policy.egressMode,
    endpointToken,
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

function timeAgo(iso?: string): string {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '-';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** A running session is `idle` once its last request is older than this. */
const SESSION_IDLE_AFTER_MS = 30 * 60 * 1000;

/**
 * Short activity descriptor for a running session (creation time is shown
 * separately):
 *  - `new`           — never served a request
 *  - `active Xm ago` — served a request recently
 *  - `idle Xd ago`   — running but no traffic for a while (spots forgotten daemons)
 */
function sessionActivityHint(s: ProxySessionRecord): string {
  if ((s.stats?.totalRequests ?? 0) === 0) return 'new';
  const last = s.stats?.lastActivityAt;
  const sinceMs = last ? Date.now() - Date.parse(last) : NaN;
  if (!Number.isFinite(sinceMs)) return 'idle';
  return sinceMs > SESSION_IDLE_AFTER_MS ? `idle ${timeAgo(last)}` : `active ${timeAgo(last)}`;
}

/** The `LAST` column cell: `ended Xd ago` for stopped sessions, else the activity hint. */
function lastActivityCell(s: ProxySessionRecord): string {
  if (s.endedAt) return `ended ${timeAgo(s.endedAt)}`;
  return sessionActivityHint(s);
}

function shortenPath(p: string, max = 44): string {
  const home = process.env.HOME;
  let out = home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  if (out.length > max) out = `…${out.slice(-(max - 1))}`;
  return out;
}

/** Render sessions as an aligned, colorized table (falls back to plain when not a TTY). */
function renderSessionsTable(sessions: Array<ProxySessionRecord>): string {
  const color = process.stdout.isTTY;
  const dim = (s: string) => (color ? ansis.dim(s) : s);
  const headers = ['', 'ID', 'PID', 'PORT', 'EGRESS', 'REQ', 'MATCH', 'BLOCK', 'CREATED', 'LAST', 'DIR'];
  const rows = sessions.map((s) => {
    const stats = s.stats ?? EMPTY_PROXY_SESSION_STATS;
    const running = !s.endedAt;
    const dot = running ? '●' : '○';
    return {
      running,
      cells: [
        dot,
        s.id,
        String(s.ownerPid),
        String(getProxySessionPort(s) ?? '-'),
        s.egressMode,
        String(stats.totalRequests),
        String(stats.matchedRequests),
        String(stats.blockedRequests),
        timeAgo(s.startedAt),
        lastActivityCell(s),
        shortenPath(s.cwd),
      ],
    };
  });

  const widths = headers.map((h, i) => Math.max(
    h.length,
    ...rows.map((r) => r.cells[i]!.length),
  ));
  const pad = (cells: Array<string>) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();

  const lines = [dim(pad(headers))];
  for (const r of rows) {
    const line = pad(r.cells);
    if (!color) lines.push(line);
    else lines.push(r.running ? line.replace('●', ansis.green('●')) : ansis.dim(line));
  }
  return lines.join('\n');
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

export type ReloadMode = 'off' | 'manual';
export type ReloadSetting = 'off' | 'manual' | 'auto';

/**
 * Resolve the effective reload posture at launch. Precedence: the
 * `--allow-reload` / `--no-allow-reload` flag, then `@proxyConfig={reload=...}`,
 * then the default `auto`.
 *
 * `auto` errs conservative today: a human-applied (`manual`) reload only for an
 * interactive `proxy start` (a person is there to run `proxy reload` and watch the
 * refusal log), and `off` for headless runs or a one-shot `proxy run` (which
 * re-reads the schema on its next invocation anyway). `auto` is agent-resistant
 * because it reads the launcher's context, which the not-yet-running agent can't
 * influence, and it only ever widens when it is safe to:
 *   TODO(sandbox-detect): a detected sandbox closes the escape, so allow agent-triggered reload.
 *   TODO(approval): an out-of-band approver resolves `auto` to an `approval` mode.
 */
export function resolveReloadMode(opts: {
  flag: boolean | undefined;
  schema: ReloadSetting | undefined;
  isStart: boolean;
  hasTty: boolean;
}): { mode: ReloadMode; resolvedFromAuto: boolean } {
  let setting: ReloadSetting;
  if (opts.flag === true) setting = 'manual';
  else if (opts.flag === false) setting = 'off';
  else setting = opts.schema ?? 'auto';

  if (setting !== 'auto') return { mode: setting, resolvedFromAuto: false };
  return { mode: opts.isStart && opts.hasTty ? 'manual' : 'off', resolvedFromAuto: true };
}

/** Whether a human terminal is attached, the signal reload `auto` uses. */
function isHumanAttended(): boolean {
  return !!(process.stdout.isTTY || process.stderr.isTTY || process.stdin.isTTY);
}

/**
 * Build picker rows that are self-describing at a glance: each label is an
 * aligned `id  activity  created  [dir]` line (only the focused row shows a hint
 * in clack's select, so the distinguishing info has to live in the label). The
 * hint adds the OS process detail (pid · port) for the focused row — compact and
 * what actually disambiguates two sessions in the same directory.
 *
 * `showCwd` is false when the candidates were all matched *by* the current
 * directory (attach), where the dir is the same for every row and just noise.
 */
function buildSessionPickerOptions(
  sessions: Array<ProxySessionRecord>,
  opts?: { showCwd?: boolean },
) {
  const showCwd = opts?.showCwd ?? true;
  const cols = sessions.map((s) => ({
    s,
    activity: sessionActivityHint(s),
    created: `created ${timeAgo(s.startedAt)}`,
  }));
  const idW = Math.max(...cols.map((c) => c.s.id.length));
  const actW = Math.max(...cols.map((c) => c.activity.length));
  const createdW = Math.max(...cols.map((c) => c.created.length));
  return cols.map(({ s, activity, created }) => {
    const parts = [s.id.padEnd(idW), activity.padEnd(actW), created.padEnd(createdW)];
    if (showCwd) parts.push(shortenPath(s.cwd, 40));
    return {
      value: s.uuid,
      label: parts.join('  '),
      hint: `pid ${s.ownerPid} · port ${getProxySessionPort(s) ?? '-'}`,
    };
  });
}

/**
 * Disambiguate between multiple candidate sessions. On an interactive terminal,
 * prompt the user to pick one; otherwise (script/pipe) throw a clear error so
 * behavior stays deterministic. `--session <id>` always bypasses this.
 */
async function pickSession(
  sessions: Array<ProxySessionRecord>,
  opts: { message: string; noneError: string; showCwd?: boolean },
): Promise<ProxySessionRecord> {
  if (sessions.length === 1) return sessions[0]!;
  if (sessions.length === 0) throw new CliExitError(opts.noneError);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliExitError(
      `${opts.message} ${sessions.map((s) => s.id).join(', ')}.`,
      { suggestion: 'Pass `--session <id>` to choose one (or run interactively to pick from a list).' },
    );
  }
  const chosen = await select<string>({
    message: opts.message,
    options: buildSessionPickerOptions(sessions, { showCwd: opts.showCwd }),
  });
  if (isCancel(chosen)) throw new CliExitError('Cancelled.', { silent: true });
  return sessions.find((s) => s.uuid === chosen)!;
}

/**
 * Resolve the running proxy session to attach `proxy run` to: an explicit
 * `--session`, else the single session whose cwd contains this one. Returns
 * undefined (→ start a fresh proxy) when nothing matches.
 *
 * No schema/fingerprint check here: attach ADOPTS the session's env (fetched
 * from the owner), so there is no locally-resolved schema to compare. Disk
 * drift stays handled where it belongs: the owner's drift watcher warns the
 * human, and the in-child fingerprint guard blocks nested resolves until a
 * reload re-blesses the change.
 */
async function resolveAttachSession(ctx: any): Promise<ProxySessionRecord | undefined> {
  await cleanupStaleProxySessions();

  if (ctx.values.session) {
    return resolveProxySessionForCommand({
      explicitSession: ctx.values.session,
      env: process.env,
      defaultToSingleActive: false,
    }).catch((error) => {
      throw new CliExitError((error as Error).message);
    });
  }

  const cwd = process.cwd();
  const matches = (await listProxySessions()).filter((s) => isCwdWithin(cwd, s.cwd));
  if (matches.length === 0) return undefined; // → start a fresh proxy
  return pickSession(matches, {
    message: 'Multiple proxy sessions match this directory — attach to which?',
    noneError: 'No proxy session matches this directory.',
    showCwd: false,
  });
}

/**
 * Apply a trusted reload: re-resolve the schema and swap the live policy on the running
 * runtime. Used by both the file-channel servicer (for a remote `proxy reload`) and the
 * in-terminal keypress. No refusal check here: callers must have already established the
 * request is trusted (a human keypress at the daemon TTY, or a non-agent `proxy reload`).
 */
async function applyTrustedReload(opts: {
  session: ProxySessionRecord;
  runtime: Awaited<ReturnType<typeof startLocalProxyRuntime>>;
  requestedEntryPaths?: Array<string>;
  defaultEntryPaths?: Array<string>;
  log: (message: string) => void;
}): Promise<{ ok: true; managedItemCount: number } | { ok: false; error: string }> {
  try {
    const latest = await getProxySessionByToken(opts.session.uuid).catch(() => undefined);
    const paths = opts.requestedEntryPaths ?? latest?.entryPaths ?? opts.defaultEntryPaths;
    const next = await prepareProxyPolicy(paths);
    opts.runtime.reconfigure({
      managedItems: next.proxyManagedItems,
      rules: next.proxyRules,
      egressMode: next.egressMode,
    });
    // Keep the varlock.internal endpoint serving the CURRENT child view, so a
    // post-reload attach adopts the reloaded env, not the launch-time one.
    opts.runtime.setSessionEnvPayloadJson(
      encodeSessionEnvPayload(buildSessionEnvPayload(next)),
      { passthroughCount: countPassthroughSecrets(next) },
    );
    await updateProxySessionRecord(opts.session.uuid, {
      schemaFingerprint: next.schemaFingerprint,
      egressMode: next.egressMode,
      placeholderOverrides: next.placeholderByKey,
      omittedKeys: next.omittedKeys,
    });
    opts.log(`Reloaded proxy session ${opts.session.id} from schema (${next.proxyManagedItems.length} managed item(s)).`);
    return { ok: true, managedItemCount: next.proxyManagedItems.length };
  } catch (error) {
    opts.log(`Proxy reload failed: ${(error as Error).message}`);
    return { ok: false, error: (error as Error).message };
  }
}

export type ReloadKeyState = 'idle' | 'confirming';

/**
 * Two-step reload trigger for the `proxy start` terminal: `r` arms it, then `y` confirms
 * (any other key cancels), so a stray keystroke can't swap the live policy. Pure state
 * machine so it is testable without a real TTY; the caller wires the side effects.
 */
export function createReloadKeypressHandler(opts: {
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}): { handleKey: (key: string) => void; state: () => ReloadKeyState } {
  let state: ReloadKeyState = 'idle';
  return {
    state: () => state,
    handleKey(key) {
      if (state === 'idle') {
        if (key === 'r' || key === 'R') {
          state = 'confirming';
          opts.onArm();
        }
        return;
      }
      state = 'idle';
      if (key === 'y' || key === 'Y') opts.onConfirm();
      else opts.onCancel();
    },
  };
}

/**
 * Raw-mode stdin controls for the interactive daemon: `r` then `y` reloads, Ctrl-C quits.
 * Returns undefined when there is no TTY (headless daemons reload via `proxy reload`).
 * `pauseForPrompt`/`resumeAfterPrompt` hand stdin to the approval readline while it prompts.
 */
function startDaemonKeyControls(opts: {
  onReload: () => void;
  onQuit: () => void;
}): { pauseForPrompt(): void; resumeAfterPrompt(): void; stop(): void } | undefined {
  if (!process.stdin.isTTY) return undefined;
  const promptText = `\n${ansis.yellow('?')} Reload the schema and swap the live policy? ${ansis.dim('press y to confirm, any other key cancels')}`;
  const handler = createReloadKeypressHandler({
    // Hold the live request log while the confirm prompt is up, and print the prompt
    // directly (bypassing the hold), so it doesn't scroll away. This is the same trick
    // the approval prompt uses; the held lines flush once the user answers.
    onArm: () => {
      activeApprovalPrompts += 1;
      console.error(promptText);
    },
    onCancel: () => {
      console.error(ansis.dim('  reload cancelled\n'));
      activeApprovalPrompts -= 1;
      flushDeferredProxyLogs();
    },
    onConfirm: () => {
      activeApprovalPrompts -= 1;
      flushDeferredProxyLogs();
      opts.onReload();
    },
  });
  const onData = (buf: Buffer) => {
    for (const ch of buf.toString('utf8')) {
      if (ch === '\u0003') { // Ctrl-C (raw mode swallows the default SIGINT)
        opts.onQuit();
        return;
      }
      handler.handleKey(ch);
    }
  };
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  return {
    pauseForPrompt() {
      process.stdin.off('data', onData);
      process.stdin.setRawMode?.(false);
    },
    resumeAfterPrompt() {
      process.stdin.setRawMode?.(true);
      process.stdin.on('data', onData);
    },
    stop() {
      process.stdin.off('data', onData);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
    },
  };
}

/** How often a proxy owner polls for a reload request. */
const RELOAD_POLL_INTERVAL_MS = 500;
/** How often `proxy reload` polls for its result, and how long it waits. */
const RELOAD_RESULT_POLL_INTERVAL_MS = 250;
const RELOAD_TIMEOUT_MS = 15 * 60_000;

/**
 * Poll the session's reload-request file and, when a new request appears,
 * hot-reload the live runtime: re-resolve the schema in this (trusted) process,
 * swap the policy via `runtime.reconfigure`, update the session record, and write
 * a result the blocking `proxy reload` reads. Returns `stop()` to clear the poller.
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

  const apply = async (request: ProxyReloadRequest): Promise<ProxyReloadResult> => {
    const { requestId } = request;
    // Refuse a reload requested from inside the proxied agent: applying it would let the
    // agent self-approve its own schema edit (re-blessing the fingerprint the guard pins).
    // A human must run `varlock proxy reload` from a trusted terminal. Surface the attempt
    // in the owner's log so a watching user sees it. (Self-reported signal, so a
    // marker-stripping agent evades it, same as the other in-tree guards; the out-of-band
    // approver is the real gate on a shared uid.)
    if (request.requestedFromProxyChild) {
      opts.log(
        `⚠️  Refused a schema reload requested from inside the proxied agent (session ${opts.session.id}). `
        + 'This stops the agent from self-approving its own schema edit. If you made this change, run '
        + '`varlock proxy reload` yourself from a trusted terminal to apply it.',
      );
      return {
        requestId,
        status: 'denied',
        completedAt: new Date().toISOString(),
        error: 'reload requested from inside the proxied agent; apply it from a trusted terminal instead',
      };
    }
    // TODO(approval): when a native/phone approver exists, gate a non-agent reload
    // here and return status 'denied' if refused. Today it applies directly.
    const result = await applyTrustedReload({
      session: opts.session,
      runtime: opts.runtime,
      requestedEntryPaths: request.entryPaths,
      defaultEntryPaths: opts.defaultEntryPaths,
      log: opts.log,
    });
    return result.ok
      ? {
        requestId, status: 'done', completedAt: new Date().toISOString(), managedItemCount: result.managedItemCount,
      }
      : {
        requestId, status: 'error', completedAt: new Date().toISOString(), error: result.error,
      };
  };

  const tick = async () => {
    if (busy || !initialized) return;
    const request = await readReloadRequest(opts.session.uuid);
    if (!request || request.requestId === lastRequestId) return;
    lastRequestId = request.requestId;
    busy = true;
    try {
      const result = await apply(request);
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

/**
 * Watch the session record for `proxy run` clients attaching/detaching and print a
 * line to the daemon's live log when one connects or leaves, plus the running count,
 * so a watching human has visibility into who's using the proxy. Clients are
 * distinguished by pid; attributing an individual request line to a specific client
 * needs per-client proxy identity (a bigger change) and is not done here.
 */
function startAttachmentWatcher(opts: { sessionUuid: string; log: (msg: string) => void }): { stop: () => void } {
  let known = new Set<number>();
  let seeded = false;
  const tick = async () => {
    const rec = await getProxySessionByToken(opts.sessionUuid).catch(() => undefined);
    if (!rec) return;
    const current = new Set((rec.attachedPids ?? []).filter((p) => isProcessRunning(p)));
    // seed silently on the first tick so we only announce changes, not the initial state
    if (!seeded) {
      known = current;
      seeded = true;
      return;
    }
    let changed = false;
    for (const pid of current) {
      if (known.has(pid)) continue;
      changed = true;
      opts.log(`${ansis.green('⊕')} client attached ${ansis.dim(`(pid ${pid})`)}`);
    }
    for (const pid of known) {
      if (current.has(pid)) continue;
      changed = true;
      opts.log(`${ansis.yellow('⊖')} client detached ${ansis.dim(`(pid ${pid})`)}`);
    }
    if (changed) opts.log(ansis.dim(`  ${current.size} client${current.size === 1 ? '' : 's'} connected`));
    known = current;
  };
  const timer = setInterval(() => {
    tick().catch(() => undefined);
  }, 1000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * Watch the schema files and warn (do not block) when the on-disk schema drifts from the
 * running proxy's policy. We deliberately don't block live requests on drift: the agent's
 * traffic (e.g. LLM calls) flows through this proxy, and blocking it would strand the agent.
 * Instead we surface it so a human can `proxy reload` to apply, or notice that a proxied
 * process edited the schema. Uses `fs.watch` (event-driven, no polling) and re-derives the
 * fingerprint only on a change (parse-only, so no secret resolution).
 */
function startSchemaDriftWatcher(opts: {
  sessionUuid: string;
  entryPaths?: Array<string>;
  reloadHint: string;
  log: (msg: string) => void;
}): { stop: () => void } {
  // Watch the directories holding the entry files (a dir watch catches atomic saves,
  // which rename a temp file into place, and new/removed `.env*` files); default to cwd.
  const dirs = new Set<string>();
  const entries = opts.entryPaths?.filter(Boolean);
  if (entries?.length) {
    for (const p of entries) {
      dirs.add(existsSync(p) && statSync(p).isDirectory() ? p : path.dirname(p));
    }
  } else {
    dirs.add(process.cwd());
  }

  let warnedFingerprint: string | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const check = async () => {
    let current: string;
    try {
      const graph = await loadVarlockEnvGraph({ entryFilePaths: opts.entryPaths, skipProxyFingerprintGuard: true });
      current = buildProxySchemaFingerprint(graph);
    } catch {
      return; // schema mid-edit / unparseable, retry on the next change event
    }
    const rec = await getProxySessionByToken(opts.sessionUuid).catch(() => undefined);
    const running = rec?.schemaFingerprint;
    if (!running || current === running) {
      warnedFingerprint = undefined; // in sync (reload applied, or the edit was reverted)
      return;
    }
    if (warnedFingerprint === current) return; // already warned for this exact drift
    warnedFingerprint = current;
    opts.log(
      `${ansis.yellow('⚠')}  Your env schema changed since this proxy started. New requests still use the `
      + `previous policy (rules, injected secrets, egress). ${opts.reloadHint} `
      + `${ansis.dim('If you did not edit it, a proxied process may have.')}`,
    );
  };

  const onFsEvent = (_event: string, filename: string | Buffer | null) => {
    // React only to `.env*` files (schema + overrides); some platforms omit the filename.
    const name = typeof filename === 'string' ? filename : filename?.toString();
    if (name && !name.startsWith('.env')) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      check().catch(() => undefined);
    }, 250);
  };

  const watchers: Array<ReturnType<typeof fsWatch>> = [];
  for (const dir of dirs) {
    try {
      watchers.push(fsWatch(dir, { persistent: false }, onFsEvent));
    } catch {
      // directory not watchable on this platform/fs; skip (drift warning is best-effort)
    }
  }

  return {
    stop() {
      if (debounce) clearTimeout(debounce);
      for (const w of watchers) w.close();
    },
  };
}

async function runAction(ctx: any) {
  const commandToRunAsArgs = getRunCommandArgs();
  const rawCommand = commandToRunAsArgs[0]!;
  const commandArgsOnly = commandToRunAsArgs.slice(1);
  const commandToRunStr = commandToRunAsArgs.join(' ');

  let sandboxSpec: SandboxSpec | undefined;
  try {
    sandboxSpec = parseSandboxSpec(ctx.values.sandbox);
  } catch (err) {
    throw new CliExitError((err as Error).message);
  }
  if (sandboxSpec) {
    const availability = checkSandboxAvailable(sandboxSpec);
    if (!availability.ok) {
      throw new CliExitError(availability.reason, {
        suggestion: 'See the proxy sandbox guide for the available options on your platform.',
      });
    }
    if (isContainerKind(sandboxSpec.kind) && !ctx.values['sandbox-image']) {
      throw new CliExitError(
        `\`--sandbox=${sandboxSpec.kind}\` needs an image to run your command in.`,
        { suggestion: 'Pass `--sandbox-image <image>` (an image that contains your command).' },
      );
    }
  }
  const sandboxIsContainer = sandboxSpec != null && isContainerKind(sandboxSpec.kind);

  // Attach to a running proxy for this directory (a `proxy start` daemon) when
  // possible — its terminal handles approvals — instead of a new auto-deny proxy.
  // --new forces a fresh proxy.
  const attachSession = ctx.values.new ? undefined : await resolveAttachSession(ctx);

  let session: ProxySessionRecord;
  let payload: SessionEnvPayload;
  /** Wire real values for redaction seeding: only a self-owned run holds them. */
  let redactionManagedItems: Array<ProxyManagedItem> | undefined;
  let statsWriter: ReturnType<typeof createSessionStatsWriter> | undefined;
  let cleanup: () => Promise<void>;

  if (attachSession) {
    // Adopt the running session's env: the owner resolved it in its own context
    // (its shell overrides, its env selection), and attaching means running
    // inside THAT session's env. No schema load, no resolution, and no unlock
    // prompt happens on this path.
    payload = await fetchSessionEnvPayload(attachSession);
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
    // Self-owned one-shot: the single trusted resolve happens here — the only
    // path in `proxy run` that touches resolvers or the encrypted cache.
    const policy = await prepareProxyPolicy(ctx.values.path);
    // Round-trip through the serializer so the common path exercises the exact
    // encoding attach receives over the wire (parity can't silently rot).
    payload = decodeSessionEnvPayload(encodeSessionEnvPayload(buildSessionEnvPayload(policy)));
    redactionManagedItems = policy.proxyManagedItems;
    // Reload posture (see resolveReloadMode). A one-shot `proxy run` re-reads the
    // schema on its next invocation, so `auto` resolves to off here; the flag or
    // `@proxyConfig={reload="manual"}` can still opt this self-owned run in.
    const { mode: reloadMode } = resolveReloadMode({
      flag: ctx.values['allow-reload'],
      schema: policy.serializedGraph.settings?.proxyReload,
      isStart: false,
      hasTty: isHumanAttended(),
    });
    const allowReload = reloadMode === 'manual';
    const created = await createRuntimeAndSession({
      policy,
      entryPaths: ctx.values.path,
      command: commandToRunAsArgs,
      // The child owns this terminal's stdio, so we can't safely prompt here —
      // require-approval requests fail closed. Use `proxy start` (or attach to one)
      // for interactive approval.
      approvalProvider: createAutoDenyApprovalProvider(),
      reloadable: allowReload,
    });
    session = created.session;
    statsWriter = created.statsWriter;
    console.error(`Proxy session ${session.id} active. Monitor with \`varlock proxy status --session ${session.id} --watch\`.`);
    // This run owns its proxy, so it services its own `proxy reload` reloads when
    // enabled. Notices go to stderr (the child owns stdout).
    const reloadServicer = allowReload
      ? startReloadServicer({
        session,
        runtime: created.runtime,
        defaultEntryPaths: ctx.values.path,
        log: (message) => console.error(message),
      })
      : undefined;
    cleanup = async () => {
      reloadServicer?.stop();
      await created.statsWriter.flushNow();
      created.statsWriter.stop();
      await created.runtime.stop().catch(() => undefined);
      await created.auditLog.flush().catch(() => undefined);
      await markProxySessionEnded(session.uuid).catch(() => undefined);
    };
  }

  const { injectVars, injectBlob } = resolveInjectMode(ctx.values.inject);

  let commandProcess: ReturnType<typeof spawnProxiedChild>;
  let sandboxTeardown: (() => void) | undefined;

  if (sandboxIsContainer) {
    const runtime = sandboxSpec!.kind as 'docker' | 'podman';
    const hostProxyUrl = session.env.HTTPS_PROXY ?? session.env.https_proxy;
    if (!hostProxyUrl) {
      throw new CliExitError('Proxy session is missing its URL; cannot set up the container sandbox.');
    }
    console.error(`Running the child in a ${runtime} sandbox (egress via the proxy; secrets stay on the host).`);
    const started = runContainerSandbox({
      runtime,
      image: ctx.values['sandbox-image'],
      command: rawCommand,
      commandArgs: commandArgsOnly,
      workdir: process.cwd(),
      sessionId: session.id,
      hostProxyUrl,
      childEnv: payload.env,
      sessionProxyEnv: session.env,
      hasTty: Boolean(process.stdout.isTTY && process.stdin.isTTY),
    });
    commandProcess = started.child;
    sandboxTeardown = started.teardown;
  } else {
    commandProcess = spawnProxiedChild({
      payload,
      session,
      rawCommand,
      commandArgsOnly,
      injectVars,
      injectBlob,
      redactStdoutFlag: ctx.values['redact-stdout'],
      redactionManagedItems,
      sandbox: sandboxSpec?.kind === 'builtin',
    });
    if (sandboxSpec?.kind === 'builtin') {
      console.error('Running the child inside the built-in sandbox (credential + egress jail).');
    }
  }

  if (commandProcess.pid && !attachSession) {
    await updateProxySessionRecord(session.uuid, { childPid: commandProcess.pid });
  }

  process.on('exit', () => {
    commandProcess?.kill(9);
    // Sync best-effort container cleanup: the `finally` below may not run when
    // gracefulExit tears the process down on a signal.
    sandboxTeardown?.();
  });

  ['SIGTERM', 'SIGINT'].forEach((signal) => {
    process.on(signal, () => {
      commandProcess?.kill(9);
      sandboxTeardown?.();
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
    // Tear down the container sandbox (forwarder + networks) before stopping the
    // host proxy, so nothing lingers if teardown races the proxy shutdown.
    if (sandboxTeardown) {
      try {
        sandboxTeardown();
      } catch {
        // best-effort cleanup
      }
    }
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
  // Reload posture, resolved at launch (see resolveReloadMode). `manual` runs the
  // reload servicer so a human can `proxy reload` from another shell in the folder; a reload
  // requested from inside the agent is refused (it would re-bless the fingerprint).
  const { mode: reloadMode, resolvedFromAuto } = resolveReloadMode({
    flag: ctx.values['allow-reload'],
    schema: policy.serializedGraph.settings?.proxyReload,
    isStart: true,
    hasTty: isHumanAttended(),
  });
  const allowReload = reloadMode === 'manual';
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
    reloadable: allowReload,
    // The daemon owns this terminal, so tail a live per-request/response log here.
    logRequests: true,
  });

  console.log(`Started proxy session ${fmtSessionId(session.id)} ${ansis.dim(`(${session.uuid})`)}`);
  console.log(ansis.dim(`Run \`varlock proxy env\` / \`reload\` / \`stop\` from this folder and they target this session automatically (or pass \`--session ${session.id}\` from elsewhere).`));
  const autoNote = resolvedFromAuto ? ' (auto)' : '';
  const canKeypressReload = allowReload && !!process.stdin.isTTY;
  if (allowReload) {
    const keyHint = canKeypressReload ? ' Or press `r` here (then `y` to confirm).' : '';
    console.log(`Reload: manual${autoNote}. After editing your schema, run \`varlock proxy reload\` from another shell in this folder (this one is running the proxy).${keyHint} Reloads from inside the agent are refused.`);
  } else {
    console.log(`Reload: off${autoNote}. Schema edits need a restart. Enable live reload with \`--allow-reload\` or \`@proxyConfig={reload="manual"}\`.`);
  }
  console.log(ansis.dim('─'.repeat(52)));
  console.log(ansis.dim('Live request log  (→ request · ← response · ⊕ client)'));

  // Service `proxy reload` requests: hot-reload the live policy without dropping
  // the proxy. The daemon owns this terminal, so reload notices print here. Only
  // runs when reload is explicitly enabled.
  const reloadServicer = allowReload
    ? startReloadServicer({
      session,
      runtime,
      defaultEntryPaths: ctx.values.path,
      log: (message) => console.log(message),
    })
    : undefined;

  // Announce `proxy run` clients attaching/detaching in the live log.
  const attachmentWatcher = startAttachmentWatcher({ sessionUuid: session.uuid, log: emitProxyLog });

  // Warn (never block) when the on-disk schema drifts from the running policy.
  let reloadHint = 'Restart the proxy to apply it.';
  if (allowReload) {
    reloadHint = canKeypressReload
      ? 'Run `varlock proxy reload` (or press r here) to apply it.'
      : 'Run `varlock proxy reload` to apply it.';
  }
  const schemaDriftWatcher = startSchemaDriftWatcher({
    sessionUuid: session.uuid,
    entryPaths: ctx.values.path,
    reloadHint,
    log: emitProxyLog,
  });

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    reloadServicer?.stop();
    attachmentWatcher.stop();
    schemaDriftWatcher.stop();
    daemonKeyControls?.stop();
    daemonKeyControls = undefined;
    await statsWriter.flushNow();
    statsWriter.stop();
    await runtime.stop().catch(() => undefined);
    await auditLog.flush().catch(() => undefined);
    // Grants stay as part of the session's durable record — not destroyed on stop.
    await markProxySessionEnded(session.uuid).catch(() => undefined);
  };

  await new Promise<void>((resolve) => {
    const close = () => {
      // Bound cleanup so a hung shutdown can't keep the daemon alive, then force
      // exit — after resolve, lingering handles could otherwise stop the process
      // from exiting, so `proxy stop`'s SIGTERM would appear ignored.
      Promise.race([
        cleanup(),
        new Promise<void>((r) => {
          setTimeout(r, 4000);
        }),
      ]).finally(() => {
        resolve();
        gracefulExit(0);
      });
    };

    process.on('SIGINT', close);
    process.on('SIGTERM', close);

    // Interactive daemon: `r` then `y` reloads the schema in place; Ctrl-C quits.
    if (canKeypressReload) {
      daemonKeyControls = startDaemonKeyControls({
        onReload: () => {
          applyTrustedReload({
            session,
            runtime,
            defaultEntryPaths: ctx.values.path,
            log: emitProxyLog,
          }).catch(() => undefined);
        },
        onQuit: close,
      });
    }
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
  const asJson = (ctx.values.format ?? '').toLowerCase() === 'json';
  const printSnapshot = async () => {
    await cleanupStaleProxySessions();
    const sessions = await collectStatusSessions(ctx);
    if (asJson) {
      console.log(JSON.stringify(sessions, null, 2));
      return sessions.length > 0;
    }
    if (!sessions.length) {
      console.log(ctx.values.all ? 'No proxy sessions.' : 'No active proxy sessions. (Use `--all` to include ended ones.)');
      return false;
    }
    console.log(renderSessionsTable(sessions));
    if (!ctx.values.all) {
      const ended = (await listProxySessions({ includeEnded: true })).filter((s) => s.endedAt).length;
      if (ended > 0) console.log(ansis.dim(`\n${ended} ended session${ended === 1 ? '' : 's'} hidden — \`proxy status --all\` to show, \`proxy prune\` to delete.`));
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

async function reloadAction(ctx: any) {
  const session = await resolveProxySessionForCommand({
    explicitSession: ctx.values.session,
    env: process.env,
    defaultToSingleActive: true,
  }).catch((error) => {
    throw new CliExitError((error as Error).message);
  });

  // Hot-reload is opt-in and only a session that owns a live runtime (`proxy
  // start`, or a self-owned `proxy run`) started with `--allow-reload` can do it.
  // An attached run has no runtime of its own — it routes through a daemon, which
  // is the session resolved here anyway.
  if (!session.reloadable) {
    throw new CliExitError(
      `Proxy session ${session.id} has hot-reload disabled.`,
      {
        suggestion: 'Restart the proxy to pick up schema edits, or enable live reload with '
          + '`varlock proxy start --allow-reload` (or `@proxyConfig={reload="manual"}`). On a shared uid the '
          + 'reload channel is only a bar-raiser, so prefer running behind a sandbox.',
      },
    );
  }
  if (!isProcessRunning(session.ownerPid)) {
    throw new CliExitError(`Proxy session ${session.id} is no longer running.`);
  }

  // Validate the new schema here (in this context) so an obviously broken edit
  // fails loudly at the call site, not only in the owner's logs. Only the
  // load/resolve/validate is needed; the owner recomputes the full policy when
  // it applies the reload.
  const reloadPaths = ctx.values.path ?? session.entryPaths;
  await loadResolvedProxyGraph(reloadPaths).catch((error) => {
    throw new CliExitError(`Schema does not resolve: ${(error as Error).message}`);
  });

  // Hand the reload to the process that owns the runtime via the file channel,
  // then block until it reports a result. (When the native/phone approver lands,
  // the wait also spans the approval step — same blocking contract.)
  const requestId = newReloadRequestId();
  // Self-report whether this reload was invoked from inside the proxied agent. The owner
  // refuses those (a human must apply schema edits from a trusted terminal) and logs the
  // attempt. We send the request through anyway, rather than blocking locally, so the owner
  // surfaces it to a watching user and hands back the explanation handled below.
  const requestedFromProxyChild = await isInProxyContext(process.env);
  await writeReloadRequest(session.uuid, {
    requestId,
    requestedAt: new Date().toISOString(),
    ...(ctx.values.path?.length ? { entryPaths: ctx.values.path } : {}),
    ...(requestedFromProxyChild ? { requestedFromProxyChild: true } : {}),
  });

  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  const deadline = Date.now() + RELOAD_TIMEOUT_MS;
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
        setTimeout(resolve, RELOAD_RESULT_POLL_INTERVAL_MS);
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
  if (result.status === 'denied') {
    throw new CliExitError(
      'Reload refused: this reload was requested from inside the proxied agent.',
      {
        details: result.error ? [result.error] : undefined,
        suggestion: 'Schema edits must be applied by a human from a trusted terminal: run '
          + '`varlock proxy reload` outside `varlock proxy run` so an agent cannot self-approve its own edit.',
      },
    );
  }
  if (result.status === 'error') {
    throw new CliExitError(`Proxy reload failed: ${result.error ?? 'unknown error'}`);
  }

  console.log(`✓ Schema change reloaded for proxy session ${session.id}.`);
  console.log('  • New requests through the proxy use the updated rules and secrets.');
  console.log('  • Newly launched `varlock proxy run -- …` children pick up the change; an already-running');
  console.log('    child keeps the env it started with (restart it to pick up new variables).');
}

/**
 * Stop one session. Only signals the owner pid when the session is *actually*
 * alive (its proxy port responds) — never a bare pid check, so we can't SIGTERM
 * an unrelated process that recycled a dead proxy's pid. A non-alive record is
 * just marked ended.
 */
/** Poll liveness until the session is gone or the deadline passes. */
async function waitForSessionExit(session: ProxySessionRecord, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProxySessionAlive(session))) return true;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150);
    });
  }
  return !(await isProxySessionAlive(session));
}

/**
 * Stop one session and VERIFY it actually died. A daemon can wedge in its
 * SIGTERM cleanup (e.g. `server.close()` blocking on a lingering connection), so
 * "sent SIGTERM" is not "stopped" — we send SIGTERM, wait, and escalate to
 * SIGKILL if it hasn't exited. Only signals when the port confirms the session
 * is live, so we never touch an unrelated process that reused a dead proxy's pid.
 */
async function stopOneSession(session: ProxySessionRecord): Promise<void> {
  if (session.endedAt) {
    console.log(`Proxy session ${session.id} is already ended.`);
    return;
  }
  if (!(await isProxySessionAlive(session))) {
    await markProxySessionEnded(session.uuid);
    console.log(`Marked proxy session ${session.id} ended (was not running).`);
    return;
  }

  const signal = async (sig: NodeJS.Signals): Promise<boolean> => {
    try {
      process.kill(session.ownerPid, sig);
      return true;
    } catch {
      return false;
    }
  };

  await signal('SIGTERM');
  if (await waitForSessionExit(session, 3000)) {
    await markProxySessionEnded(session.uuid);
    console.log(`Stopped proxy session ${session.id}.`);
    return;
  }

  // Wedged in cleanup — force it.
  console.log(`Proxy session ${session.id} did not exit on SIGTERM; sending SIGKILL…`);
  await signal('SIGKILL');
  if (await waitForSessionExit(session, 2000)) {
    await markProxySessionEnded(session.uuid);
    console.log(`Stopped proxy session ${session.id} (forced).`);
    return;
  }
  throw new CliExitError(
    `Could not stop proxy session ${session.id} (pid ${session.ownerPid}).`,
    { suggestion: `Kill it manually: \`kill -9 ${session.ownerPid}\`.` },
  );
}

async function stopAction(ctx: any) {
  await cleanupStaleProxySessions();

  // Refuse an ambiguous target rather than silently honoring the destructive `--all`.
  if (ctx.values.all && ctx.values.session) {
    throw new CliExitError(
      'Pass either --all or --session, not both.',
      { suggestion: 'Use `--session <id>` to stop one session, or `--all` to stop every session.' },
    );
  }

  if (ctx.values.all) {
    const sessions = await listProxySessions();
    if (!sessions.length) {
      console.log('No active proxy sessions.');
      return;
    }
    for (const session of sessions) {
      await stopOneSession(session);
    }
    return;
  }

  // Explicit id targets ANY session (live, ghost, or already-ended) so you can
  // always clean up a specific one by id. No --session → pick from active ones.
  const session = ctx.values.session
    ? await getProxySessionByToken(ctx.values.session, { includeEnded: true })
    : await pickSession(await listProxySessions(), {
      message: 'Which proxy session to stop?',
      noneError: 'No active proxy sessions.',
    });
  if (!session) {
    throw new CliExitError(`Proxy session "${ctx.values.session}" not found.`);
  }

  await stopOneSession(session);
}

async function pruneAction(ctx: any) {
  await cleanupStaleProxySessions();

  // Prune one specific session by id (any state, once it isn't running).
  if (ctx.values.session) {
    const target = await getProxySessionByToken(ctx.values.session, { includeEnded: true });
    if (!target) {
      throw new CliExitError(`Proxy session "${ctx.values.session}" not found.`);
    }
    if (!target.endedAt && await isProxySessionAlive(target)) {
      throw new CliExitError(
        `Proxy session ${target.id} is still running.`,
        { suggestion: `Stop it first: \`varlock proxy stop --session ${target.id}\`.` },
      );
    }
    await deleteProxySession(target.uuid);
    console.log(`Pruned proxy session ${target.id}.`);
    return;
  }

  const ended = (await listProxySessions({ includeEnded: true })).filter((s) => s.endedAt);
  if (!ended.length) {
    console.log('No ended proxy sessions to prune.');
    return;
  }
  if (process.stdin.isTTY && process.stdout.isTTY && !ctx.values.yes) {
    const ok = await select<boolean>({
      message: `Delete ${ended.length} ended proxy session record${ended.length === 1 ? '' : 's'} (records + audit logs)?`,
      options: [
        { value: false, label: 'Cancel' },
        { value: true, label: `Delete ${ended.length}`, hint: 'permanent' },
      ],
    });
    if (isCancel(ok) || !ok) {
      console.log('Nothing pruned.');
      return;
    }
  }
  const removed = await pruneEndedProxySessions();
  console.log(`Pruned ${removed.length} ended proxy session${removed.length === 1 ? '' : 's'}.`);
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

/** Human-readable gate for a rule: `block`, `approval (each=…, max=…)`, or empty. */
function describeProxyRuleGate(rule: ProxyRule): string {
  if (rule.block) return ansis.red('block (deny)');
  if (rule.approval) {
    const each = rule.approval.each ?? 'endpoint';
    let max: string;
    if (rule.approval.maxDurationMs === 0) max = 'always-ask';
    else if (rule.approval.maxDurationMs === undefined) max = 'session';
    else max = `${Math.max(1, Math.round(rule.approval.maxDurationMs / 60_000))}m`;
    return ansis.yellow(`approval (each=${each}, max=${max})`);
  }
  return '';
}

/**
 * Print a static summary of the effective `@proxy` configuration — the rules and
 * each secret's mode — without starting a proxy. Useful for verifying a schema
 * after the fail-closed validation, and for seeing what an agent would and
 * wouldn't be able to reach.
 */
async function rulesAction(ctx: any) {
  const envGraph = await loadVarlockEnvGraph({
    entryFilePaths: ctx.values.path,
    // This command inspects the schema; don't subject it to the nested guard.
    skipProxyFingerprintGuard: true,
  });
  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);
  await envGraph.resolveEnvValues(); // values aren't printed; resolution classifies items

  const egress = envGraph.getSerializedGraph().settings?.proxyEgress ?? 'permissive';
  const rules = await envGraph.getProxyRules();
  const managedItems = await envGraph.getProxyManagedItems();
  const managedKeys = new Set(managedItems.map((item) => item.key));
  const { placeholderByKey, omittedKeys } = await computeProxyChildView(envGraph, managedItems);
  const omittedSet = new Set(omittedKeys);

  console.log(ansis.bold('Proxy configuration'));
  console.log(`  egress mode: ${egress === 'strict' ? ansis.yellow('strict') : 'permissive'}`);
  console.log('');

  console.log(ansis.bold(`Rules (${rules.length})`));
  if (!rules.length) {
    console.log(ansis.dim('  (none; add @proxy(domain=...) to route a secret)'));
  } else {
    for (const rule of rules) {
      const target = rule.domain.join(', ')
        + (rule.path ? ` ${ansis.dim(rule.path)}` : '')
        + (rule.method?.length ? ` ${ansis.dim(`[${rule.method.join(',')}]`)}` : '');
      const parts = [target, describeProxyRuleGate(rule)];
      // A block rule denies the request, so it never injects — don't imply otherwise.
      if (rule.itemKeys.length && !rule.block) parts.push(`→ inject ${ansis.yellow(rule.itemKeys.join(', '))}`);
      console.log(`  • ${parts.filter(Boolean).join('  ')}`);
    }
  }
  console.log('');

  const secrets: Array<{ key: string; label: string }> = [];
  for (const key of envGraph.sortedConfigKeys) {
    if (isVarlockReservedKey(key)) continue;
    const item = envGraph.configSchema[key];
    if (!item) continue;
    if (managedKeys.has(key)) {
      secrets.push({ key, label: `${ansis.green('proxied')}: placeholder; real value injected on matching hosts` });
    } else if (omittedSet.has(key)) {
      secrets.push({ key, label: `${ansis.yellow('omit')}: withheld from the child entirely` });
    } else if (getProxyValueMode(item) === 'passthrough') {
      secrets.push({ key, label: `${ansis.red('passthrough')}: real value sent to the child` });
    } else if (placeholderByKey[key]) {
      secrets.push({ key, label: `${ansis.cyan('placeholder')}: sensitive, no rule (not injected anywhere)` });
    }
  }

  console.log(ansis.bold(`Secrets (${secrets.length})`));
  if (!secrets.length) {
    console.log(ansis.dim('  (none)'));
  } else {
    const width = Math.max(...secrets.map((s) => s.key.length));
    for (const { key, label } of secrets) console.log(`  ${key.padEnd(width)}  ${label}`);
  }
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const action = getAction(ctx);

  switch (action) {
    case 'run':
      return await runAction(ctx);
    case 'start':
      return await startAction(ctx);
    case 'rules':
      return await rulesAction(ctx);
    case 'env':
      return await envAction(ctx);
    case 'status':
      return await statusAction(ctx);
    case 'audit':
      return await auditAction(ctx);
    case 'reload':
      return await reloadAction(ctx);
    case 'stop':
      return await stopAction(ctx);
    case 'prune':
      return await pruneAction(ctx);
    default:
      throw new CliExitError(
        `Unknown proxy action "${action}".`,
        { suggestion: 'Use one of: run, start, rules, env, status, audit, reload, stop, prune' },
      );
  }
};
