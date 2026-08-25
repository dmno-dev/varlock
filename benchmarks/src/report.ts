import type { BenchRunResult, ScenarioResult } from './types.ts';

function fmtMs(n: number): string {
  return `${n.toFixed(1)}ms`;
}

function fmtRss(bytes: number | null): string {
  if (bytes === null) return '-';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function fmtDelta(deltaMs: number, basisMs: number): string {
  const sign = deltaMs >= 0 ? '+' : '';
  const pct = basisMs > 0 ? ` (${sign}${((deltaMs / basisMs) * 100).toFixed(1)}%)` : '';
  return `${sign}${deltaMs.toFixed(1)}ms${pct}`;
}

type Comparison = {
  label: string;
  baseId: string;
  againstId: string;
};

/**
 * The interesting numbers are all differences: what varlock adds over a plain
 * build, what telemetry adds, what redaction adds. Computing them here means the
 * committed results are readable without doing arithmetic by hand.
 *
 * Ids are matched by suffix so one entry covers every install method.
 */
const COMPARISONS: Array<Comparison> = [
  { label: 'varlock run wrap overhead', baseId: 'cli.run.bare-node', againstId: 'cli.run.wrap.telemetry.off' },
  { label: 'telemetry cost (cli run)', baseId: 'cli.run.wrap.telemetry.off', againstId: 'cli.run.wrap.telemetry.on' },
  { label: 'telemetry cost (cli load, cold)', baseId: 'cli.load.cold.telemetry.off', againstId: 'cli.load.cold.telemetry.on' },
  { label: 'cache benefit (cold - warm)', baseId: 'cli.load.warm.telemetry.off', againstId: 'cli.load.cold.telemetry.off' },
  { label: 'stdout redaction cost', baseId: 'cli.run.redact-stdout.off', againstId: 'cli.run.redact-stdout.on' },
  { label: 'next build: varlock overhead', baseId: 'integration.next.build.baseline', againstId: 'integration.next.build.varlock.telemetry.off' },
  { label: 'next build: telemetry cost', baseId: 'integration.next.build.varlock.telemetry.off', againstId: 'integration.next.build.varlock.telemetry.on' },
  { label: 'next request: preventLeaks cost', baseId: 'integration.next.request.preventLeaks.off', againstId: 'integration.next.request.preventLeaks.on' },
  { label: 'next request: redactLogs cost', baseId: 'integration.next.request.redactLogs.off', againstId: 'integration.next.request.redactLogs.on' },
  { label: 'vite build: varlock overhead', baseId: 'integration.vite.build.baseline', againstId: 'integration.vite.build.varlock.telemetry.off' },
  { label: 'vite build: telemetry cost', baseId: 'integration.vite.build.varlock.telemetry.off', againstId: 'integration.vite.build.varlock.telemetry.on' },
  { label: 'vite request: preventLeaks cost', baseId: 'integration.vite.request.preventLeaks.off', againstId: 'integration.vite.request.preventLeaks.on' },
  { label: 'vite request: redactLogs cost', baseId: 'integration.vite.request.redactLogs.off', againstId: 'integration.vite.request.redactLogs.on' },
];

/** Match `cli.load.cold.telemetry.off` against `cli.load.cold.telemetry.off.install.npm`. */
function findByBaseId(scenarios: Array<ScenarioResult>, baseId: string): Array<ScenarioResult> {
  return scenarios.filter((s) => s.id === baseId || s.id.startsWith(`${baseId}.install.`));
}

function installOf(s: ScenarioResult): string {
  return s.id.includes('.install.') ? s.installMethod : 'n/a';
}

function comparisonRows(scenarios: Array<ScenarioResult>): Array<string> {
  const rows: Array<string> = [];
  for (const cmp of COMPARISONS) {
    const bases = findByBaseId(scenarios, cmp.baseId);
    const againsts = findByBaseId(scenarios, cmp.againstId);
    if (bases.length === 0 || againsts.length === 0) continue;

    for (const against of againsts) {
      // Prefer the same install method, fall back to the single shared baseline
      const base = bases.find((b) => b.installMethod === against.installMethod)
        ?? (bases.length === 1 ? bases[0] : undefined);
      if (!base) continue;
      const deltaMedian = against.metrics.wallMsMedian - base.metrics.wallMsMedian;
      const deltaMin = against.metrics.wallMsMin - base.metrics.wallMsMin;
      // Noise guard: a delta smaller than the spread of either side is not a signal.
      const noise = Math.max(base.metrics.wallMsStdDev, against.metrics.wallMsStdDev);
      const verdict = Math.abs(deltaMedian) < noise ? ' _(within noise)_' : '';
      rows.push(
        `| ${cmp.label} | ${installOf(against)} | ${fmtDelta(deltaMedian, base.metrics.wallMsMedian)} | ${fmtDelta(deltaMin, base.metrics.wallMsMin)}${verdict} |`,
      );
    }
  }
  return rows;
}

export function formatSummaryMarkdown(result: BenchRunResult): string {
  const lines: Array<string> = [];
  lines.push('## Varlock benchmarks');
  lines.push('');
  lines.push(`- **varlock:** ${result.meta.versions.varlock}`);
  lines.push(`- **trigger:** ${result.meta.trigger}`);
  lines.push(`- **runner:** ${result.meta.runnerOs}/${result.meta.runnerArch} (node ${result.meta.nodeVersion})`);
  lines.push(`- **timestamp:** ${result.meta.timestamp}`);
  if (result.meta.gitSha) lines.push(`- **git:** ${result.meta.gitSha.slice(0, 12)}`);
  lines.push(`- **telemetry:** ${result.meta.telemetryMocked ? 'mocked locally' : 'not measured'}`);
  lines.push('');

  if (result.meta.notes.length > 0) {
    lines.push('### Notes');
    lines.push('');
    for (const note of result.meta.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  const deltas = comparisonRows(result.scenarios);
  if (deltas.length > 0) {
    lines.push('### Deltas');
    lines.push('');
    lines.push('| Comparison | Install | Δ median | Δ min |');
    lines.push('|------------|---------|----------|-------|');
    lines.push(...deltas);
    lines.push('');
  }

  lines.push('### Raw');
  lines.push('');
  lines.push('| Scenario | Install | Telemetry | Min | Median | p95 | StdDev | Peak RSS |');
  lines.push('|----------|---------|-----------|-----|--------|-----|--------|----------|');

  const sorted = [...result.scenarios].sort((a, b) => a.id.localeCompare(b.id));
  for (const s of sorted) {
    const m = s.metrics;
    lines.push(
      `| ${s.id} | ${s.installMethod} | ${s.telemetry} | ${fmtMs(m.wallMsMin)} | ${fmtMs(m.wallMsMedian)} | ${fmtMs(m.wallMsP95)} | ${fmtMs(m.wallMsStdDev)} | ${fmtRss(m.rssPeakBytesMedian)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function printScenarioLine(s: ScenarioResult): void {
  const rss = s.metrics.rssPeakBytesMedian !== null
    ? ` rss=${fmtRss(s.metrics.rssPeakBytesMedian)}`
    : '';
  console.log(
    `  ${s.id} [${s.installMethod} telemetry=${s.telemetry}] min=${fmtMs(s.metrics.wallMsMin)} median=${fmtMs(s.metrics.wallMsMedian)} sd=${fmtMs(s.metrics.wallMsStdDev)}${rss}`,
  );
}
