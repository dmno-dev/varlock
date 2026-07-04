import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { exec } from '../lib/exec';

/**
 * Container-runtime sandbox backend (`proxy run --sandbox=docker|podman`).
 *
 * Topology (derived from first principles, NOT the host-gateway-bind shape):
 * an `--internal` docker network is a hard egress boundary — a container on it
 * can reach *only other containers on that network*, the host included being
 * unreachable. So the proxy has to be reachable as a peer on that network. But
 * on macOS the proxy must resolve secrets on the host (the encryption key is
 * secure-enclave gated; a Linux container can't reach it), and we want to keep
 * interactive approvals + warm credential sessions on the host too.
 *
 * Resolution: keep the real proxy on the host and put a *dumb byte-forwarder*
 * (socat) container on the agent's internal network. It holds no secrets — it
 * relays `varlock-proxy:PORT` → the host proxy (`host.docker.internal`) and
 * nothing else. The agent container sits on the internal network ONLY, so its
 * sole egress is the forwarder → host proxy → policy-checked wire injection.
 *
 *   host: varlock proxy (127.0.0.1:hostPort)  ← custody, TLS CA, approvals, op
 *      ▲ host.docker.internal
 *   ┌─ forwarder (internal-net + bridge-net, no secrets) ─ hostname varlock-proxy
 *   │     ▲ TCP :guestPort
 *   └─ agent container (internal-net only) — raw egress fails closed
 */

/** Where the proxy certs dir (public certs only) is mounted read-only in-guest. */
const GUEST_CA_DIR = '/etc/varlock/proxy-certs';
/** Where the host cwd is mounted as the working directory in-guest. */
const GUEST_WORKDIR = '/workspace';
/** Port the forwarder listens on inside the agent network. */
const GUEST_PROXY_PORT = 8888;
/** DNS name the agent uses to reach the forwarder (its `--hostname`). */
const PROXY_HOSTNAME = 'varlock-proxy';
/** Small, widely-used socat image for the forwarder. Pulled on first use. */
const FORWARDER_IMAGE = 'alpine/socat:1.8.0.0';

/** CA-bundle env vars the proxy injects — all repoint to the in-guest mount. */
const CA_PATH_ENV_VARS = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO'];
/** Proxy-URL env vars — all repoint at the in-guest forwarder. */
const PROXY_URL_ENV_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

export type ContainerRuntime = 'docker' | 'podman';

/** True if the runtime CLI is on PATH and responding to `version`. */
export function isContainerRuntimeAvailable(runtime: ContainerRuntime): boolean {
  const res = spawnSync(runtime, ['version', '--format', '{{.Client.Version}}'], {
    stdio: 'ignore', timeout: 10000,
  });
  return res.status === 0;
}

/** Parse `http://127.0.0.1:PORT` → the port number. */
function hostProxyPort(proxyUrl: string): number {
  const port = Number(new URL(proxyUrl).port);
  if (!Number.isInteger(port) || port < 1) {
    throw new Error(`Could not determine the host proxy port from "${proxyUrl}".`);
  }
  return port;
}

export type ContainerSandboxWiring = {
  /** Guest env (`-e KEY=VALUE`): child-view vars, proxy repointed at the forwarder, CA in-guest. */
  env: Record<string, string>;
  /** Host dir holding the public CA certs, bind-mounted read-only into the guest. */
  caHostDir: string;
};

/**
 * Translate the child-view env + session proxy env into the env a guest gets,
 * repointing the proxy URL at the in-guest forwarder and the CA paths at the
 * in-guest mount. Pure — the single place the guest env is shaped, so the run
 * and any future emitter can't diverge.
 */
export function buildContainerWiring(opts: {
  /** The child-view env (`payload.env`): placeholders + non-secret values. */
  childEnv: Record<string, string>;
  /** The session's proxy env (HTTPS_PROXY, CA paths, NO_PROXY, ...). */
  sessionProxyEnv: Record<string, string>;
}): ContainerSandboxWiring {
  // The proxy writes several CA files (a proxy-CA-only bundle for Node's
  // NODE_EXTRA_CA_CERTS, a system+proxy combined bundle for OpenSSL's
  // SSL_CERT_FILE, ...) into ONE certs dir. We mount the whole dir read-only and
  // repoint each var at its OWN file's basename inside the mount — flattening
  // them all to one file would give OpenSSL the wrong bundle.
  const caHostSource = CA_PATH_ENV_VARS
    .map((key) => opts.sessionProxyEnv[key])
    .find((value): value is string => Boolean(value));
  if (!caHostSource) {
    throw new Error('Proxy session env is missing a CA bundle path. Restart the proxy session.');
  }
  const caHostDir = path.dirname(caHostSource);
  const guestProxyUrl = `http://${PROXY_HOSTNAME}:${GUEST_PROXY_PORT}`;

  // Start from the proxy env (CA + NO_PROXY + proxy URL) then overlay the child
  // view (placeholders/non-secrets). Repoint the CA + proxy vars for in-guest.
  const merged: Record<string, string> = { ...opts.sessionProxyEnv, ...opts.childEnv };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (CA_PATH_ENV_VARS.includes(key)) env[key] = `${GUEST_CA_DIR}/${path.basename(value)}`;
    else if (PROXY_URL_ENV_VARS.includes(key)) env[key] = guestProxyUrl;
    else env[key] = value;
  }
  return { env, caHostDir };
}

/** Names for the per-session networks + forwarder, derived from the session id. */
function resourceNames(sessionId: string) {
  const base = `varlock-${sessionId}`;
  return {
    agentNet: `${base}-agent`,
    egressNet: `${base}-egress`,
    forwarder: `${base}-fwd`,
    agent: `${base}-run`,
  };
}

function runRuntime(runtime: ContainerRuntime, args: Array<string>, label: string): void {
  const res = spawnSync(runtime, args, { encoding: 'utf8', timeout: 60000 });
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new Error(`${runtime} ${label} failed: ${detail || `exit ${res.status}`}`);
  }
}

/**
 * Set up the network + forwarder for a session and return a teardown fn. Any
 * partial setup is rolled back if a later step throws.
 */
function setupContainerNetwork(opts: {
  runtime: ContainerRuntime;
  sessionId: string;
  hostPort: number;
}): { names: ReturnType<typeof resourceNames>; teardown: () => void } {
  const { runtime, sessionId, hostPort } = opts;
  const names = resourceNames(sessionId);
  const teardown = () => {
    // Best-effort, reverse order. `docker rm -f` also detaches from networks.
    spawnSync(runtime, ['rm', '-f', names.forwarder], { stdio: 'ignore' });
    spawnSync(runtime, ['network', 'rm', names.agentNet], { stdio: 'ignore' });
    spawnSync(runtime, ['network', 'rm', names.egressNet], { stdio: 'ignore' });
  };
  try {
    runRuntime(runtime, ['network', 'create', '--internal', names.agentNet], 'network create (agent)');
    runRuntime(runtime, ['network', 'create', names.egressNet], 'network create (egress)');
    // Forwarder: agent-net facing the agent, then also attach egress-net so it
    // can reach the host. `--add-host … host-gateway` makes host.docker.internal
    // resolve on native Linux (auto on Docker Desktop) — harmless on both.
    runRuntime(runtime, [
      'run',
      '-d',
      '--name',
      names.forwarder,
      '--network',
      names.agentNet,
      '--hostname',
      PROXY_HOSTNAME,
      '--add-host',
      'host.docker.internal:host-gateway',
      FORWARDER_IMAGE,
      `TCP-LISTEN:${GUEST_PROXY_PORT},fork,reuseaddr`,
      `TCP:host.docker.internal:${hostPort}`,
    ], 'run (forwarder)');
    runRuntime(runtime, ['network', 'connect', names.egressNet, names.forwarder], 'network connect (egress)');
  } catch (err) {
    teardown();
    throw err;
  }
  return { names, teardown };
}

/**
 * Run the agent command inside a container whose only egress is the host proxy
 * (via the forwarder). Returns the running `docker run` child plus a teardown
 * that removes the forwarder + networks (the agent container is `--rm`).
 */
export function runContainerSandbox(opts: {
  runtime: ContainerRuntime;
  image: string;
  command: string;
  commandArgs: Array<string>;
  /** Host cwd, mounted as the in-guest working directory. */
  workdir: string;
  sessionId: string;
  /** The host proxy URL (`http://127.0.0.1:PORT`). */
  hostProxyUrl: string;
  childEnv: Record<string, string>;
  sessionProxyEnv: Record<string, string>;
  hasTty: boolean;
}) {
  const hostPort = hostProxyPort(opts.hostProxyUrl);
  const wiring = buildContainerWiring({
    childEnv: opts.childEnv,
    sessionProxyEnv: opts.sessionProxyEnv,
  });
  const { names, teardown } = setupContainerNetwork({
    runtime: opts.runtime, sessionId: opts.sessionId, hostPort,
  });

  const envFlags: Array<string> = [];
  for (const [key, value] of Object.entries(wiring.env)) {
    envFlags.push('-e', `${key}=${value}`);
  }

  const runArgs = [
    'run',
    '--rm',
    '--name',
    names.agent,
    '--network',
    names.agentNet,
    '-w',
    GUEST_WORKDIR,
    '-v',
    `${opts.workdir}:${GUEST_WORKDIR}`,
    '-v',
    `${wiring.caHostDir}:${GUEST_CA_DIR}:ro`,
    '-i',
    ...(opts.hasTty ? ['-t'] : []),
    ...envFlags,
    opts.image,
    opts.command,
    ...opts.commandArgs,
  ];

  const child = exec(opts.runtime, runArgs, { stdio: 'inherit' });
  return { child, teardown, names };
}
