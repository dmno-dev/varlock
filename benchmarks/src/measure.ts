import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  cpSync, mkdirSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import type { Sample, ScenarioMetrics } from './types.ts';

/** RSS (KiB) of a single pid, or null if it is gone / unreadable. */
function rssKiBForPid(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Direct children of a pid, via /proc/<pid>/task/<tid>/children. */
function childPidsLinux(pid: number): Array<number> {
  const out: Array<number> = [];
  let tids: Array<string>;
  try {
    tids = readdirSync(`/proc/${pid}/task`);
  } catch {
    return out;
  }
  for (const tid of tids) {
    try {
      const raw = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim();
      if (!raw) continue;
      for (const part of raw.split(/\s+/)) {
        const n = Number(part);
        if (Number.isInteger(n)) out.push(n);
      }
    } catch {
      // thread exited between readdir and read
    }
  }
  return out;
}

/**
 * Summed RSS (KiB) of a process and all of its descendants.
 *
 * The tree matters: `varlock run -- node app.js` and `npx next build` both do the
 * real work in a grandchild, so sampling only the direct child would report the
 * footprint of a wrapper process.
 *
 * On Linux this walks /proc with no subprocess spawns. Elsewhere it shells out to
 * `ps` once per sample, which perturbs the very timings we are measuring — so
 * non-Linux runs sample at a coarser interval and are best treated as indicative.
 */
export function rssTreeKiB(rootPid: number): number | null {
  if (process.platform === 'linux') {
    let total = 0;
    let found = false;
    const seen = new Set<number>();
    const queue = [rootPid];
    while (queue.length) {
      const pid = queue.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const rss = rssKiBForPid(pid);
      if (rss !== null) {
        total += rss;
        found = true;
      }
      queue.push(...childPidsLinux(pid));
    }
    return found ? total : null;
  }

  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const rssByPid = new Map<number, number>();
  const childrenByPid = new Map<number, Array<number>>();
  for (const line of result.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, ppid, rss] = parts.map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(rss)) continue;
    rssByPid.set(pid, rss!);
    const siblings = childrenByPid.get(ppid!) ?? [];
    siblings.push(pid!);
    childrenByPid.set(ppid!, siblings);
  }
  if (!rssByPid.has(rootPid)) return null;
  let total = 0;
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rssByPid.get(pid) ?? 0;
    queue.push(...(childrenByPid.get(pid) ?? []));
  }
  return total;
}

function percentile(sorted: Array<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function median(values: Array<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function stdDev(values: Array<number>): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function summarizeSamples(samples: Array<Sample>): ScenarioMetrics {
  if (samples.length === 0) {
    throw new Error('summarizeSamples: no samples — refusing to report zeroed metrics');
  }
  const walls = samples.map((s) => s.wallMs).sort((a, b) => a - b);
  const rssValues = samples
    .map((s) => s.rssPeakBytes)
    .filter((v): v is number => v !== null);

  return {
    iterations: samples.length,
    wallMsMin: walls[0]!,
    wallMsMedian: median(walls),
    // With few iterations p95 collapses onto the max — it is kept for continuity
    // but wallMsMin / wallMsStdDev are the numbers to reason about.
    wallMsP95: percentile(walls, 95),
    wallMsStdDev: stdDev(walls),
    rssPeakBytesMedian: rssValues.length > 0 ? median(rssValues) : null,
    rssSampleCount: rssValues.length,
    samples,
  };
}

export type MeasureCommandOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  /** Sample RSS of the spawned process tree while it runs. Default true. */
  sampleRss?: boolean;
  sampleIntervalMs?: number;
  timeoutMs?: number;
};

/** `ps` costs a spawn per sample, so back off when we cannot read /proc. */
const DEFAULT_RSS_INTERVAL_MS = process.platform === 'linux' ? 10 : 50;

/**
 * Spawn a command, measure wall time and peak RSS of the whole process tree.
 */
export function measureCommand(
  command: Array<string>,
  options: MeasureCommandOptions = {},
): Promise<Sample & { stdout: string; stderr: string }> {
  const [bin, ...args] = command;
  if (!bin) {
    return Promise.reject(new Error('measureCommand: empty command'));
  }

  const sampleRss = options.sampleRss !== false;
  const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_RSS_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? 120_000;

  return new Promise((resolve, reject) => {
    const start = performance.now();
    let peakRssKiB: number | null = null;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let sampling: ReturnType<typeof setInterval> | undefined;
    const timers: { timeout?: ReturnType<typeof setTimeout> } = {};

    const finish = (err: Error) => {
      if (settled) return;
      settled = true;
      if (sampling) clearInterval(sampling);
      if (timers.timeout) clearTimeout(timers.timeout);
      reject(err);
    };

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        if (value === undefined) {
          delete childEnv[key];
        } else {
          childEnv[key] = value;
        }
      }
    }

    const child: ChildProcess = spawn(bin, args, {
      cwd: options.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (sampleRss) {
      const takeSample = () => {
        if (!child.pid) return;
        const rss = rssTreeKiB(child.pid);
        if (rss !== null) {
          peakRssKiB = peakRssKiB === null ? rss : Math.max(peakRssKiB, rss);
        }
      };
      // Sample immediately — short-lived commands can finish inside one interval,
      // which previously reported no RSS at all.
      takeSample();
      sampling = setInterval(takeSample, sampleIntervalMs);
    }

    timers.timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Command timed out after ${timeoutMs}ms: ${command.join(' ')}`));
    }, timeoutMs);

    if (options.input) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      finish(err);
    });

    child.on('close', (code) => {
      const wallMs = performance.now() - start;
      if (sampling) clearInterval(sampling);
      if (timers.timeout) clearTimeout(timers.timeout);
      if (settled) return;
      settled = true;
      resolve({
        wallMs,
        rssPeakBytes: peakRssKiB !== null ? peakRssKiB * 1024 : null,
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

export type RepeatOptions = {
  iterations: number;
  warmup: number;
  /** Throw if any measured iteration exits non-zero. Default true. */
  expectSuccess?: boolean;
  /**
   * Truncate captured output in failure messages. Scenarios that deliberately
   * print secret values to stdout (redaction benches) set this low so fixture
   * secrets do not end up in CI logs.
   */
  maxFailureOutputChars?: number;
};

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [${value.length - max} more chars truncated]`;
}

/**
 * Run warmup + measured iterations of an async sample factory.
 */
export async function repeatMeasure(
  factory: () => Promise<Sample>,
  options: RepeatOptions,
): Promise<ScenarioMetrics> {
  const expectSuccess = options.expectSuccess !== false;
  const maxOutput = options.maxFailureOutputChars ?? 4_000;

  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error(`repeatMeasure: iterations must be a positive integer, got ${options.iterations}`);
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0) {
    throw new Error(`repeatMeasure: warmup must be a non-negative integer, got ${options.warmup}`);
  }

  for (let i = 0; i < options.warmup; i++) {
    const warm = await factory();
    if (expectSuccess && warm.exitCode !== 0) {
      throw new Error(`Warmup failed with exit ${warm.exitCode}`);
    }
  }

  const samples: Array<Sample> = [];
  for (let i = 0; i < options.iterations; i++) {
    const sample = await factory();
    if (expectSuccess && sample.exitCode !== 0) {
      const withOutput = sample as { stdout?: string; stderr?: string };
      const extra = withOutput.stdout !== undefined || withOutput.stderr !== undefined
        ? `\nstdout:\n${truncate(withOutput.stdout ?? '', maxOutput)}\nstderr:\n${truncate(withOutput.stderr ?? '', maxOutput)}`
        : '';
      throw new Error(`Iteration ${i} failed with exit ${sample.exitCode}${extra}`);
    }
    samples.push({
      wallMs: sample.wallMs,
      rssPeakBytes: sample.rssPeakBytes,
      exitCode: sample.exitCode,
    });
  }

  return summarizeSamples(samples);
}

/**
 * Copy a fixture directory into a work subdirectory, so scenarios never mutate
 * the checked-in fixtures (codegen output, caches, build artifacts).
 */
export function copyFixture(sourceDir: string, destDir: string): string {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  cpSync(sourceDir, destDir, { recursive: true });
  return destDir;
}
