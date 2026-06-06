import { performance } from 'node:perf_hooks';
import { parseEnvSpecDotEnvFile, parseWithMonogram } from '../src';

const ITERATIONS = Number(process.env.BENCH_ITERATIONS || 500);

function loadFixtureCorpus(): Array<string> {
  return [
    'FOO=foo\nBAR=bar\n',
    'SIMPLE=value\nQUOTED="hello world"\n',
    '# @required\nREQUIRED_VAR=test\n',
    '# header text\n# @defaultRequired\n# ---\nVAL=foo\n',
    'ITEM=concat("a", fallback("", "b"), exec("echo c"), ref(OTHERVAL))\n',
    // eslint-disable-next-line no-template-curly-in-string
    'OTHER=foo\nITEM=\\${OTHER}\n',
    // eslint-disable-next-line no-template-curly-in-string
    'ITEM=pre-\\${FOO}-$BAR-$(echo baz)-post\n',
    'ITEM=concat(\n  "a",\n  "b",\n  "c"\n)\n',
    'ITEM="""\nmultiline\nvalue\n"""\n',
    '# @import(\n#   ./.env.import,\n#   ITEM1,\n#   ITEM2,\n# )\nVAL=\n',
  ];
}

function bench(label: string, fn: () => void) {
  const start = performance.now();
  fn();
  const end = performance.now();
  const totalMs = end - start;
  const opsPerSec = (ITERATIONS / totalMs) * 1000;
  return { label, totalMs, opsPerSec };
}

function format(result: { label: string; totalMs: number; opsPerSec: number }) {
  return `${result.label.padEnd(30)} ${result.totalMs.toFixed(1).padStart(8)} ms   ${result.opsPerSec.toFixed(1).padStart(10)} ops/s`;
}

const fixtures = loadFixtureCorpus();
const fixtureCount = fixtures.length;

function runMonogram() {
  for (let i = 0; i < ITERATIONS; i += 1) {
    parseEnvSpecDotEnvFile(fixtures[i % fixtureCount]);
  }
}

function runMonogramFailureCheck() {
  let failures = 0;
  for (let i = 0; i < ITERATIONS; i += 1) {
    try {
      parseWithMonogram(fixtures[i % fixtureCount]);
    } catch {
      failures += 1;
    }
  }
  return { failures };
}

// Warmup
runMonogram();

const monogramResult = bench('Monogram parser', runMonogram);
const failureCheckResult = bench('Monogram failure check', () => {
  runMonogramFailureCheck();
});
const failureStats = runMonogramFailureCheck();

process.stdout.write(`Fixtures: ${fixtureCount}, Iterations: ${ITERATIONS}\n`);
process.stdout.write(`${format(monogramResult)}\n`);
process.stdout.write(`${format(failureCheckResult)}\n`);
process.stdout.write(`Monogram failures: ${failureStats.failures}/${ITERATIONS}\n`);
