#!/usr/bin/env bun

/**
 * Measures the cost of stdout/stderr redaction. Manual tool, not run in CI.
 *
 *   bunx turbo run build                          # the end-to-end part uses the built package
 *   bun run bench:redaction                       # full run
 *   bun run bench:redaction --quick               # fewer runs and smaller workloads
 *   bun run bench:redaction --runtimes node --runs 7
 *   bun run bench:redaction --secret-every 100    # worst case: a secret in 1% of lines
 *
 * Two parts:
 *
 * 1. Micro: CPU cost per write of the patched `write()` against a no-op stream, in this
 *    process (bun), from source. Isolates redaction + holdback from syscall cost.
 *
 * 2. End to end: spawns a real app (`import 'varlock/auto-load'`) that writes a workload to a
 *    pipe the parent drains, under each redaction mode and runtime. Startup is measured with an
 *    empty workload and subtracted, so the numbers are the cost of writing the output only.
 *
 * The schema mimics a real app: 10 secrets in common provider formats (Stripe, OpenAI,
 * Anthropic, AWS, GitHub, SendGrid, a Postgres URL, a JWT secret, a PEM private key) plus a few
 * public items. Values are random and generated at run time, so nothing secret-shaped is
 * committed.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { resetRedactionMap, redactSensitiveConfig, getRedactionHoldbackLength } from '../src/runtime/env';
import { patchStreamWrite } from '../src/runtime/patch-process-streams';
import type { SerializedEnvGraph } from '../src/env-graph';

const PKG_DIR = path.resolve(import.meta.dir, '..');
const CLI_PATH = path.join(PKG_DIR, 'bin', 'cli.js');

const { values: args } = parseArgs({
  options: {
    quick: { type: 'boolean', default: false },
    runs: { type: 'string' },
    runtimes: { type: 'string', default: 'node,bun' },
    'skip-micro': { type: 'boolean', default: false },
    'skip-e2e': { type: 'boolean', default: false },
    // put a secret in 1 of every N lines (worst case); by default only one line per run has
    // one, since real apps almost never log secrets and redaction is a safety net
    'secret-every': { type: 'string', default: '0' },
  },
});
const RUNS = Number(args.runs ?? (args.quick ? 3 : 5));
const SCALE = args.quick ? 0.25 : 1;
const SECRET_EVERY = Number(args['secret-every']);

// --- realistic secrets -------------------------------------------------------------------------

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// Math.random is fine here: these are throwaway benchmark values, not secrets
function rand(length: number, alphabet = BASE62) {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
const hex = (bytes: number) => crypto.randomBytes(bytes).toString('hex');

function fakePem() {
  const body = crypto.randomBytes(1218).toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

const SECRETS: Record<string, string> = {
  STRIPE_SECRET_KEY: `sk_live_${rand(99)}`,
  OPENAI_API_KEY: `sk-proj-${rand(156, `${BASE62}-_`)}`,
  ANTHROPIC_API_KEY: `sk-ant-api03-${rand(93, `${BASE62}-_`)}AA`,
  AWS_SECRET_ACCESS_KEY: rand(40, `${BASE62}+/`),
  GITHUB_TOKEN: `ghp_${rand(36)}`,
  SENDGRID_API_KEY: `SG.${rand(22, `${BASE62}-_`)}.${rand(43, `${BASE62}-_`)}`,
  DATABASE_URL: `postgres://app_user:${rand(24)}@db-primary.internal.example.com:5432/app_production`,
  JWT_SECRET: hex(32),
  SESSION_SECRET: rand(48),
  GOOGLE_PRIVATE_KEY: fakePem(),
};
const PUBLIC_ITEMS: Record<string, string> = {
  NODE_ENV: 'production',
  PORT: '3000',
  LOG_LEVEL: 'info',
  PUBLIC_API_URL: 'https://api.example.com',
};

function schemaContents() {
  const lines = [
    '# @defaultSensitive=false',
    // `none` mode turns all redaction off via this item
    '# @redactLogs=$REDACT_LOGS',
    '# ---',
    'REDACT_LOGS=true # @type=boolean',
  ];
  for (const [key, value] of Object.entries(PUBLIC_ITEMS)) lines.push(`${key}=${value}`);
  for (const [key, value] of Object.entries(SECRETS)) {
    lines.push('# @sensitive');
    lines.push(`${key}=${JSON.stringify(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

// --- workloads (shared by both parts) ----------------------------------------------------------

const JSON_LINES = Math.round(200_000 * SCALE);
const CONSOLE_LINES = Math.round(100_000 * SCALE);
const BULK_CHUNKS = Math.round(512 * SCALE); // 64KB each

// a pino-style request log line, optionally carrying a secret (an echoed auth header)
function jsonLogLine(i: number, secret?: string) {
  return `${JSON.stringify({
    level: 30,
    time: 1759500000000 + i,
    pid: 4242,
    hostname: 'api-7f9c6d-x2k4p',
    reqId: `req-${i.toString(36)}`,
    req: { method: 'GET', url: `/api/v1/orders/${i}?include=items`, remoteAddress: '10.0.3.17' },
    res: { statusCode: 200 },
    responseTime: 12.4,
    msg: 'request completed',
    ...secret && { authorization: `Bearer ${secret}` },
  })}\n`;
}

// --- part 1: micro -----------------------------------------------------------------------------

function timeIt(iterations: number, fn: (i: number) => void) {
  for (let i = 0; i < Math.min(iterations, 2000); i++) fn(i); // warmup
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  return ((performance.now() - start) * 1000) / iterations; // µs per iteration
}

function runMicro() {
  resetRedactionMap({
    config: {
      ...Object.fromEntries(Object.entries(PUBLIC_ITEMS).map(([k, value]) => [k, { isSensitive: false, value }])),
      ...Object.fromEntries(Object.entries(SECRETS).map(([k, value]) => [k, { isSensitive: true, value }])),
    },
  } as unknown as SerializedEnvGraph);

  const plainLine = jsonLogLine(1);
  const secretLine = jsonLogLine(0, SECRETS.STRIPE_SECRET_KEY);
  const bulkChunk = Buffer.from(plainLine.repeat(Math.ceil(65536 / plainLine.length)).slice(0, 65536));

  const noop = { write: (_chunk: unknown) => true };
  const patched = { write: (_chunk: unknown) => true };
  patchStreamWrite(patched);

  const n = Math.round(300_000 * SCALE);
  const rows: Array<[string, number, number]> = [
    ['json line (~330B)', timeIt(n, () => noop.write(plainLine)), timeIt(n, () => patched.write(plainLine))],
    ['json line with a secret (rare)', timeIt(n, () => noop.write(secretLine)), timeIt(n, () => patched.write(secretLine))],
    ['64KB buffer chunk', timeIt(2000, () => noop.write(bulkChunk)), timeIt(2000, () => patched.write(bulkChunk))],
  ];

  console.log(`\n## Micro: patched write() CPU cost (bun ${Bun.version}, in-process, no-op stream)\n`);
  console.log(`${Object.keys(SECRETS).length} secrets, longest ${Math.max(...Object.values(SECRETS).map((s) => s.length))} chars\n`);
  console.log('| write | unpatched | patched | added |');
  console.log('| --- | ---: | ---: | ---: |');
  for (const [label, base, withPatch] of rows) {
    console.log(`| ${label} | ${base.toFixed(2)}µs | ${withPatch.toFixed(2)}µs | +${(withPatch - base).toFixed(2)}µs |`);
  }
  console.log('\nBreakdown for one plain json line:');
  console.log(`- regex redaction: ${timeIt(n, () => redactSensitiveConfig(plainLine)).toFixed(2)}µs`);
  console.log(`- holdback check: ${timeIt(n, () => getRedactionHoldbackLength(plainLine)).toFixed(2)}µs`);
}

// --- part 2: end to end ------------------------------------------------------------------------

const APP_SOURCE = `import 'varlock/auto-load';

const workload = process.env.BENCH_WORKLOAD;
const secret = process.env.STRIPE_SECRET_KEY;
// the last line always carries a secret, so the parent can check redaction actually happened
const withSecret = (i, last) => i === last || (${SECRET_EVERY} > 0 && i % ${SECRET_EVERY} === 0);
${jsonLogLine.toString()}

if (workload === 'json-lines') {
  for (let i = 0; i < ${JSON_LINES}; i++) {
    process.stdout.write(jsonLogLine(i, withSecret(i, ${JSON_LINES - 1}) ? secret : undefined));
  }
} else if (workload === 'console-log') {
  for (let i = 0; i < ${CONSOLE_LINES}; i++) {
    const token = withSecret(i, ${CONSOLE_LINES - 1}) ? ' token=' + secret : '';
    console.log(\`[info] order \${i} processed in \${(i % 97) + 3}ms user=usr_\${i.toString(36)}\${token}\`);
  }
} else if (workload === 'bulk-chunks') {
  // e.g. child.stdout.pipe(process.stdout): 64KB buffers of text
  const line = jsonLogLine(1);
  const chunk = Buffer.from(line.repeat(Math.ceil(65536 / line.length)).slice(0, 65536));
  for (let i = 0; i < ${BULK_CHUNKS}; i++) process.stdout.write(chunk);
  process.stdout.write(jsonLogLine(0, secret));
}
`;

type Mode = 'none' | 'console-only' | 'in-process' | 'varlock-run';
const MODES: Array<{ mode: Mode, label: string }> = [
  { mode: 'none', label: 'no redaction' },
  { mode: 'console-only', label: 'console only (current default)' },
  { mode: 'in-process', label: 'in-process stdout (new)' },
  { mode: 'varlock-run', label: 'varlock run parent' },
];
const WORKLOADS = [
  { name: 'json-lines', label: `${JSON_LINES.toLocaleString()} JSON log lines via stdout.write`, units: JSON_LINES },
  { name: 'console-log', label: `${CONSOLE_LINES.toLocaleString()} console.log lines`, units: CONSOLE_LINES },
  { name: 'bulk-chunks', label: `${(BULK_CHUNKS * 64) / 1024}MB in 64KB buffers`, units: BULK_CHUNKS },
] as const;

function runOnce(dir: string, runtime: string, mode: Mode, workload: string) {
  const env: Record<string, string | undefined> = {
    ...process.env, BENCH_WORKLOAD: workload, REDACT_LOGS: mode === 'none' ? 'false' : 'true',
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('__VARLOCK') || key === '_VARLOCK_REDACT_STDOUT') delete env[key];
  }
  if (mode === 'in-process') env._VARLOCK_REDACT_STDOUT = '1';

  const [cmd, cmdArgs] = mode === 'varlock-run'
    ? [process.env.NODE_BIN ?? 'node', [CLI_PATH, 'run', '--', runtime, 'app.mjs']]
    : [runtime, ['app.mjs']];

  return new Promise<{ ms: number, output: Buffer }>((resolve, reject) => {
    const start = performance.now();
    const child = spawn(cmd, cmdArgs, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Array<Buffer> = [];
    child.stdout.on('data', (c) => chunks.push(c));
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const ms = performance.now() - start;
      if (code !== 0) reject(new Error(`${runtime} ${mode} ${workload} exited ${code}\n${stderr}`));
      else resolve({ ms, output: Buffer.concat(chunks) });
    });
  });
}

const median = (xs: Array<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function runE2E() {
  if (!fs.existsSync(path.join(PKG_DIR, 'dist'))) {
    throw new Error('packages/varlock/dist is missing - run `bunx turbo run build` from packages/varlock first');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-redaction-bench-'));
  try {
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.symlinkSync(PKG_DIR, path.join(dir, 'node_modules', 'varlock'), 'dir');
    fs.writeFileSync(path.join(dir, '.env.schema'), schemaContents());
    fs.writeFileSync(path.join(dir, 'app.mjs'), APP_SOURCE);

    for (const runtime of args.runtimes!.split(',')) {
      const runnable = await runOnce(dir, runtime, 'none', 'noop').then(() => true, () => false);
      if (!runnable) {
        console.log(`\n(skipping ${runtime}: not runnable)`);
        continue;
      }
      console.log(`\n## End to end: ${runtime}, output piped to the parent (median of ${RUNS}, startup subtracted)\n`);

      const results: Record<string, Record<Mode, number>> = {};
      for (const { mode } of MODES) {
        const startupTimes = [];
        for (let r = 0; r < RUNS; r++) startupTimes.push((await runOnce(dir, runtime, mode, 'noop')).ms);
        const startup = median(startupTimes);
        for (const workload of WORKLOADS) {
          const times = [];
          for (let r = 0; r < RUNS; r++) {
            const { ms, output } = await runOnce(dir, runtime, mode, workload.name);
            times.push(ms);
            // sanity check that each mode actually does what it claims
            const leaked = output.includes(SECRETS.STRIPE_SECRET_KEY);
            const expectLeak = mode === 'none' || (mode === 'console-only' && workload.name !== 'console-log');
            if (r === 0 && leaked !== expectLeak) {
              console.log(`  ! ${mode}/${workload.name}: expected secret ${expectLeak ? 'present' : 'redacted'}`);
            }
          }
          results[workload.name] ||= {} as Record<Mode, number>;
          results[workload.name][mode] = Math.max(0, median(times) - startup);
        }
      }

      console.log(`| workload | ${MODES.map((m) => m.label).join(' | ')} |`);
      console.log(`| --- | ${MODES.map(() => '---:').join(' | ')} |`);
      for (const workload of WORKLOADS) {
        const row = results[workload.name];
        const cells = MODES.map(({ mode }) => {
          const ms = row[mode];
          if (mode === 'none') return `${ms.toFixed(0)}ms`;
          const addedUs = ((ms - row.none) * 1000) / workload.units;
          const unit = workload.name === 'bulk-chunks' ? 'chunk' : 'line';
          return `${ms.toFixed(0)}ms (${addedUs >= 0 ? '+' : ''}${addedUs.toFixed(2)}µs/${unit})`;
        });
        console.log(`| ${workload.label} | ${cells.join(' | ')} |`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (!args['skip-micro']) runMicro();
if (!args['skip-e2e']) await runE2E();
console.log('\nNotes: timings are noisy below a few ms per cell. "varlock run parent" redacts in the CLI process,');
console.log('so its cost shows up as throughput/latency of the pipe rather than CPU in the app.');
