import { realpathSync } from 'node:fs';

import { getUserVarlockDir } from '../lib/user-config-dir';

/**
 * Generates the OS-level "credential + egress jail" that `proxy run --sandbox`
 * wraps the child in.
 *
 * This is the built-in minimal sandbox tier. It is NOT total isolation — the
 * agent + varlock + integrations legitimately run inside it (`.env` is
 * ciphertext, so reading the project is safe). The jail denies exactly one
 * capability — resolving a sensitive item to its real value — plus the escape
 * routes, by removing:
 *   - direct non-loopback network (the proxy on 127.0.0.1 becomes the sole
 *     egress; every request is then subject to proxy policy),
 *   - reads/writes of the user varlock dir (encryption key, plugin/credential
 *     cache, and the proxy session dir whose `session.json` is the privileged
 *     token/reload channel),
 *   - unix-socket *connections* into the user varlock dir, denied SEPARATELY
 *     from the file-read/write deny because a file deny does NOT gate a socket
 *     `connect()`. The local-encrypt daemon listens on a socket under this dir;
 *     without this deny an escaped child could connect to the warm daemon and
 *     have it decrypt secrets (no Touch ID), bypassing the jail entirely, and
 *   - mach lookups to warm credential agents (1Password, ...).
 *
 * Removing the *capability* is what makes the same-uid "out-of-tree escape"
 * (env-scrub + double-fork/`setsid` to evade process-ancestry detection)
 * harmless: a detached process inside the jail still can't reach a resolution
 * source and can only egress through the proxy.
 */

/** Only macOS (`sandbox-exec`) is supported by the built-in tier today. */
export function isBuiltinSandboxSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

/** Absolute path to the `sandbox-exec` binary shipped on every macOS. */
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/** mach service prefixes for warm credential agents we deny lookups to by default. */
const DEFAULT_DENY_MACH_PREFIXES = ['com.1password'];

export type SeatbeltProfileInputs = {
  /**
   * Absolute dirs to deny all file reads/writes on. Defaults to the resolved
   * user varlock dir (key material, caches, and the proxy session/reload
   * channel all live under it).
   */
  denyPaths?: Array<string>;
  /** mach service-name prefixes to deny lookups on (warm credential agents). */
  denyMachPrefixes?: Array<string>;
};

/** Escape a filesystem path / literal for a double-quoted SBPL string. */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Resolve to a real, absolute path when the target exists (macOS symlinks
 * `/tmp` → `/private/tmp`, and the sandbox matches on the real path). A
 * non-existent path is left as-is — denying it is still harmless.
 */
function toRealPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Build the SBPL (Seatbelt) profile string passed to `sandbox-exec -p`.
 *
 * Base posture is allow-all; we subtract the credential + egress capabilities.
 * The network tokens are exact on purpose: `(allow network* (remote unix))`
 * keeps local unix sockets working (DNS via mDNSResponder, syslog, etc. — the
 * agent and varlock need them) while loopback-only IP inbound/outbound/bind make
 * the proxy on 127.0.0.1 the only reachable *network* endpoint. Off-loopback IP
 * egress is denied. The one unix socket that must NOT stay reachable — the
 * local-encrypt daemon under the varlock dir — is carved back out by the
 * path-scoped `unix-socket` deny in the credential-jail section below (a broad
 * `unix-socket` token would re-open all egress, so the deny is scoped by path).
 */
export function buildSeatbeltProfile(inputs: SeatbeltProfileInputs = {}): string {
  const denyPaths = (inputs.denyPaths ?? [getUserVarlockDir()]).map(toRealPath);
  const denyMachPrefixes = inputs.denyMachPrefixes ?? DEFAULT_DENY_MACH_PREFIXES;

  const lines: Array<string> = [
    '(version 1)',
    '(allow default)',
    '',
    ';; --- egress jail: proxy on loopback is the only reachable endpoint ---',
    '(deny network*)',
    '(allow network* (remote unix))',
    '(allow network-outbound (remote ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-bind (local ip "localhost:*"))',
  ];

  if (denyPaths.length) {
    lines.push('', ';; --- credential jail: key material, caches, session/reload channel ---');
    for (const p of denyPaths) {
      lines.push(`(deny file-read* file-write* (subpath ${sbplString(p)}))`);
      // A file-read/write deny does NOT gate a unix-socket `connect()`. The
      // local-encrypt daemon socket lives under this dir, so this second deny is
      // what actually stops an escaped child from reaching the warm daemon and
      // having it decrypt secrets. Emitted AFTER `(allow network* (remote unix))`
      // above so it wins (SBPL is last-match-wins). Uses the `unix-socket` filter
      // scoped to this subpath — the broad token would re-open all egress, but a
      // path-scoped deny only removes egress to sockets under this dir.
      lines.push(`(deny network-outbound (remote unix-socket (subpath ${sbplString(p)})))`);
    }
  }

  if (denyMachPrefixes.length) {
    lines.push('', ';; --- starve warm credential agents ---');
    for (const prefix of denyMachPrefixes) {
      lines.push(`(deny mach-lookup (global-name-prefix ${sbplString(prefix)}))`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Wrap a command in the built-in sandbox: returns the `sandbox-exec` argv that
 * runs `command`/`args` under the generated profile. The profile is passed
 * inline via `-p` (no temp file, no TOCTOU, nothing to clean up).
 *
 * Throws if the platform has no built-in sandbox — callers point the user at
 * the bring-your-own (Docker / Apple `container`) tier in that case.
 */
export function wrapCommandWithSandbox(
  command: string,
  args: Array<string>,
  inputs?: SeatbeltProfileInputs,
): { command: string; args: Array<string> } {
  if (!isBuiltinSandboxSupported()) {
    throw new Error(
      'The built-in --sandbox is only available on macOS. On other platforms, run the proxy '
      + 'inside a container/VM instead (see the sandbox guide).',
    );
  }
  const profile = buildSeatbeltProfile(inputs);
  return {
    command: SANDBOX_EXEC_PATH,
    args: ['-p', profile, command, ...args],
  };
}
