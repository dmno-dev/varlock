import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Sample, ScenarioMetrics } from './types.ts';

export function rssKiB(pid: number): number | null {
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

export function summarizeSamples(samples: Array<Sample>): ScenarioMetrics {
  const walls = samples.map((s) => s.wallMs).sort((a, b) => a - b);
  const rssValues = samples
    .map((s) => s.rssPeakBytes)
    .filter((v): v is number => v !== null);

  return {
    wallMsMedian: median(walls),
    wallMsP95: percentile(walls, 95),
    rssPeakBytesMedian: rssValues.length > 0 ? median(rssValues) : null,
    samples,
  };
}

export type MeasureCommandOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  /** Sample RSS of the spawned process while it runs. Default true. */
  sampleRss?: boolean;
  sampleIntervalMs?: number;
  timeoutMs?: number;
};

/**
 * Spawn a command, measure wall time and optional peak RSS of the child.
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
  const sampleIntervalMs = options.sampleIntervalMs ?? 25;
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
      sampling = setInterval(() => {
        if (child.pid) {
          const rss = rssKiB(child.pid);
          if (rss !== null) {
            peakRssKiB = peakRssKiB === null ? rss : Math.max(peakRssKiB, rss);
          }
        }
      }, sampleIntervalMs);
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
};

/**
 * Run warmup + measured iterations of an async sample factory.
 */
export async function repeatMeasure(
  factory: () => Promise<Sample>,
  options: RepeatOptions,
): Promise<ScenarioMetrics> {
  const expectSuccess = options.expectSuccess !== false;

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
      const extra = 'stderr' in sample || 'stdout' in sample
        ? `\nstdout:\n${(sample as { stdout?: string }).stdout ?? ''}\nstderr:\n${(sample as { stderr?: string }).stderr ?? ''}`
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

/** Copy a fixture directory into a unique work subdirectory. */
export async function copyFixture(
  sourceDir: string,
  destDir: string,
): Promise<void> {
  const { cpSync, mkdirSync, rmSync } = await import('node:fs');
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  cpSync(sourceDir, destDir, { recursive: true });
}
