/**
 * Measure the built size of a package's `dist/` and render a report.
 *
 * Used by CI to surface how a change moves the published bundle:
 *  - a job-summary table on every run,
 *  - a per-PR comment with the delta vs the base branch,
 *  - a comment on the release PR with the delta vs the last published release.
 *
 * It measures an already-built `dist/` (the caller is responsible for building,
 * ideally in release mode so sourcemaps match what ships). It never builds or
 * installs anything itself, so it is safe to run in any context.
 *
 * Usage:
 *   bun run scripts/report-bundle-size.ts [options]
 *
 * Options:
 *   --dist <dir>        dist directory to measure (default: packages/varlock/dist)
 *   --json              print the metrics as JSON instead of a markdown table
 *   --out <file>        also write the metrics JSON to this file
 *   --baseline <file>   a metrics JSON from `--out`/`--json`; render a comparison
 *   --current-label <s> column label for the measured build (default: "This build")
 *   --baseline-label <s> column label for the baseline (default: "Baseline")
 *   --title <s>         heading for the markdown report
 */
import {
  readdir, readFile, writeFile, stat,
} from 'node:fs/promises';
import { join } from 'node:path';

type Metrics = {
  totalBytes: number;
  jsBytes: number;
  mapsBytes: number;
  dtsBytes: number;
  fileCount: number;
};

const METRIC_ROWS: Array<{ key: keyof Metrics; label: string }> = [
  { key: 'totalBytes', label: 'Total dist' },
  { key: 'jsBytes', label: 'JS' },
  { key: 'mapsBytes', label: 'Sourcemaps' },
  { key: 'dtsBytes', label: 'Type defs' },
];

function parseArgs(argv: Array<string>): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function measure(distDir: string): Promise<Metrics> {
  const m: Metrics = {
    totalBytes: 0, jsBytes: 0, mapsBytes: 0, dtsBytes: 0, fileCount: 0,
  };
  for await (const file of walkFiles(distDir)) {
    const { size } = await stat(file);
    m.totalBytes += size;
    m.fileCount++;
    if (file.endsWith('.map')) m.mapsBytes += size;
    else if (file.endsWith('.d.ts') || file.endsWith('.d.cts')) m.dtsBytes += size;
    else if (file.endsWith('.js') || file.endsWith('.cjs') || file.endsWith('.mjs')) m.jsBytes += size;
  }
  return m;
}

function signChar(n: number): string {
  if (n > 0) return '+';
  if (n < 0) return '−';
  return '';
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function signedKb(bytes: number): string {
  return `${signChar(bytes)}${(Math.abs(bytes) / 1024).toFixed(1)} KB`;
}

function pct(current: number, baseline: number): string {
  if (baseline === 0) return current === 0 ? '0%' : 'n/a';
  const delta = ((current - baseline) / baseline) * 100;
  return `${signChar(delta)}${Math.abs(delta).toFixed(1)}%`;
}

function renderSingle(m: Metrics, title: string): string {
  const lines = [
    `### ${title}`,
    '',
    '| Metric | Size |',
    '| --- | ---: |',
    ...METRIC_ROWS.map((r) => `| ${r.label} | ${kb(m[r.key])} |`),
    '',
    `_${m.fileCount} files. Native binaries measured separately._`,
  ];
  return lines.join('\n');
}

function renderComparison(
  current: Metrics,
  baseline: Metrics,
  opts: { title: string; currentLabel: string; baselineLabel: string },
): string {
  const totalDelta = current.totalBytes - baseline.totalBytes;
  const totalPct = pct(current.totalBytes, baseline.totalBytes);
  let verdict: string;
  if (totalDelta > 0) {
    verdict = `⚠️ grows the bundle by ${kb(totalDelta)} (${totalPct})`;
  } else if (totalDelta < 0) {
    verdict = `✅ shrinks the bundle by ${kb(-totalDelta)} (${totalPct})`;
  } else {
    verdict = 'no change to bundle size';
  }
  const lines = [
    `### ${opts.title}`,
    '',
    verdict,
    '',
    `| Metric | ${opts.baselineLabel} | ${opts.currentLabel} | Δ |`,
    '| --- | ---: | ---: | ---: |',
    ...METRIC_ROWS.map((r) => {
      const b = baseline[r.key];
      const c = current[r.key];
      const d = c - b;
      const deltaCell = d === 0 ? '—' : `${signedKb(d)} (${pct(c, b)})`;
      return `| ${r.label} | ${kb(b)} | ${kb(c)} | ${deltaCell} |`;
    }),
    '',
    '_dist/ only; native binaries are versioned separately and not counted here._',
  ];
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const distDir = (args.dist as string) || 'packages/varlock/dist';
  const current = await measure(distDir);

  if (args.out) await writeFile(args.out as string, JSON.stringify(current, null, 2));

  if (args.json) {
    process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
    return;
  }

  let markdown: string;
  if (args.baseline) {
    let baseline: Metrics | undefined;
    try {
      baseline = JSON.parse(await readFile(args.baseline as string, 'utf8'));
    } catch {
      baseline = undefined;
    }
    markdown = baseline
      ? renderComparison(current, baseline, {
        title: (args.title as string) || 'Bundle size',
        currentLabel: (args['current-label'] as string) || 'This build',
        baselineLabel: (args['baseline-label'] as string) || 'Baseline',
      })
      // Baseline missing/unreadable (e.g. it did not build): fall back to absolute.
      : renderSingle(current, (args.title as string) || 'Bundle size');
  } else {
    markdown = renderSingle(current, (args.title as string) || 'Bundle size');
  }

  process.stdout.write(`${markdown}\n`);
}

await main();
