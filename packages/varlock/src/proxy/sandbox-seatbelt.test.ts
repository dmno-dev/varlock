import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync,
} from 'node:fs';

import {
  describe, expect, test, afterAll,
} from 'vitest';

import {
  buildSeatbeltProfile,
  isBuiltinSandboxSupported,
  wrapCommandWithSandbox,
  SANDBOX_EXEC_PATH,
} from './sandbox-seatbelt';

describe('buildSeatbeltProfile', () => {
  test('emits an allow-default base with the loopback-only egress jail', () => {
    const profile = buildSeatbeltProfile({ denyPaths: [], denyMachPrefixes: [] });
    expect(profile).toContain('(allow default)');
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(profile).toContain('(allow network-inbound (local ip "localhost:*"))');
    expect(profile).toContain('(allow network-bind (local ip "localhost:*"))');
  });

  test('uses the `(remote unix)` token, never `unix-socket` (which fails open)', () => {
    const profile = buildSeatbeltProfile({ denyPaths: [], denyMachPrefixes: [] });
    expect(profile).toContain('(allow network* (remote unix))');
    // `unix-socket` silently re-opens ALL egress — it must never appear.
    expect(profile).not.toContain('unix-socket');
  });

  test('denies reads/writes on each deny path and escapes it for SBPL', () => {
    const profile = buildSeatbeltProfile({
      denyPaths: ['/tmp/no where/"quoted"'],
      denyMachPrefixes: [],
    });
    expect(profile).toContain('(deny file-read* file-write* (subpath "/tmp/no where/\\"quoted\\""))');
  });

  test('denies mach-lookup for each credential-agent prefix', () => {
    const profile = buildSeatbeltProfile({ denyPaths: [], denyMachPrefixes: ['com.1password', 'com.acme'] });
    expect(profile).toContain('(deny mach-lookup (global-name-prefix "com.1password"))');
    expect(profile).toContain('(deny mach-lookup (global-name-prefix "com.acme"))');
  });

  test('defaults deny the user varlock dir and 1Password without explicit inputs', () => {
    const profile = buildSeatbeltProfile();
    expect(profile).toContain('(subpath "');
    expect(profile).toContain('(deny mach-lookup (global-name-prefix "com.1password"))');
  });
});

describe('isBuiltinSandboxSupported', () => {
  test('is macOS-only', () => {
    expect(isBuiltinSandboxSupported('darwin')).toBe(true);
    expect(isBuiltinSandboxSupported('linux')).toBe(false);
    expect(isBuiltinSandboxSupported('win32')).toBe(false);
  });
});

describe.skipIf(process.platform !== 'darwin')('wrapCommandWithSandbox (macOS)', () => {
  test('wraps the command in a `sandbox-exec -p <profile>` argv', () => {
    const { command, args } = wrapCommandWithSandbox('claude', ['--flag', 'x']);
    expect(command).toBe(SANDBOX_EXEC_PATH);
    expect(args[0]).toBe('-p');
    expect(args[1]).toContain('(allow default)');
    // command + its args follow the profile, in order
    expect(args.slice(2)).toEqual(['claude', '--flag', 'x']);
  });
});

// End-to-end proof the jail actually bites. macOS only (`sandbox-exec`).
describe.skipIf(process.platform !== 'darwin')('sandbox-exec jail (integration)', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'varlock-sbx-'));
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

  const runSandboxed = (profile: string, cmd: string, cmdArgs: Array<string>) => spawnSync(
    SANDBOX_EXEC_PATH,
    ['-p', profile, cmd, ...cmdArgs],
    { encoding: 'utf8', timeout: 15000 },
  );

  test('allows loopback so the proxy stays reachable', async () => {
    const server = net.createServer((socket) => socket.end('ok'));
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as net.AddressInfo).port;
    try {
      const profile = buildSeatbeltProfile({ denyPaths: [], denyMachPrefixes: [] });
      const script = `const s=require('net').connect({host:'127.0.0.1',port:${port}});`
        + 's.on("connect",()=>{console.log("LOOPBACK_OK");s.destroy();process.exit(0)});'
        + 's.on("error",e=>{console.log("LOOPBACK_ERR",e.code);process.exit(1)});';
      const res = runSandboxed(profile, process.execPath, ['-e', script]);
      expect(res.stdout).toContain('LOOPBACK_OK');
    } finally {
      server.close();
    }
  });

  test('denies non-loopback egress (EPERM before any network I/O)', () => {
    const profile = buildSeatbeltProfile({ denyPaths: [], denyMachPrefixes: [] });
    // Numeric IP so there's no DNS step — isolates the network deny, and works offline.
    const script = 'const s=require("net").connect({host:"8.8.8.8",port:53});s.setTimeout(3000);'
      + 's.on("connect",()=>{console.log("CONNECTED");s.destroy();process.exit(0)});'
      + 's.on("timeout",()=>{console.log("TIMEOUT");process.exit(0)});'
      + 's.on("error",e=>{console.log("ERR",e.code);process.exit(0)});';
    const res = runSandboxed(profile, process.execPath, ['-e', script]);
    expect(res.stdout).toContain('ERR EPERM');
  });

  test('denies reads of a fenced credential dir', () => {
    const secretDir = path.join(tmpDir, 'creds');
    spawnSync('mkdir', ['-p', secretDir]);
    const secretFile = path.join(secretDir, 'key.txt');
    writeFileSync(secretFile, 'TOPSECRET');
    const profile = buildSeatbeltProfile({ denyPaths: [secretDir], denyMachPrefixes: [] });
    const res = runSandboxed(profile, '/bin/cat', [secretFile]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Operation not permitted|not permitted/i);
  });

  test('neutralizes the out-of-tree escape (env-scrub + double-fork + reparent)', () => {
    const profile = buildSeatbeltProfile({ denyPaths: [], denyMachPrefixes: [] });
    const resultFile = path.join(tmpDir, 'escape-result.txt');
    // Mirrors the demonstrated same-uid escape: drop varlock markers, double-fork +
    // setsid to reparent out of any process subtree, THEN try to egress. Inside the
    // jail this must still be denied — the sandbox removed the capability, so
    // process-identity evasion buys nothing.
    const script = `
      const cp = require('child_process');
      const fs = require('fs');
      for (const k of Object.keys(process.env)) if (/VARLOCK|PROXY/.test(k)) delete process.env[k];
      const child = cp.spawn(process.execPath, ['-e', \`
        const net = require('net');
        const s = net.connect({ host: '8.8.8.8', port: 53 });
        s.setTimeout(3000);
        s.on('connect', () => { require('fs').writeFileSync(${JSON.stringify(resultFile)}, 'CONNECTED'); process.exit(0); });
        s.on('timeout', () => { require('fs').writeFileSync(${JSON.stringify(resultFile)}, 'TIMEOUT'); process.exit(0); });
        s.on('error', (e) => { require('fs').writeFileSync(${JSON.stringify(resultFile)}, 'ERR ' + e.code); process.exit(0); });
      \`], { detached: true, stdio: 'ignore' });
      child.unref();
    `;
    runSandboxed(profile, process.execPath, ['-e', script]);
    // Wait for the detached grandchild to write its result.
    const deadline = Date.now() + 8000;
    let contents = '';
    while (Date.now() < deadline) {
      try {
        contents = readFileSync(resultFile, 'utf8');
        if (contents) break;
      } catch { /* not written yet */ }
      spawnSync('sleep', ['0.2']);
    }
    expect(contents).toBe('ERR EPERM');
  });
});
