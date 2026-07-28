import { describe, test, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VARLOCK_CLI } from '../helpers/run-varlock.js';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');
const BASIC_CWD = join(SMOKE_TESTS_DIR, 'smoke-test-basic');

/** Child holds long enough for us to sample parent RSS after spawn/shebang resolve. */
const HOLD_SCRIPT = "process.stdout.write('ready\\n'); setTimeout(() => {}, 8000)";

/**
 * Memory thresholds for the `varlock run` shebang-probe regression.
 *
 * Healthy parent RSS (tiny schema, no plugins): ~67 MiB macOS / ~81 MiB Linux slim.
 * The bug (readShebang loading the whole Node binary) was ~318 MiB parent / ~230 MiB
 * bare-vs-absolute delta. Tune these if CI baselines move; keep well above healthy
 * and well below the known bug.
 */
const MAX_BARE_VS_ABSOLUTE_DELTA_MIB = 40;
const MAX_BARE_NODE_PARENT_RSS_MIB = 150;

const MAX_BARE_VS_ABSOLUTE_DELTA_KIB = MAX_BARE_VS_ABSOLUTE_DELTA_MIB * 1024;
const MAX_BARE_NODE_PARENT_RSS_KIB = MAX_BARE_NODE_PARENT_RSS_MIB * 1024;

function rssKiB(pid: number): number | null {
  if (process.platform === 'linux') {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)/m);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const n = Number(result.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Run `varlock run -- <nodeBin> -e <HOLD_SCRIPT>`, wait for `ready`, sample the
 * varlock parent RSS a few times, then SIGTERM and return the peak sample.
 */
function measureRunParentRssKiB(nodeBin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const samples: Array<number> = [];
    let output = '';
    const handles: {
      sampling?: ReturnType<typeof setInterval>;
      timeout?: ReturnType<typeof setTimeout>;
    } = {};

    const child = spawn(
      process.execPath,
      [VARLOCK_CLI, 'run', '--', nodeBin, '-e', HOLD_SCRIPT],
      {
        cwd: BASIC_CWD,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VARLOCK_TELEMETRY_DISABLED: '1' },
      },
    );

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (handles.sampling) clearInterval(handles.sampling);
      if (handles.timeout) clearTimeout(handles.timeout);
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      if (err) {
        reject(err);
        return;
      }
      if (!samples.length) {
        reject(new Error(`no RSS samples (output=${JSON.stringify(output)})`));
        return;
      }
      resolve(Math.max(...samples));
    };

    handles.timeout = setTimeout(() => {
      finish(new Error(`timed out waiting for ready (output=${JSON.stringify(output)})`));
    }, 15_000);
    handles.timeout.unref();

    const startSampling = () => {
      if (handles.sampling) return;
      handles.sampling = setInterval(() => {
        if (!child.pid) return;
        const rss = rssKiB(child.pid);
        if (rss != null) samples.push(rss);
      }, 200);
      // give a few samples after ready, then stop
      setTimeout(() => finish(), 1500).unref();
    };

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('ready')) startSampling();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => finish(err));
  });
}

function miB(kib: number) {
  return Math.round((kib / 1024) * 10) / 10;
}

// RSS sampling needs POSIX `ps` or Linux /proc
describe.skipIf(process.platform === 'win32')('varlock run memory footprint', () => {
  test('bare PATH `node` does not inflate parent RSS vs absolute node path', async () => {
    // Regression for readShebang reading the entire Node binary when resolving a
    // bare PATH command. Absolute paths skip the probe; bare `node` used to load
    // ~100MB+ into the parent and OOM 256Mi containers.
    const which = spawnSync('which', ['node'], { encoding: 'utf8' });
    expect(which.status, 'node must be on PATH for this regression').toBe(0);

    const absoluteRss = await measureRunParentRssKiB(process.execPath);
    const bareRss = await measureRunParentRssKiB('node');

    const deltaKiB = bareRss - absoluteRss;
    expect(
      deltaKiB,
      `bare node parent RSS (${miB(bareRss)} MiB) exceeded absolute `
        + `(${miB(absoluteRss)} MiB) by ${miB(deltaKiB)} MiB `
        + `(limit ${MAX_BARE_VS_ABSOLUTE_DELTA_MIB} MiB)`,
    ).toBeLessThan(MAX_BARE_VS_ABSOLUTE_DELTA_KIB);

    expect(
      bareRss,
      `bare node parent RSS ${miB(bareRss)} MiB exceeds `
        + `${MAX_BARE_NODE_PARENT_RSS_MIB} MiB sanity ceiling`,
    ).toBeLessThan(MAX_BARE_NODE_PARENT_RSS_KIB);
  }, 30_000);
});
