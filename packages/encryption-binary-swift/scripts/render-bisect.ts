/**
 * Why does the inline Touch ID view render in the probe and not in the panel?
 *
 * Both bind an `LAAuthenticationView` to the context they evaluate, both attach
 * it to a visible key window first, and one of them draws a fingerprint while the
 * other draws nothing. Rather than guessing at the difference, this walks from
 * the working environment to the broken one, flipping a single axis at a time.
 *
 * The measurement is pixels, not opinion: `WindowPixels` photographs the region
 * the view occupies and counts distinct greys. A blank region is one flat colour;
 * a rendered fingerprint is dozens. That is what makes this runnable without a
 * person sitting here answering "did it draw" over and over.
 *
 *   swift build --package-path packages/encryption-binary-swift/swift
 *   bun run packages/encryption-binary-swift/scripts/render-bisect.ts
 *
 * Flags:
 *   --only <case>   run one case by name
 *   --keep          leave the scratch config homes behind
 */

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const binary = path.join(packageRoot, 'swift', '.build', 'debug', 'VarlockEnclave');
const KEY_ID = 'varlock-render-bisect';

if (!fs.existsSync(binary)) {
  throw new Error(`binary not built at ${binary}; run: swift build --package-path packages/encryption-binary-swift/swift`);
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-render-bisect-'));

const { createKeyPair } = await import('../../varlock/src/lib/local-encrypt/crypto');

/**
 * A scratch config home with a real presence-gated key in it, and an identity
 * wrapped to that key.
 *
 * The identity is what makes `unlock-session` reach the panel at all: without one
 * the daemon refuses before drawing anything, which looks from the outside
 * exactly like a panel that failed to render.
 */
async function freshConfigHome(caseId: string): Promise<string> {
  const configHome = path.join(scratchRoot, caseId);
  fs.mkdirSync(path.join(configHome, 'varlock', 'secure-enclave'), { recursive: true });
  fs.writeFileSync(path.join(configHome, 'varlock', 'secure-enclave', '.setup-shown'), '');
  const env = { ...process.env, XDG_CONFIG_HOME: configHome };
  execFileSync(binary, ['generate-key', '--key-id', KEY_ID], { env, stdio: 'ignore' });

  const identityKeyPair = await createKeyPair();
  const wrapped = JSON.parse(execFileSync(binary, [
    'encrypt',
    '--key-id',
    KEY_ID,
    '--data',
    Buffer.from(identityKeyPair.privateKey, 'utf-8').toString('base64'),
  ], { env, encoding: 'utf-8' }));
  fs.mkdirSync(path.join(configHome, 'varlock', 'identities'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(configHome, 'varlock', 'identities', 'default.json'),
    `${JSON.stringify({
      version: 1,
      id: 'default',
      publicKey: identityKeyPair.publicKey,
      wraps: { [KEY_ID]: wrapped.ciphertext },
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return configHome;
}

type Measurement = {
  caseId: string;
  what: string;
  greys: number;
  permitted: boolean;
  rect: string;
  agentWindows: string;
  extra: string;
};

function readSample(stderr: string): { greys: number; permitted: boolean; rect: string } {
  const line = [...stderr.matchAll(/scan-pixels ([^\n]*)/g)].pop()?.[1] ?? '';
  return {
    greys: Number(line.match(/distinctGreys=(\d+)/)?.[1] ?? -1),
    permitted: /screenCapturePermitted=true/.test(line),
    rect: line.match(/rect=([^\s]+ [^\s]+)/)?.[1] ?? '-',
  };
}

function agentWindowsFrom(stderr: string): string {
  const windows = [...stderr.matchAll(/(?:authAgentWindows|windows)=(\S*)/g)]
    .map((match) => match[1])
    .filter((value) => value && value !== '""');
  return windows.length ? windows.join(',') : 'none';
}

/** The known-good environment: the probe's own window, evaluated from its own run loop. */
async function measureProbe(caseId: string, what: string, env: Record<string, string>): Promise<Measurement> {
  const configHome = await freshConfigHome(caseId);
  const result = spawnSync(
    binary,
    ['probe-embedded-unlock', '--key-id', KEY_ID, '--verbose', '--timeout', '6'],
    {
      env: { ...process.env, ...env, XDG_CONFIG_HOME: configHome },
      encoding: 'utf-8',
    },
  );
  const stderr = result.stderr ?? '';
  const sample = readSample(stderr);
  return {
    caseId,
    what,
    ...sample,
    agentWindows: agentWindowsFrom(stderr),
    extra: stderr.match(/activation-policy-set policy=(\w+)/)?.[1] ?? '-',
  };
}

/** The real thing: the daemon's approval panel, driven over its socket. */
async function measurePanel(caseId: string, what: string, env: Record<string, string>): Promise<Measurement> {
  const configHome = await freshConfigHome(caseId);
  const socketPath = path.join(configHome, 'd.sock');
  let stderr = '';
  const daemon = spawn(binary, ['daemon', '--socket-path', socketPath, '--pid-path', `${socketPath}.pid`], {
    env: {
      ...process.env,
      ...env,
      XDG_CONFIG_HOME: configHome,
      _VARLOCK_PANEL_DEBUG: '1',
      _VARLOCK_BIOMETRIC_SETUP: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let out = '';
      daemon.stdout.on('data', (chunk) => {
        out += chunk.toString();
        if (out.includes('"ready"')) resolve();
      });
      daemon.on('exit', (code) => reject(new Error(`daemon exited early with code ${code}`)));
      setTimeout(() => reject(new Error('daemon did not become ready')), 10_000);
    });

    const socket = net.createConnection(socketPath);
    await new Promise((resolve) => {
      socket.once('connect', resolve);
    });
    const body = Buffer.from(JSON.stringify({
      id: 'bisect', action: 'unlock-session', payload: { keyIds: [KEY_ID], scope: 'session' },
    }));
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    socket.write(frame);

    // Long enough for the panel to become readable, arm, and be photographed.
    await new Promise((resolve) => {
      setTimeout(resolve, 8_000);
    });
    socket.destroy();
  } finally {
    daemon.kill('SIGKILL');
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
  }

  const sample = readSample(stderr);
  return {
    caseId,
    what,
    ...sample,
    agentWindows: agentWindowsFrom(stderr),
    extra: stderr.match(/panel-readable [^\n]*embeddedFrame=(\S+)/)?.[1] ?? '-',
  };
}

/**
 * The walk, from the environment that works toward the one that does not.
 *
 * Each case changes one thing from the case above it. Whichever line the grey
 * count collapses on is the axis that decides whether the inline view draws.
 */
const cases: Array<{ id: string; what: string; run: () => Promise<Measurement> }> = [
  {
    id: 'probe',
    what: 'probe window, regular app, own run loop',
    run: () => measureProbe('probe', 'probe window, regular app, own run loop', {}),
  },
  {
    id: 'probe-accessory',
    what: 'probe window, accessory app',
    run: () => measureProbe('probe-accessory', 'probe window, accessory app', {
      _VARLOCK_PROBE_ACTIVATION: 'accessory',
    }),
  },
  {
    id: 'probe-panel-window',
    what: "probe, but the panel's window class and level",
    run: () => measureProbe('probe-panel-window', "probe, but the panel's window class and level", {
      _VARLOCK_PROBE_WINDOW: 'panel',
    }),
  },
  {
    id: 'probe-modal',
    what: 'probe, but run inside a modal session',
    run: () => measureProbe('probe-modal', 'probe, but run inside a modal session', {
      _VARLOCK_PROBE_MODAL: '1',
    }),
  },
  {
    id: 'probe-panel-window-modal',
    what: "probe, panel's window class AND a modal session",
    run: () => measureProbe('probe-panel-window-modal', "probe, panel's window class AND a modal session", {
      _VARLOCK_PROBE_WINDOW: 'panel',
      _VARLOCK_PROBE_MODAL: '1',
    }),
  },
  {
    id: 'panel',
    what: 'the real approval panel in the daemon',
    run: () => measurePanel('panel', 'the real approval panel in the daemon', {}),
  },
];

const measurements: Array<Measurement> = [];
for (const testCase of cases) {
  if (only && only !== testCase.id) continue;
  console.log(`\n── ${testCase.id}: ${testCase.what}`);
  const measurement = await testCase.run();
  measurements.push(measurement);
  console.log(`   distinct greys ${measurement.greys}  (drawn if >= 8)  rect ${measurement.rect}`);
}

console.log('\n== render bisection =======================================================');
console.log(['case'.padEnd(26), 'greys'.padEnd(7), 'drawn'.padEnd(7), 'coreautha'.padEnd(11), 'note'].join(' '));
for (const measurement of measurements) {
  console.log([
    measurement.caseId.padEnd(26),
    String(measurement.greys).padEnd(7),
    (measurement.greys >= 8 ? 'yes' : 'no').padEnd(7),
    measurement.agentWindows.padEnd(11),
    `${measurement.what} [${measurement.extra}]`,
  ].join(' '));
}
console.log('\nThe first line where "drawn" turns to no is the axis that decides it.');
console.log('A greys of -1 means the sample never ran; 0 with permitted=false means the');
console.log('system would not let us photograph the window, which is not the same as blank.');

if (process.argv.includes('--keep')) {
  console.log(`\nscratch homes kept at ${scratchRoot}`);
} else {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
