# Docker sandboxes + credential broker: spike findings

Question: can a Docker-sandboxed agent use the broker topology (`proxy start --expose` on
the host, `proxy run --url` in the guest), given that a locked-down container can't reach
the host network?

Verified empirically on Docker Desktop 29.1.3 (macOS, VirtioFS), including two live
end-to-end runs through the real broker + tunnel (agent image = node:22 + npm-installed
`pack:local` tarball; fixture schema with `@proxy(domain="postman-echo.com")`).

## Verified facts

| # | Test | Result |
|---|------|--------|
| 1 | default bridge -> `host.docker.internal:port` | reachable |
| 2 | `--internal` net -> host (even with `--add-host host-gateway`) | fails: network unreachable |
| 3 | host service bound to `127.0.0.1` only, via `host.docker.internal` | reachable on Docker Desktop (routes to host loopback); native Linux host-gateway does NOT |
| 4 | host-created unix socket bind-mounted into container | fails: `connect(): Not supported` (VirtioFS won't carry a UDS across the macOS/VM boundary; works on native Linux) |
| 5 | container-created UDS in bind-mounted host dir, host connects | fails too (same boundary, both directions) |
| 6 | UDS in a named volume shared between two containers, agent on `--network=none` | works |

End-to-end runs (broker: `proxy start --expose --port 18080` on the host):

- **Variant A** (shipped `--sandbox=docker` shape carrying the tunnel): agent on an
  `--internal` net, socat sidecar (`varlock-proxy:8888` -> `host.docker.internal:18080`),
  agent runs `varlock proxy run --url ws://varlock-proxy:8888 --token ... -- curl ...`.
  PASS: broker log shows `inject: MY_API_KEY` / `scrubbed: MY_API_KEY`, agent saw
  `Bearer sk▒▒▒▒▒`.
- **Variant B** (file-socket shape): agent on `--network=none`, socat sidecar bridging
  `UNIX-LISTEN:/vsock/tunnel.sock` (named volume) -> `TCP:host.docker.internal:18080`,
  plus an in-agent socat shim `127.0.0.1:8888 -> UNIX-CONNECT:/vsock/tunnel.sock` (only
  because `proxy run --url` can't dial a UDS yet). PASS, same inject/scrub evidence.

So the premise holds for the case that matters: a sandbox-grade network (`--internal` or
`none`) cannot reach the host broker over TCP, and the naive
`--url ws://host.docker.internal` fails. But the tunnel rides fine over any byte pipe;
only the transport reach is the problem, and two workable paths are proven.

## Design gap found in passing

`proxy start --expose=127.0.0.1` boots but silently serves no tunnel and mints no token
(`bindIsLoopback` in proxy.command.ts gates `dataPlaneToken`, and runtime-proxy only
attaches the tunnel when a token exists). Today the only way to get the tunnel is a
0.0.0.0 (LAN-visible) bind. Docker Desktop can reach loopback-bound host services
(fact 3), so a "tunnel on loopback" mode is exactly what local docker wants. It is also a
UX trap: `--expose=127.0.0.1` looks like it worked.

## Options

1. **Docs-only recipe (works today, zero code).** Variant A: `--expose` + socat sidecar +
   `proxy run --url ws://varlock-proxy:8888`. Cost: none. Downsides: broker listens on the
   LAN (token-gated, but a real surface), manual multi-step docker setup, agent keeps a
   network stack + embedded DNS + sidecar reachability.

2. **Loopback expose mode (small).** Serve the tunnel + mint the token on a loopback bind
   (`--expose=127.0.0.1` gains meaning, or a dedicated flag). The Docker Desktop sidecar
   then reaches a broker that never leaves 127.0.0.1. Native Linux caveat: host-gateway
   cannot reach loopback-bound services, so Linux needs option 3 (or a bridge-IP bind).

3. **UDS transport for the tunnel (recommended).**
   - Broker: `--expose-socket[=path]` serves the same tunnel protocol on a unix socket
     (can coexist with TCP expose). Keep token auth: a mounted socket is not a trusted
     caller.
   - Guest: `proxy run --socket /path/tunnel.sock` (or `--url unix://...`). The native
     WebSocket client can't dial a UDS, but the only UDS client is our own CLI; the
     RFC 6455 codec in tunnel.ts is ours, so either add a small masked-frame client codec
     and keep one framing for both transports (keeps `handleTunnelConnection` unchanged),
     or run the protocol with minimal framing over the socket.
   - Per-platform topology:
     - **Native Linux: no sidecar at all.** Bind-mount the broker's socket into the agent
       (`-v /run/varlock/xyz.sock:/varlock.sock`), agent on `--network=none` or
       `--internal`. No TCP anywhere, no LAN exposure, no forwarder container.
     - **macOS Docker Desktop: sidecar still required** (fact 4 kills the direct UDS
       bind-mount). Named-volume UDS + socat sidecar -> host TCP (loopback, with
       option 2). The agent still gets `--network=none` (proven in variant B), which is
       strictly stronger than `--internal`: no interfaces, no DNS, no
       container-to-container reach; the mounted socket is the only channel out.
   - The in-agent socat shim from variant B disappears once `proxy run` dials the UDS
     itself.

4. **Extend the shipped `--sandbox=docker` instead: no.** The two integration shapes are
   different products:
   - *varlock spawns the container*: already shipped (`proxy run --sandbox=docker`,
     CONNECT proxy + forwarder, env injected via `docker -e`, no varlock needed in-image).
   - *container attaches to a broker* (this spike): for containers varlock did NOT start:
     compose stacks, devcontainers, CI jobs, third-party runners, N agents sharing one
     broker. This is the gap the tunnel/UDS work fills; it should not be folded into
     `--sandbox`.

Rejected transports: `docker exec` stdio tunnel (inverted initiation, needs muxing,
docker-only); vsock (not portably exposed by docker); agent-listens/broker-dials (inverts
the trust model); `--network=host` (no sandbox).

## Recommendation

Do 3 + 2 together, with the docs recipe (1) in the interim:

- tunnel.ts: transport-agnostic client/server framing; UDS listener on the broker; UDS
  dial in `proxy run`.
- proxy.command.ts: `--expose-socket[=path]`; make a loopback `--expose=<addr>` serve the
  tunnel + token (or error loudly instead of silently degrading).
- Guide: Linux (pure bind-mount, `--network=none`) and macOS (named volume + socat
  sidecar) recipes.

## Repro crumbs

- Agent image: `node:22-bookworm-slim` + curl + socat + `npm i -g varlock-<v>.tgz`
  (from `bun run --filter varlock pack:local`).
- Broker fixture: the E2B guide's schema/local pair, `VARLOCK_PROXY_TOKEN` pinned, run via
  `node packages/varlock/bin/cli.js proxy start --expose --port 18080`.
- Sidecar: `alpine/socat:1.8.0.0`, `UNIX-LISTEN:/vsock/tunnel.sock,fork,unlink-early
  TCP:host.docker.internal:18080`, with `--add-host host.docker.internal:host-gateway`.
- To re-verify when Linux work starts: podman-machine (applehv) and Apple `container`
  presumably share the VM/UDS limitation; untested.
