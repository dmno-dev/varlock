import type { BenchRunResult, ScenarioResult } from './types.ts';

function fmtMs(n: number): string {
  return `${n.toFixed(1)}ms`;
}

function fmtRss(bytes: number | null): string {
  if (bytes === null) return '-';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatSummaryMarkdown(result: BenchRunResult): string {
  const lines: Array<string> = [];
  lines.push('## Varlock benchmarks');
  lines.push('');
  lines.push(`- **varlock:** ${result.meta.versions.varlock}`);
  lines.push(`- **trigger:** ${result.meta.trigger}`);
  lines.push(`- **runner:** ${result.meta.runnerOs}/${result.meta.runnerArch}`);
  lines.push(`- **timestamp:** ${result.meta.timestamp}`);
  if (result.meta.gitSha) lines.push(`- **git:** ${result.meta.gitSha.slice(0, 12)}`);
  lines.push('');
  lines.push('| Scenario | Install | Telemetry | Median | p95 | Peak RSS |');
  lines.push('|----------|---------|-----------|--------|-----|----------|');

  const sorted = [...result.scenarios].sort((a, b) => a.id.localeCompare(b.id));
  for (const s of sorted) {
    lines.push(
      `| ${s.id} | ${s.installMethod} | ${s.telemetry} | ${fmtMs(s.metrics.wallMsMedian)} | ${fmtMs(s.metrics.wallMsP95)} | ${fmtRss(s.metrics.rssPeakBytesMedian)} |`,
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
    `  ${s.id} [${s.installMethod} telemetry=${s.telemetry}] median=${fmtMs(s.metrics.wallMsMedian)} p95=${fmtMs(s.metrics.wallMsP95)}${rss}`,
  );
}
