---
"@varlock/cloudflare-integration": patch
---

fix(cloudflare): harden varlock-wrangler FIFO server against CI races

The FIFO server child process now signals readiness on a dedicated
control pipe (fd 3) before the parent spawns downstream consumers
(wrangler), eliminating a race where wrangler could open the FIFO
before the child had buffered content and called the first
`writeFileSync` to open the FIFO for write — observed in Linux/Docker
CI environments as `The contents of "/tmp/varlock-secrets-..." is not
valid`.

Also:
- Forward child stderr to the parent so write failures are no longer
  swallowed by a silent `process.exit()`.
- Surface child write errors with iteration number and error code via
  the control pipe.
- Fix UTF-8 corruption that could occur when stdin chunks split a
  multi-byte character (use `Buffer.concat` instead of string `+=`).
