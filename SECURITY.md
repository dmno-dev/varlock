# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this repository (`dmno-dev/varlock`), please follow these steps:

1. **Do not create a public issue.**
   - To protect users, please report vulnerabilities privately using GitHub's private reporting [feature](https://github.com/dmno-dev/varlock/security)
   - OR alternatively email: security@varlock.dev

3. **Include Relevant Details:**
   - Describe the vulnerability and potential impact.
   - Include steps to reproduce, if possible.
   - Suggest remediation or mitigation strategies if you have them.

## Scope

varlock has several layers, and they make different promises. Reports are triaged against these.

**In scope** (please report privately):

- Plaintext secrets exposed by varlock itself: on disk, in the encrypted env blob, in caches, in telemetry, in generated types or code, or in CLI output that is meant to be redacted.
- Encryption, key handling, and the local encryption daemon.
- The credential proxy: a way for a proxied process to obtain a plaintext credential, reach a destination the rules deny, or bypass approval.
- Redaction or leak prevention missing an **unmodified** sensitive value written whole through a covered path (`console`, `process.stdout`/`process.stderr` with stream redaction on, `varlock run` output, or an HTTP response body), with no opt-out in effect.
- Schema parsing, resolvers, plugins, or the CLI executing something they should not (for example a value from an untrusted source reaching `exec()`).

**Known limitations, not vulnerabilities.** Log redaction and leak prevention are guardrails against accidental exposure by trusted code, not a sandbox: code running inside the process has the plaintext and can always get it out through a path varlock does not watch. The documented limitations are listed in [Scope and known limitations](https://varlock.dev/guides/secrets/#redaction-scope) in the secrets guide. In particular, the following are expected behavior:

- Writing a value through a path redaction does not cover (`fs.writeSync`, files, sockets, worker threads, native code, child processes, output before varlock initialized, or via a reference to the original `console`/`write` captured before patching).
- Printing a value after transforming it (base64, hex, URL encoding, case changes, splitting it into pieces by hand, hashing).
- A value split across chunks by a child that pauses mid-value, or by code that relays output in arbitrary chunks without `varlock run`; the documented outcome is a partial mask plus a warning.
- Unredacted output on an interactive terminal, or under an explicit opt-out (`@redact=false`, `@sensitive={redact=false}`, `revealSensitiveConfig()`, `--no-redact-stdout`, `_VARLOCK_REDACT_STDOUT=0`).
- The first two characters of a masked value being visible (`my▒▒▒▒▒`).
- Contrived values that overlap themselves or each other, or values too short to redact meaningfully (varlock warns about these at load time).
- Leak prevention not catching values that reach a client outside a response body (headers, cookies, WebSockets, static assets, bundler inlining).

If you find a practical improvement to one of these, an ordinary issue or pull request is welcome; it just will not be handled as a security advisory. If you are unsure which category a finding falls in, report it privately and we will tell you.

## Supported Versions

| Version       | Supported          |
| ------------- | ------------------ |
| main/latest   | ✅                 |
| past releases | ❌                 |

We generally support the most recent release on the `main` branch. Older versions may not receive security updates.

## Disclosure Policy

- We aim to respond to vulnerability reports within **2 business days**.
- Once confirmed, we will work to resolve the issue and coordinate disclosure.
- You will be notified when the issue is resolved and if a public advisory will be published.

## Responsible Disclosure

We ask that you:
- Act in good faith and avoid data destruction or service disruption.
- Allow reasonable time for remediation before public disclosure.

Thank you for helping keep `varlock` and its users safe!
