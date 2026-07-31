# Docker Sandboxes (sbx) + varlock credential broker: spike findings

Tested live on sbx v0.37.1 (macOS, Apple silicon, standalone `sbx` CLI, balanced
policy), 2026-07-30. Includes a passing end-to-end of the varlock broker with an agent
inside an sbx microVM, plus notes to pass to the Docker team.

## How sbx networking actually works (observed)

- Sandboxes are microVMs. Egress is wired three ways at once:
  - explicit env proxy: `HTTP(S)_PROXY=http://gateway.docker.internal:3128`, plus
    `NODE_USE_ENV_PROXY=1`, `JAVA_TOOL_OPTIONS`, and CA env vars
    (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`) pointed at a trust
    store that includes a "Docker Sandboxes Proxy CA" (also exported as
    `PROXY_CA_CERT_B64`)
  - a transparent path: direct TCP to allowed hosts on 443 works without the proxy env
    and shows the origin's real certificate (SNI-gated, `sbx policy log` labels it
    `transparent` vs `forward` / `forward-bypass`)
  - DNS filtering: non-allowed domains do not resolve
- TLS MITM is selective and dynamic: with no secret stored, even `api.anthropic.com` is
  tunneled with its real certificate. Storing a secret for a host flips that host to
  MITM (issuer becomes the sbx CA) so headers can be injected.
- Credential model is the placeholder pattern: built-in service secrets surface env vars
  like `ANTHROPIC_API_KEY=proxy-managed`; `sbx secret set-custom` generates a
  placeholder (`sbx-cs-<rand>`), sets it as an env var, and the gateway substitutes the
  real value in request headers for matching hosts. Architecturally this is a
  fixed-function version of the varlock proxy.

## End-to-end: varlock broker + sbx sandbox (PASS)

Topology: `varlock proxy start --expose --port 18080` on the host;
`varlock proxy run --url ... --token ...` inside the sandbox (installed via
workspace-mounted `pack:local` tarball; the shell template ships Node 22).

1. `sbx policy allow network localhost:18080` is the rule that opens the path. The
   gateway rewrites `host.docker.internal` to `localhost` before policy evaluation, so
   allowing `host.docker.internal:18080` does NOT work (see notes below), but once
   `localhost:18080` is allowed, `http://host.docker.internal:18080` from the sandbox
   reaches the host broker through the gateway.
2. The tunnel WS must be dialed through the gateway (`CONNECT` via
   `gateway.docker.internal:3128`). varlock's tunnel client uses the runtime's native
   WebSocket, which ignores proxy env vars, so today it needs a shim; with one in place
   the full flow passes:

   ```
   socat TCP-LISTEN:18081,bind=127.0.0.1,fork PROXY:gateway.docker.internal:host.docker.internal:18080,proxyport=3128 &
   varlock proxy run --url ws://127.0.0.1:18081 --token <token> -- <command>
   ```

   Result: broker log shows `inject: MY_API_KEY` / `scrubbed: MY_API_KEY`; the agent saw
   only the placeholder. Host custody (enclave, 1Password, approvals) composes with
   sbx's microVM isolation.
3. varlock work item to make this first-class: teach the tunnel client to honor
   `HTTP(S)_PROXY` for its WebSocket dial (CONNECT through an egress proxy). This also
   helps any provider or corporate network that fronts sandboxes with an explicit proxy.
   With that, the recipe is two commands: one policy rule + `proxy run --url`.
4. WSS to an allowed public domain also works from inside (native WebSocket, proven via
   an echo server), so the remote-broker path (Fly/Vercel/E2B-style public URL) works
   with zero changes once the broker domain is allowlisted.

## Chaining (`DOCKER_SANDBOXES_PROXY`): wrong seam

Pointing the daemon at varlock as its upstream proxy mechanically works: the gateway
forwards per-destination `CONNECT`s (varlock logged and policy-blocked
`registry.npmjs.org`). But TLS layering kills it as an integration point:

- for sbx-MITMed hosts, the gateway is the TLS client and does not trust varlock's CA
- for tunneled hosts, the client in the VM trusts only the sbx CA, so varlock's MITM
  fails there too

Two MITM proxies cannot stack unless the outer one can be told to trust the inner's CA.
Also `sbx daemon start` runs in the foreground (fine), and routing the daemon's own
control-plane traffic through a strict upstream will break it.

## Notes for the Docker team

Bugs / mismatches:

1. `host.docker.internal` is rewritten to `localhost` before policy evaluation, so an
   allow rule for `host.docker.internal:PORT` never matches (the deny message says
   `domain localhost:PORT`), while `sbx policy check network host.docker.internal:PORT`
   evaluates the literal name and answers "Allowed". The working rule
   (`localhost:PORT`) is undiscoverable from either surface.
2. Those denials never show up in `sbx policy log`, which makes 1 harder to debug.
3. Custom secrets cannot be removed: every form of `sbx secret rm` reports
   `No secret found for service ... in scope "(global)"`, while `set-custom` says the
   secret exists in scope `"_"`. (v0.37.1, `set-custom` is experimental.)
4. Docs say loopback/private/host access is blocked; in practice explicit policy rules
   for `localhost:PORT` and LAN IPs do route (useful! but the docs and the hard-block
   claim should agree, and it deserves a documented recipe if intentional).

Security gap worth fixing:

5. Injected secrets come back unscrubbed in response bodies. With a custom secret for
   `postman-echo.com`, `curl https://postman-echo.com/get -H "authorization: Bearer
   <placeholder>"` returns the REAL secret in the echoed body, inside the sandbox. Any
   allowlisted endpoint that reflects request data (echo endpoints, error messages
   quoting headers, request-logging dashboards) hands the agent the real credential,
   defeating "the secret never enters the sandbox". Mitigation: scan/scrub response
   bodies for injected values (varlock does this), and consider capping substitution
   occurrences per request.

Feature requests that would make third-party credential brokers first-class:

6. A way for the gateway to trust an extra CA for upstream connections
   (`DOCKER_SANDBOXES_PROXY` + corporate or broker MITM CAs cannot compose today).
7. A documented, supported policy recipe for reaching a host-local service (today:
   `sbx policy allow network localhost:PORT`), or a first-class "expose host port into
   sandbox policy" flag.
8. Pluggable secret backends for the gateway's injection (today: OS keychain values
   only). A broker like varlock could then own custody (biometric gating, approvals,
   audit) while sbx keeps the data plane.

## Comparison snapshot (sbx gateway vs varlock proxy)

Both: explicit proxy + CA in guest, placeholder env vars, host-side header injection,
domain allowlists. sbx adds microVM isolation + DNS filtering + transparent SNI gating
(deeper enforcement than varlock's same-host proxy). varlock adds schema-driven config,
response scrubbing/leak scanning, substitution-surface guards, approvals (TTY today,
phone/passkey planned), audit log, non-custodial custody (enclave/1Password), and works
across providers. The composition that uses each for what it is best at: sbx for
isolation + egress enforcement, varlock broker for custody + injection + scrubbing.

## Repro crumbs

- Install: `brew trust docker/tap && brew install docker/tap/sbx && sbx login`, then
  `sbx policy init balanced`.
- Probe sandbox: `sbx create --name vlspike shell <dir>`, `sbx exec vlspike -- sh -c ...`
  (`shell` template has node 22, curl, socat, git).
- Policy log labels: `transparent`, `forward`, `forward-bypass`; MITM state visible via
  `openssl s_client -proxy gateway.docker.internal:3128 -connect <host>:443`.
- Broker fixture: same as DOCKER_SANDBOX_BROKER_SPIKE.md (postman-echo schema,
  `VARLOCK_PROXY_TOKEN` pinned).
