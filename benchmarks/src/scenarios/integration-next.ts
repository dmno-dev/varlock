import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { FrameworkTestEnv } from '../../../framework-tests/harness/fixture-env.ts';
import type { BenchContext, ScenarioResult } from '../types.ts';
import { measureCommand, repeatMeasure } from '../measure.ts';
import { TELEMETRY_MODES, telemetryEnv } from '../telemetry.ts';
import { NEXT_MANY_SECRETS_SCHEMA, withSchemaFlags } from '../many-secrets-schema.ts';

const NEXT_TEST_DIR = resolve(import.meta.dirname, '../../../framework-tests/frameworks/nextjs');

const BASELINE_NEXT_CONFIG = `/** @type {import('next').NextConfig} */
const nextConfig = {
  productionBrowserSourceMaps: true,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
`;

const BASELINE_PAGE = `export default function Page() {
  return (
    <main>
      <h1>bench baseline</h1>
      <p>{process.env.NEXT_PUBLIC_VAR || process.env.PUBLIC_VAR || 'none'}</p>
    </main>
  );
}
`;

const ECHO_ROUTE = `import { NextResponse } from 'next/server';

export async function GET() {
  // Large body without the sensitive value so preventLeaks scanning still runs
  // but the request succeeds (no leak throw).
  const body = \`ok padding=\${'x'.repeat(16_384)}\`;
  return new NextResponse(body, {
    headers: { 'content-type': 'text/plain' },
  });
}
`;

const LOG_ROUTE = `import { NextResponse } from 'next/server';
import { ENV } from 'varlock/env';

const SECRET_KEYS = [
  'SENSITIVE_VAR',
  'SECRET_TOKEN',
  'SECRET_API_KEY',
  'SECRET_DB_PASSWORD',
  'SECRET_JWT',
  'SECRET_STRIPE',
  'SECRET_AWS_ACCESS',
  'SECRET_AWS_SECRET',
  'SECRET_REDIS',
  'SECRET_SMTP',
  'SECRET_OAUTH',
  'SECRET_WEBHOOK',
  'SECRET_ENCRYPTION',
  'SECRET_SESSION',
  'SECRET_GITHUB',
  'SECRET_SLACK',
  'SECRET_OPENAI',
  'SECRET_SENTRY',
];

export async function GET() {
  for (let i = 0; i < 200; i++) {
    const key = SECRET_KEYS[i % SECRET_KEYS.length];
    console.log(\`bench-log-\${i}:\`, ENV[key]);
  }
  return new NextResponse('ok', {
    headers: { 'content-type': 'text/plain' },
  });
}
`;

function createNextEnv(
  ctx: BenchContext,
  mode: 'baseline' | 'varlock',
  labelSuffix = '',
): FrameworkTestEnv {
  const withVarlock = mode === 'varlock';
  return new FrameworkTestEnv({
    testDir: NEXT_TEST_DIR,
    framework: `bench-next-${mode}${labelSuffix}`,
    packageManager: 'npm',
    usePublished: true,
    installTimeout: 180_000,
    dependencies: {
      next: '^15',
      react: '^19',
      'react-dom': '^19',
      '@types/react': '^19',
      typescript: '^5.9.3',
      ...(withVarlock
        ? {
          varlock: ctx.version,
          '@varlock/nextjs-integration': 'latest',
        }
        : {}),
    },
    ...(withVarlock
      ? {
        overrides: {
          '@next/env': '<packed:@varlock/nextjs-integration>',
        },
      }
      : {}),
    templateFiles: {
      '.env.schema': 'schemas/.env.schema',
      '.env.dev': 'schemas/.env.dev',
      '.env.prod': 'schemas/.env.prod',
    },
  });
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status > 0) return;
    } catch {
      // retry
    }
    await new Promise<void>((r) => {
      setTimeout(r, 250);
    });
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function measurePathLatency(
  baseUrl: string,
  path: string,
  iterations: number,
  warmup: number,
): Promise<ScenarioResult['metrics']> {
  return repeatMeasure(
    async () => {
      const start = performance.now();
      const res = await fetch(`${baseUrl}${path}`);
      const wallMs = performance.now() - start;
      if (!res.ok) {
        throw new Error(`Request failed: ${res.status} ${await res.text()}`);
      }
      await res.text();
      return { wallMs, rssPeakBytes: null, exitCode: 0 };
    },
    { iterations, warmup },
  );
}

async function withNextServer<T>(
  projectDir: string,
  port: number,
  readyPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const server = spawn('npx', ['next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: projectDir,
    env: {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(telemetryEnv('off')).filter(([, v]) => v !== undefined),
      ),
      APP_ENV: 'dev',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  server.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString();
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}${readyPath}`, 90_000);
    return await fn();
  } catch (err) {
    throw new Error(`${String(err)}\nnext start stderr:\n${stderr}`);
  } finally {
    server.kill('SIGTERM');
    await new Promise<void>((r) => {
      setTimeout(r, 500);
    });
    if (!server.killed) server.kill('SIGKILL');
  }
}

function prepareNextFiles(env: FrameworkTestEnv, mode: 'baseline' | 'varlock'): void {
  if (mode === 'baseline') {
    env.prepareFiles({
      templateFiles: {
        '.env.dev': 'schemas/.env.dev',
      },
      files: [
        { path: '.env.schema', content: NEXT_MANY_SECRETS_SCHEMA },
        { path: 'next.config.mjs', content: BASELINE_NEXT_CONFIG },
        { path: 'app/page.tsx', content: BASELINE_PAGE },
      ],
    });
    return;
  }

  env.prepareFiles({
    templateFiles: {
      '.env.dev': 'schemas/.env.dev',
      'app/page.tsx': 'pages/basic-page.tsx',
    },
    files: [{ path: '.env.schema', content: NEXT_MANY_SECRETS_SCHEMA }],
  });
}

export async function runNextScenarios(ctx: BenchContext): Promise<Array<ScenarioResult>> {
  const results: Array<ScenarioResult> = [];
  const buildIterations = Math.max(2, Math.min(3, ctx.iterations));

  console.log('  preparing next baseline (framework-tests)...');
  {
    const fixture = createNextEnv(ctx, 'baseline');
    await fixture.setup();
    prepareNextFiles(fixture, 'baseline');
    const build = await repeatMeasure(
      async () => {
        rmSync(join(fixture.dir, '.next'), { recursive: true, force: true });
        return measureCommand(['npx', 'next', 'build'], {
          cwd: fixture.dir,
          timeoutMs: 300_000,
          env: { ...telemetryEnv('off'), APP_ENV: 'dev', CI: '1' },
        });
      },
      { iterations: buildIterations, warmup: 0 },
    );
    results.push({
      id: 'integration.next.build.baseline',
      facet: 'integration-next',
      installMethod: 'npm',
      packageManager: 'npm',
      telemetry: 'off',
      metrics: build,
    });
    await fixture.teardown();
  }

  // Varlock build: telemetry on/off (next shells out to varlock load via @next/env override)
  for (const telemetry of TELEMETRY_MODES) {
    console.log(`  preparing next varlock telemetry.${telemetry} (framework-tests)...`);
    const fixture = createNextEnv(ctx, 'varlock', `-telemetry-${telemetry}`);
    await fixture.setup();
    prepareNextFiles(fixture, 'varlock');
    const build = await repeatMeasure(
      async () => {
        rmSync(join(fixture.dir, '.next'), { recursive: true, force: true });
        return measureCommand(['npx', 'next', 'build'], {
          cwd: fixture.dir,
          timeoutMs: 300_000,
          env: { ...telemetryEnv(telemetry), APP_ENV: 'dev', CI: '1' },
        });
      },
      { iterations: buildIterations, warmup: 0 },
    );
    results.push({
      id: `integration.next.build.varlock.telemetry.${telemetry}`,
      facet: 'integration-next',
      installMethod: 'npm',
      packageManager: 'npm',
      telemetry,
      metrics: build,
      notes: 'Cold next build; telemetry affects sync varlock load spawn',
    });
    await fixture.teardown();
  }

  console.log('  measuring next request latency (preventLeaks / redactLogs)...');
  const requestIterations = Math.max(10, ctx.iterations * 2);
  for (const [label, preventLeaks, redactLogs, port, path] of [
    ['preventLeaks.on', true, true, 3451, '/api/echo'],
    ['preventLeaks.off', false, true, 3452, '/api/echo'],
    ['redactLogs.on', true, true, 3453, '/api/log'],
    ['redactLogs.off', true, false, 3454, '/api/log'],
  ] as const) {
    const fixture = createNextEnv(ctx, 'varlock', `-${label}`);
    await fixture.setup();

    fixture.prepareFiles({
      templateFiles: {
        '.env.dev': 'schemas/.env.dev',
        'app/page.tsx': 'pages/basic-page.tsx',
      },
      files: [
        { path: '.env.schema', content: withSchemaFlags(NEXT_MANY_SECRETS_SCHEMA, preventLeaks, redactLogs) },
        { path: 'app/api/echo/route.js', content: ECHO_ROUTE },
        { path: 'app/api/log/route.js', content: LOG_ROUTE },
      ],
    });

    const buildResult = await measureCommand(['npx', 'next', 'build'], {
      cwd: fixture.dir,
      timeoutMs: 300_000,
      env: { ...telemetryEnv('off'), APP_ENV: 'dev', CI: '1' },
    });
    if (buildResult.exitCode !== 0) {
      await fixture.teardown();
      throw new Error(`next build failed for ${label}:\n${buildResult.stderr}\n${buildResult.stdout}`);
    }

    try {
      const latency = await withNextServer(fixture.dir, port, path, () => measurePathLatency(
        `http://127.0.0.1:${port}`,
        path,
        requestIterations,
        3,
      ));
      results.push({
        id: `integration.next.request.${label}`,
        facet: 'integration-next',
        installMethod: 'npm',
        packageManager: 'npm',
        telemetry: 'off',
        metrics: latency,
        notes: path === '/api/echo'
          ? 'Large safe body; preventLeaks scan cost'
          : '200 console.log lines with secret; redactLogs cost',
      });
    } finally {
      await fixture.teardown();
    }
  }

  return results;
}
