import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FrameworkTestEnv } from '../../../framework-tests/harness/fixture-env.ts';
import type { BenchContext, ScenarioResult, TelemetryMode } from '../types.ts';
import { measureCommand, repeatMeasure } from '../measure.ts';
import { telemetryEnv } from '../telemetry.ts';
import { measurePathLatency, withServer } from '../server.ts';
import { NEXT_MANY_SECRETS_SCHEMA, withSchemaFlags } from '../many-secrets-schema.ts';
import { LEAK_SCAN_BODY_BYTES, REDACT_LOG_LINES } from './util.ts';

const NEXT_TEST_DIR = resolve(import.meta.dirname, '../../../framework-tests/frameworks/nextjs');

/**
 * Baseline and varlock arms must compile the same app with the same next config,
 * or the "varlock overhead" number also contains a page-content and config diff.
 * Both configs below are identical apart from the plugin wrapper, and both pages
 * render identical markup — one reads process.env, the other reads ENV.
 */
const NEXT_CONFIG_BODY = `/** @type {import('next').NextConfig} */
const nextConfig = {
  productionBrowserSourceMaps: true,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
`;

const BASELINE_NEXT_CONFIG = `${NEXT_CONFIG_BODY}
export default nextConfig;
`;

const VARLOCK_NEXT_CONFIG = `import { varlockNextConfigPlugin } from '@varlock/nextjs-integration/plugin';

${NEXT_CONFIG_BODY}
export default varlockNextConfigPlugin()(nextConfig);
`;

function pageSource(read: (key: string) => string): string {
  return `export default function Page() {
  const hasSensitive = !!${read('SENSITIVE_VAR')};

  console.log('secret-log-test:', ${read('SENSITIVE_VAR')});

  return (
    <main>
      <h1>bench</h1>
      <p>Next prefixed var: {${read('NEXT_PUBLIC_VAR')}}</p>
      <p>Unprefixed var: {${read('PUBLIC_VAR')}}</p>
      <p>Env specific var: {${read('ENV_SPECIFIC_VAR')}}</p>
      <p>Has sensitive: {hasSensitive ? 'yes' : 'no'}</p>
    </main>
  );
}
`;
}

const BASELINE_PAGE = pageSource((key) => `process.env.${key}`);
const VARLOCK_PAGE = `import { ENV } from 'varlock/env';

${pageSource((key) => `ENV.${key}`)}`;

// force-dynamic keeps these handlers running per request. Next 15 already treats
// GET handlers as dynamic by default, but the bench should not silently start
// measuring a prerendered response if that default ever changes.
const ECHO_ROUTE = `import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  // Large body without the sensitive value so preventLeaks scanning still runs
  // but the request succeeds (no leak throw).
  const body = \`ok padding=\${'x'.repeat(${LEAK_SCAN_BODY_BYTES})}\`;
  return new NextResponse(body, {
    headers: { 'content-type': 'text/plain' },
  });
}
`;

const LOG_ROUTE = `import { NextResponse } from 'next/server';
import { ENV } from 'varlock/env';

export const dynamic = 'force-dynamic';

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
  for (let i = 0; i < ${REDACT_LOG_LINES}; i++) {
    const key = SECRET_KEYS[i % SECRET_KEYS.length];
    console.log(\`bench-log-\${i}:\`, ENV[key]);
  }
  return new NextResponse('ok', {
    headers: { 'content-type': 'text/plain' },
  });
}
`;

function createNextEnv(ctx: BenchContext, mode: 'baseline' | 'varlock'): FrameworkTestEnv {
  const withVarlock = mode === 'varlock';
  const integrationVersion = ctx.integrationVersions.nextjs ?? 'latest';
  return new FrameworkTestEnv({
    testDir: NEXT_TEST_DIR,
    framework: `bench-next-${mode}`,
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
          '@varlock/nextjs-integration': integrationVersion,
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

function prepareBuildFiles(env: FrameworkTestEnv, mode: 'baseline' | 'varlock'): void {
  env.prepareFiles({
    templateFiles: { '.env.dev': 'schemas/.env.dev' },
    files: [
      { path: '.env.schema', content: NEXT_MANY_SECRETS_SCHEMA },
      {
        path: 'next.config.mjs',
        content: mode === 'baseline' ? BASELINE_NEXT_CONFIG : VARLOCK_NEXT_CONFIG,
      },
      { path: 'app/page.tsx', content: mode === 'baseline' ? BASELINE_PAGE : VARLOCK_PAGE },
    ],
  });
}

async function measureBuild(
  fixture: FrameworkTestEnv,
  iterations: number,
  telemetry: TelemetryMode,
  mockEnv: Record<string, string>,
) {
  return repeatMeasure(
    async () => {
      rmSync(join(fixture.dir, '.next'), { recursive: true, force: true });
      return measureCommand(['npx', 'next', 'build'], {
        cwd: fixture.dir,
        timeoutMs: 300_000,
        env: { ...telemetryEnv(telemetry, mockEnv), APP_ENV: 'dev', CI: '1' },
      });
    },
    { iterations, warmup: 0 },
  );
}

export async function runNextScenarios(ctx: BenchContext): Promise<Array<ScenarioResult>> {
  const results: Array<ScenarioResult> = [];
  const buildIterations = Math.max(2, Math.min(3, ctx.iterations));
  const requestIterations = Math.max(10, ctx.iterations * 2);

  console.log('  preparing next baseline (framework-tests)...');
  const baseline = createNextEnv(ctx, 'baseline');
  await baseline.setup();
  try {
    prepareBuildFiles(baseline, 'baseline');
    results.push({
      id: 'integration.next.build.baseline',
      facet: 'integration-next',
      installMethod: 'npm',
      packageManager: 'npm',
      telemetry: 'off',
      metrics: await measureBuild(baseline, buildIterations, 'off', ctx.telemetryMockEnv),
      notes: 'Cold next build, no varlock installed',
    });
  } finally {
    await baseline.teardown();
  }

  // One varlock fixture serves every varlock arm. Installing a fresh project per
  // telemetry mode and per latency config meant 7 npm installs where 2 will do,
  // which dominated the wall-clock of this group.
  console.log('  preparing next varlock (framework-tests)...');
  const fixture = createNextEnv(ctx, 'varlock');
  await fixture.setup();
  try {
    prepareBuildFiles(fixture, 'varlock');
    for (const telemetry of ctx.telemetryModes) {
      console.log(`  next varlock build, telemetry=${telemetry}...`);
      results.push({
        id: `integration.next.build.varlock.telemetry.${telemetry}`,
        facet: 'integration-next',
        installMethod: 'npm',
        packageManager: 'npm',
        telemetry,
        metrics: await measureBuild(fixture, buildIterations, telemetry, ctx.telemetryMockEnv),
        notes: 'Cold next build; telemetry affects sync varlock load spawn',
      });
    }

    console.log('  measuring next request latency (preventLeaks / redactLogs)...');
    for (const [label, preventLeaks, redactLogs, port, path] of [
      ['preventLeaks.on', true, true, 3451, '/api/echo'],
      ['preventLeaks.off', false, true, 3452, '/api/echo'],
      ['redactLogs.on', true, true, 3453, '/api/log'],
      ['redactLogs.off', true, false, 3454, '/api/log'],
    ] as const) {
      fixture.prepareFiles({
        templateFiles: { '.env.dev': 'schemas/.env.dev' },
        files: [
          { path: '.env.schema', content: withSchemaFlags(NEXT_MANY_SECRETS_SCHEMA, preventLeaks, redactLogs) },
          { path: 'next.config.mjs', content: VARLOCK_NEXT_CONFIG },
          { path: 'app/page.tsx', content: VARLOCK_PAGE },
          { path: 'app/api/echo/route.js', content: ECHO_ROUTE },
          { path: 'app/api/log/route.js', content: LOG_ROUTE },
        ],
      });

      rmSync(join(fixture.dir, '.next'), { recursive: true, force: true });
      const buildResult = await measureCommand(['npx', 'next', 'build'], {
        cwd: fixture.dir,
        timeoutMs: 300_000,
        env: { ...telemetryEnv('off'), APP_ENV: 'dev', CI: '1' },
      });
      if (buildResult.exitCode !== 0) {
        throw new Error(`next build failed for ${label}:\n${buildResult.stderr}\n${buildResult.stdout}`);
      }

      const latency = await withServer(
        ['npx', 'next', 'start', '-H', '127.0.0.1', '-p', String(port)],
        {
          cwd: fixture.dir,
          env: {
            ...telemetryEnv('off'),
            APP_ENV: 'dev',
            PORT: String(port),
            HOSTNAME: '127.0.0.1',
          },
          readyUrl: `http://127.0.0.1:${port}${path}`,
        },
        () => measurePathLatency(`http://127.0.0.1:${port}`, path, requestIterations, 3),
      );

      results.push({
        id: `integration.next.request.${label}`,
        facet: 'integration-next',
        installMethod: 'npm',
        packageManager: 'npm',
        telemetry: 'off',
        metrics: latency,
        notes: path === '/api/echo'
          ? `${(LEAK_SCAN_BODY_BYTES / 1024 / 1024).toFixed(0)}MiB safe body; preventLeaks scan cost`
          : `${REDACT_LOG_LINES} console.log lines with secret; redactLogs cost`,
      });
    }
  } finally {
    await fixture.teardown();
  }

  return results;
}
