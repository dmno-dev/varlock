/**
 * Checks that the daemon's approval panel actually ARMS its user-presence check.
 *
 * The panel drawing is not the thing that can silently break. What broke, and what
 * nobody could see, is the evaluation behind it never starting: the panel appeared
 * with its Touch ID glyph, the sensor did nothing, and no system prompt came up
 * either, because the bound view suppresses the standard alert while the
 * evaluation is not running. There was no scan surface anywhere, and every visible
 * part looked correct.
 *
 * The cause was scheduling. The IPC handler is on a background queue, so the panel
 * is drawn from inside a `DispatchQueue.main.sync` work item, and the arming was
 * posted with `DispatchQueue.main.async`. The main queue is serial, so that block
 * could not run until the enclosing item returned, which it never does while the
 * modal loop is up. The probe never hit this because it owns its run loop.
 *
 * So this asserts the one thing that proves the wiring is live, and that a person
 * cannot check by looking: `evaluatePolicy` is invoked within a couple of seconds
 * of the panel opening. Completing the scan still needs a finger. Arming does not.
 *
 * It also asserts the ORDER, which is the second bug this feature had: macOS puts
 * its own sheet up the moment a policy is evaluated, so a check armed before the
 * panel was readable meant the system sheet covered a panel nobody had read, and
 * one finger approved something unseen. Two rules encode the fix: a scan is only
 * ever armed while our panel is on screen, and the first-use setup scan happens
 * on its own, before the panel exists.
 *
 * Needs a Mac with a Secure Enclave, enrolled biometrics, and a desktop session:
 * it creates a REAL gated key, so macOS will put a Touch ID prompt on screen for a
 * moment. Nobody has to answer it; the daemon is killed as soon as the assertion
 * is made. Run it after building:
 *
 *   swift build --package-path packages/encryption-binary-swift/swift
 *   bun run packages/encryption-binary-swift/scripts/e2e-panel-arming.ts
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createKeyPair } from '../../varlock/src/lib/local-encrypt/crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const binary = path.resolve(here, '../swift/.build/debug/VarlockEnclave');

if (!fs.existsSync(binary)) {
  throw new Error(`binary not built at ${binary}; run: swift build --package-path packages/encryption-binary-swift/swift`);
}

/** How long the panel gets to arm before we call it broken. */
const ARMING_DEADLINE_MS = 5_000;

const KEY_ID = 'varlock-e2e-panel-arming';
const IDENTITY_ID = 'default';

/**
 * Says whether a run is about first use or about the normal case.
 *
 * A scratch config home is a fresh machine, so without this every run here would
 * be testing first use. The daemon reads the same variable a person would reach
 * for if the detection ever misjudged their machine.
 */
function setupEnv(firstUse: boolean): Record<string, string> {
  return { _VARLOCK_BIOMETRIC_SETUP: firstUse ? '1' : '0' };
}

const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-arming-'));
const env = { ...process.env, XDG_CONFIG_HOME: configHome };

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

function runBinary(args: Array<string>): any {
  return JSON.parse(execFileSync(binary, args, { env, encoding: 'utf-8' }));
}

function send(socket: net.Socket, action: string, payload?: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify({ id: Math.random().toString(36).slice(2), action, payload }), 'utf-8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length, 0);
  socket.write(Buffer.concat([prefix, body]));
}

// -- a real gated key, which is the whole point: an ungated one never prompts --

console.log(`config home: ${configHome}`);

// Skip the one-time "setting up biometrics" panel. It is real and wanted, but it
// blocks `generate-key` on a human (or its own 20s auto-dismiss), and this script
// is about what happens after. The first-run sequence has its own manual check in
// the README.
fs.mkdirSync(path.join(configHome, 'varlock', 'secure-enclave'), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(configHome, 'varlock', 'secure-enclave', '.setup-shown'), '');

const generated = runBinary(['generate-key', '--key-id', KEY_ID]);
check('gated custody key created', generated.ok === true, generated);

const identityKeyPair = await createKeyPair();
const wrapped = runBinary([
  'encrypt',
  '--key-id',
  KEY_ID,
  '--data',
  Buffer.from(identityKeyPair.privateKey, 'utf-8').toString('base64'),
]);
fs.mkdirSync(path.join(configHome, 'varlock', 'identities'), { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(configHome, 'varlock', 'identities', `${IDENTITY_ID}.json`),
  `${JSON.stringify({
    version: 1,
    id: IDENTITY_ID,
    publicKey: identityKeyPair.publicKey,
    wraps: { [KEY_ID]: wrapped.ciphertext },
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`,
  { mode: 0o600 },
);

/**
 * A scan may only ever be armed while our panel is up.
 *
 * Walks the debug log in order and checks that every `evaluatePolicy-invoked`
 * has a live panel behind it: a `panel-shown` since the last `present-returned`.
 * The setup scan is deliberately not one of these; it has its own note, and its
 * own assertion that it happens before any panel.
 */
function assertNoScanWithoutAPanel(stderr: string) {
  const events = [...stderr.matchAll(/varlock-panel \[\d+ms\] (\S+)/g)].map((m) => m[1]);
  let panelIsUp = false;
  let orphanScans = 0;
  for (const event of events) {
    if (event === 'panel-shown') panelIsUp = true;
    else if (event === 'present-returned') panelIsUp = false;
    else if (event === 'evaluatePolicy-invoked' && !panelIsUp) orphanScans++;
  }
  check('no biometric sheet was raised without the panel on screen', orphanScans === 0, { events });
}

async function armingRun(
  label: string,
  slug: string,
  extraEnv: Record<string, string>,
  expectArming: boolean,
  opts: { skipSetupMarker?: boolean; lockFirst?: boolean } = {},
) {
  console.log(`\n${label}`);
  // Short, because a unix socket path has a hard length limit and the scratch
  // directory already eats most of it.
  const socket = path.join(configHome, `${slug}.sock`);
  let stderr = '';
  const daemon = spawn(
    binary,
    ['daemon', '--socket-path', socket, '--pid-path', `${socket}.pid`],
    {
      env: {
        ...env,
        _VARLOCK_PANEL_DEBUG: '1',
        ...setupEnv(opts.skipSetupMarker ?? false),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  daemon.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let out = '';
      daemon.stdout.on('data', (d) => {
        out += d.toString();
        if (out.includes('"ready"')) resolve();
      });
      daemon.on('exit', (code) => reject(new Error(`daemon exited early with code ${code}: ${out}`)));
      setTimeout(() => reject(new Error('daemon did not become ready')), 10_000);
    });

    const client = net.createConnection(socket);
    await new Promise((resolve) => {
      client.once('connect', resolve);
    });

    if (opts.lockFirst) {
      // Open and immediately drop a session, the way the menu bar's Lock does,
      // before anything asks again.
      send(client, 'invalidate-session', {});
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
    }

    // Deliberately not awaited: with a gated key this call blocks on a human, and
    // the human is the part we are doing without.
    send(client, 'unlock-session', { keyIds: [KEY_ID], scope: 'session' });

    const deadline = Date.now() + ARMING_DEADLINE_MS;
    while (Date.now() < deadline && !stderr.includes('evaluatePolicy-invoked')) {
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }

    assertNoScanWithoutAPanel(stderr);
    if (opts.skipSetupMarker) {
      // First use is about the setup scan happening alone. The panel comes after
      // it, and nobody is here to complete it, so there is nothing else to say.
      client.destroy();
      return stderr;
    }

    check('the panel was shown', stderr.includes('panel-shown'), stderr.slice(-400));
    check(
      'the panel was drawn before any biometric sheet was asked for',
      !stderr.includes('evaluatePolicy-invoked')
        || stderr.indexOf('panel-shown') < stderr.indexOf('evaluatePolicy-invoked'),
      stderr.slice(-600),
    );

    // The panel now reads the peer's ancestry before it draws. That inspection
    // touches other processes, so it is exactly the kind of work that could
    // quietly grow into a delay nobody notices until an unlock feels slow. It
    // has to happen, it has to finish, and it has to be over before the panel
    // appears rather than racing it.
    const chainNote = stderr.match(/requester-chain .*hops=(\d+).*ms=(\d+)/)
      ?? stderr.match(/requester-chain .*ms=(\d+).*hops=(\d+)/);
    check('the process chain behind the caller was read', Boolean(chainNote), stderr.slice(-400));
    if (chainNote) {
      const [hops, ms] = stderr.includes('hops=') && stderr.indexOf('hops=') < stderr.indexOf('ms=')
        ? [Number(chainNote[1]), Number(chainNote[2])]
        : [Number(chainNote[2]), Number(chainNote[1])];
      check('the chain names at least the caller', hops >= 1, { hops });
      check('reading it did not hold up the panel', ms < 1_000, { ms });
      check(
        'it was read before the panel was drawn, not while it was up',
        stderr.indexOf('requester-chain') < stderr.indexOf('panel-shown'),
        stderr.slice(-400),
      );
    }

    // Assert on the ORDER of the flow's effects rather than on what has or has
    // not happened by a deadline. Someone sitting at this machine can press the
    // panel's button while the script runs, and a timing-based check would call
    // that a failure; the order is the thing that actually encodes the design.
    const firstEffect = stderr.match(/flow-effect .*effect=(\w+)/)?.[1];
    if (expectArming) {
      check('the check is armed as the panel opens', firstEffect === 'beginScan', { firstEffect });
      check(
        `evaluatePolicy was invoked within ${ARMING_DEADLINE_MS}ms of the panel opening`,
        stderr.includes('evaluatePolicy-invoked'),
        stderr.slice(-600),
      );
    } else {
      check('the panel waits rather than arming on open', firstEffect === 'showControls', { firstEffect });
      // If a button did get pressed (a human at the keyboard, or a later round),
      // arming still has to have gone through the flow rather than happening on
      // its own.
      if (stderr.includes('evaluatePolicy-invoked')) {
        check(
          'the fallback arms only after the button, and does arm then',
          /effect=showControls[\s\S]*effect=beginScan[\s\S]*evaluatePolicy-invoked/.test(stderr),
          stderr.slice(-600),
        );
      }
    }
    client.destroy();
  } finally {
    daemon.kill('SIGKILL');
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
  }
  return stderr;
}

try {
  // First use on this machine: setting Touch ID up is its own scan, with the
  // panel not yet drawn, so one finger cannot do both jobs.
  const firstUse = await armingRun('first use (setup step)', 'setup', {}, false, { skipSetupMarker: true });
  check('the setup scan was raised', firstUse.includes('setup-presence-begin'), firstUse.slice(-400));
  // Asserted as an ORDER, not an absence: somebody sitting at this machine can
  // answer the setup prompt while the script runs, and the panel then appears
  // exactly as designed. What must never happen is the panel being up while the
  // setup prompt is, or a scan being armed before setup finished.
  const setupDone = firstUse.indexOf('setup-presence-completed');
  const firstPanel = firstUse.indexOf('panel-shown');
  const firstScan = firstUse.indexOf('evaluatePolicy-invoked');
  check(
    'nothing was drawn behind the setup prompt',
    firstPanel === -1 || (setupDone !== -1 && setupDone < firstPanel),
    { setupDone, firstPanel },
  );
  check(
    'and no approval scan was armed until setup was finished',
    firstScan === -1 || (setupDone !== -1 && setupDone < firstScan),
    { setupDone, firstScan },
  );

  // The shipped default: the check is armed once the panel has been readable
  // for a beat, so the scan is the approval and the approval is legible.
  const armed = await armingRun('embedded prompt (default)', 'embedded', {}, true);
  check(
    'setup is not repeated once it has been recorded',
    !armed.includes('setup-presence-begin'),
    armed.slice(-400),
  );
  check(
    'the panel was readable before the scan was armed',
    /panel-readable[\s\S]*arming-after-delay[\s\S]*evaluatePolicy-invoked/.test(armed),
    armed.slice(-800),
  );
  check(
    'the presence attempt is bound to the context that gets evaluated',
    /presence-attempt .*contextInstance=(\w+)/.test(armed)
      && (() => {
        const bound = armed.match(/presence-attempt .*contextInstance=(\w+)/)?.[1];
        const evaluated = armed.match(/evaluatePolicy-invoked .*contextInstance=(\w+)/)?.[1];
        return Boolean(bound) && bound === evaluated;
      })(),
    armed.slice(-600),
  );

  // The escape hatch, which people are told to reach for when the inline prompt
  // misbehaves. It must wait for the button rather than arming on open, and it
  // must still arm when that button is pressed.
  await armingRun('system dialog fallback', 'fallback', { _VARLOCK_EMBEDDED_PROMPT: '0' }, false);

  // Locking must not make the machine ask for a fingerprint on its own: a
  // re-request from a client that is still connected goes through the panel like
  // any other, and nothing raises a sheet in between.
  const afterLock = await armingRun('re-request after a lock', 'relock', {}, true, { lockFirst: true });
  assertNoScanWithoutAPanel(afterLock);
  check(
    'locking raised no prompt of its own',
    (afterLock.match(/evaluatePolicy-invoked/g) ?? []).length
      <= (afterLock.match(/panel-shown/g) ?? []).length,
    afterLock.slice(-600),
  );
} finally {
  try {
    runBinary(['delete-key', '--key-id', KEY_ID]);
  } catch { /* best effort */ }
  fs.rmSync(configHome, { recursive: true, force: true });
}

console.log(failures === 0 ? '\npanel arming checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
