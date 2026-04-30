export type BridgeAddr = | { kind: 'unix'; path: string }
  | { kind: 'tcp'; host: string; port: number };

/**
 * Parses a bridge address string. Supports:
 *   - Unix socket path:  "/tmp/varlock-op-bridge.sock", "~/foo.sock"
 *   - TCP address:       "host.docker.internal:4455", "127.0.0.1:4455", ":4455"
 *
 * TCP detection rule: contains a `:` AND the portion after the last `:`
 * parses as a port number (1..65535). The `host:` prefix is optional — a bare
 * "4455" or ":4455" is treated as TCP on 127.0.0.1.
 */
export function parseBridgeAddr(raw: string): BridgeAddr {
  const s = raw.trim();
  if (!s) throw new Error('empty bridge address');

  // Bare numeric port
  if (/^\d+$/.test(s)) {
    const port = Number(s);
    if (port >= 1 && port <= 65535) return { kind: 'tcp', host: '127.0.0.1', port };
  }

  // host:port
  const colonIdx = s.lastIndexOf(':');
  if (colonIdx !== -1) {
    const hostPart = s.slice(0, colonIdx);
    const portPart = s.slice(colonIdx + 1);
    if (/^\d+$/.test(portPart)) {
      const port = Number(portPart);
      if (port >= 1 && port <= 65535) {
        const host = hostPart || '127.0.0.1';
        // Only treat as TCP if host doesn't look like a path (no '/' or '\')
        if (!host.includes('/') && !host.includes('\\')) {
          return { kind: 'tcp', host, port };
        }
      }
    }
  }

  // Fallback: treat as Unix socket path
  return { kind: 'unix', path: s };
}

export function describeAddr(addr: BridgeAddr): string {
  return addr.kind === 'unix' ? addr.path : `${addr.host}:${addr.port}`;
}
