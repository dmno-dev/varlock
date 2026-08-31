import { define, lazy } from 'gunshi';

import { REDACT_STDOUT_ARG } from '../helpers/redact-stdout-arg';

// Flags shared by several subcommands. Kept as small fragments spread into each
// subcommand's args so every verb declares only the flags it actually reads;
// native gunshi subcommands then give per-verb help + shell completion, which a
// single flat arg bag can't.
const sessionArg = {
  session: {
    type: 'string',
    short: 's',
    description: 'Proxy session ID/alias',
  },
} as const;

const pathArg = {
  path: {
    type: 'string',
    short: 'p',
    multiple: true,
    description: 'Path to a specific .env file or directory to use as the entry point (repeatable)',
  },
} as const;

const allowReloadArg = {
  'allow-reload': {
    type: 'boolean',
    negatable: true,
    description: 'Force the reload posture: `--allow-reload` = `manual` (human-applied from a trusted terminal; '
      + 'reloads requested from inside the agent are refused), `--no-allow-reload` = `off`. Otherwise '
      + '`@proxyConfig={reload=...}` applies, defaulting to `auto` (manual for an interactive `proxy start`, off '
      + 'for headless or one-shot `proxy run`).',
  },
} as const;

// Fix the proxy's loopback port / CA-cert location so a caller can wire tools to a
// known endpoint before it boots. Only meaningful when STARTING a proxy (proxy start,
// or proxy run that isn't attaching), so only those verbs declare them.
const bindArgs = {
  port: {
    type: 'string',
    description: 'Fixed loopback port for the proxy (else an ephemeral one), so you can point tools at a known '
      + 'HTTP(S)_PROXY before it starts. Fails to start if the port is in use.',
  },
  'cert-dir': {
    type: 'string',
    description: 'Directory to write the CA cert into (`ca-cert.pem` + `combined-ca.pem`), so tools can trust a '
      + 'known CA path before the proxy starts (else a fresh temp dir).',
  },
  'persist-ca': {
    type: 'boolean',
    description: 'Keep the CA in `--cert-dir` (including `ca-key.pem`, mode 0600) and reuse it on the next start, '
      + 'so a restart does not invalidate clients that already trust it. For long-lived brokers; the private key '
      + 'normally never touches disk, so only use this where the proxy runs alone.',
  },
  expose: {
    type: 'custom',
    // Bare `--expose` → bind 0.0.0.0; `--expose=<addr>` → a specific interface.
    parse: (value: string) => (value === '' || value == null ? '0.0.0.0' : value),
    description: 'Make this proxy reachable from another machine, so a client elsewhere can run through it '
      + '(`proxy run --url`). Binds off-loopback (bare `--expose` = 0.0.0.0; `--expose=<addr>` picks an interface) '
      + 'and serves the built-in WebSocket tunnel for clients behind HTTP-only ingress. Mints a per-session '
      + 'data-plane token clients must present (pin it with VARLOCK_PROXY_TOKEN, or read it back with `proxy '
      + 'token`). The control endpoint stays loopback-only.',
  },
} as const;

// The remote analog of `--session`: which proxy to target when it runs elsewhere.
const remoteArgs = {
  url: {
    type: 'string',
    description: 'Run through a proxy running elsewhere (a broker started with `--expose`): its tunnel URL '
      + '(wss://... or ws://...). Reached over the built-in WebSocket tunnel. Requires --token.',
  },
  token: {
    type: 'string',
    description: 'Data-plane token for `--url` (or set VARLOCK_PROXY_TOKEN). The broker prints it on start.',
  },
} as const;

export const runCommandSpec = define({
  name: 'run',
  description: 'Run a command through the proxy: attach to this directory\'s session, start one, or `--url` a remote broker',
  args: {
    ...sessionArg,
    ...pathArg,
    ...allowReloadArg,
    ...bindArgs,
    ...remoteArgs,
    new: {
      type: 'boolean',
      description: 'Start a fresh proxy instead of attaching to a running one for this directory',
    },
    sandbox: {
      type: 'custom',
      // Bare `--sandbox` → built-in; `--sandbox=docker|podman` → container backend.
      parse: (value: string) => (value === '' || value == null ? 'builtin' : value),
      description: 'Run the child in a sandbox whose only egress is the proxy. Bare `--sandbox` uses the '
        + 'built-in minimal OS jail (macOS `sandbox-exec`); `--sandbox=docker` (or `=podman`) runs the child in '
        + 'a container on an internal network, with a dumb forwarder bridging to the host proxy (secrets stay on '
        + 'the host). Opt-in.',
    },
    'sandbox-image': {
      type: 'string',
      description: 'For `--sandbox=docker|podman`: the container image the child runs in (must contain your '
        + 'command, e.g. a devcontainer image with `claude` installed).',
    },
    inject: {
      type: 'string',
      short: 'i',
      description: 'Control what gets injected into the child env: "all" (default), "vars", or "blob"',
    },
    ...REDACT_STDOUT_ARG,
  },
  examples: `
  varlock proxy run -- claude                   # attach to a running proxy for this dir, else start one
  varlock proxy run --session abc12 -- claude   # attach to a specific session (approvals prompt in its terminal)
  varlock proxy run --new -- claude             # force a fresh, separate proxy
  varlock proxy run --sandbox -- claude         # run the child in a minimal OS sandbox (macOS)
  varlock proxy run --sandbox=docker --sandbox-image my-agent -- claude   # run the child in a container
  `.trim(),
});

export const startCommandSpec = define({
  name: 'start',
  description: 'Start a proxy daemon with a live request log that `proxy run` can attach to',
  args: {
    ...pathArg,
    ...allowReloadArg,
    ...bindArgs,
  },
});

export const rulesCommandSpec = define({
  name: 'rules',
  description: 'Summarize the effective @proxy config for this schema (no proxy started)',
  args: {
    ...pathArg,
  },
});

export const envCommandSpec = define({
  name: 'env',
  description: 'Print a running session\'s proxy env (shell exports or json)',
  args: {
    ...sessionArg,
    format: {
      type: 'string',
      short: 'f',
      description: 'Output format: shell (default) or json',
    },
    full: {
      type: 'boolean',
      description: 'Emit the full env a proxied agent runs with (real values for non-secrets, placeholders for '
        + 'secrets), not just the wiring. Use this to build the env for a remote sandbox; combine with '
        + '--proxy-url / --cert-dir to repoint it.',
    },
    'proxy-url': {
      type: 'string',
      description: 'Repoint the proxy-URL vars for a guest that reaches the proxy elsewhere '
        + '(e.g. http://127.0.0.1:8888 for a tunnel). Implies --full. Default: this session\'s own address.',
    },
    'cert-dir': {
      type: 'string',
      description: 'Repoint the CA-path vars at the dir a guest reads the bundle from. Implies --full. '
        + 'Default: this session\'s own cert dir.',
    },
  },
});

export const statusCommandSpec = define({
  name: 'status',
  description: 'Show proxy session status',
  args: {
    ...sessionArg,
    all: {
      type: 'boolean',
      description: 'Include ended sessions',
    },
    format: {
      type: 'string',
      short: 'f',
      description: 'Output json instead of the table',
    },
    watch: {
      type: 'boolean',
      description: 'Continuously refresh the status output',
    },
    interval: {
      type: 'string',
      description: 'Polling interval in milliseconds for `--watch` (default: 1000)',
    },
  },
});

export const auditCommandSpec = define({
  name: 'audit',
  description: 'Show a proxy session\'s audit log',
  args: {
    ...sessionArg,
    format: {
      type: 'string',
      short: 'f',
      description: 'Output format: text (default) or json',
    },
  },
});

export const reloadCommandSpec = define({
  name: 'reload',
  description: 'Re-resolve the schema and hot-swap a running session\'s policy',
  args: {
    ...sessionArg,
    ...pathArg,
  },
});

export const stopCommandSpec = define({
  name: 'stop',
  description: 'Stop one or all proxy sessions',
  args: {
    ...sessionArg,
    all: {
      type: 'boolean',
      description: 'Stop all sessions',
    },
  },
});

export const pruneCommandSpec = define({
  name: 'prune',
  description: 'Delete ended session records (and their audit logs)',
  args: {
    ...sessionArg,
    yes: {
      type: 'boolean',
      short: 'y',
      description: 'Skip the confirmation prompt',
    },
  },
});

export const tokenCommandSpec = define({
  name: 'token',
  description: 'Print a session\'s data-plane token (for `proxy run --url`)',
  args: { ...sessionArg },
});

export const commandSpec = define({
  name: 'proxy',
  description: 'Manage proxy sessions for placeholder-based agent workflows',
  subCommands: {
    run: lazy(async () => (await import('./proxy.command')).runAction, runCommandSpec),
    start: lazy(async () => (await import('./proxy.command')).startAction, startCommandSpec),
    rules: lazy(async () => (await import('./proxy.command')).rulesAction, rulesCommandSpec),
    env: lazy(async () => (await import('./proxy.command')).envAction, envCommandSpec),
    token: lazy(async () => (await import('./proxy.command')).tokenAction, tokenCommandSpec),
    status: lazy(async () => (await import('./proxy.command')).statusAction, statusCommandSpec),
    audit: lazy(async () => (await import('./proxy.command')).auditAction, auditCommandSpec),
    reload: lazy(async () => (await import('./proxy.command')).reloadAction, reloadCommandSpec),
    stop: lazy(async () => (await import('./proxy.command')).stopAction, stopCommandSpec),
    prune: lazy(async () => (await import('./proxy.command')).pruneAction, pruneCommandSpec),
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
  varlock proxy env --session abc12             # this session's wiring env (source locally)
  varlock proxy env --full --proxy-url http://127.0.0.1:8888 --cert-dir /home/user/certs --format json   # full env for a remote sandbox
  varlock proxy start --expose                  # broker: reachable off-loopback, serving the WS tunnel
  varlock proxy token                           # read the broker's data-plane token
  varlock proxy run --url wss://8000-abc.e2b.app -- claude   # guest: run through a remote broker (token via VARLOCK_PROXY_TOKEN)
  varlock proxy status
  varlock proxy audit --session abc12
  varlock proxy reload --session abc12
  varlock proxy stop --session abc12
  varlock proxy stop --all
  varlock proxy prune                           # delete ALL ended session records (+ audit logs)
  varlock proxy prune --session abc12           # delete one session's record
  `.trim(),
});
