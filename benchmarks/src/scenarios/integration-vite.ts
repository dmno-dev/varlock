import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FrameworkTestEnv } from '../../../framework-tests/harness/fixture-env.ts';
import type { BenchContext, ScenarioResult, TelemetryMode } from '../types.ts';
import { measureCommand, repeatMeasure } from '../measure.ts';
import { telemetryEnv } from '../telemetry.ts';
import { measurePathLatency, withServer } from '../server.ts';
import { VITE_MANY_SECRETS_SCHEMA, withSchemaFlags } from '../many-secrets-schema.ts';
import { LEAK_SCAN_BODY_BYTES, REDACT_LOG_LINES } from './util.ts';

const VITE_TEST_DIR = resolve(import.meta.dirname, '../../../framework-tests/frameworks/vite');

const BUILD_ENV = {
  APP_ENV: 'dev',
  PUBLIC_VAR: 'public-test-value',
  API_URL: 'https://api.example.com',
  ENV_SPECIFIC_VAR: 'env-specific-dev',
  VITE_PUBLIC_VAR: 'public-test-value',
  VITE_API_URL: 'https://api.example.com',
  VITE_ENV_SPECIFIC_VAR: 'env-specific-dev',
};

/** Identical apart from the plugin — see the note in integration-next.ts. */
const BASELINE_VITE_CONFIG = `import { defineConfig } from 'vite';

export default defineConfig({});
`;

const VARLOCK_VITE_CONFIG = `import { defineConfig } from 'vite';
import { varlockVitePlugin } from '@varlock/vite-integration';

export default defineConfig({
  plugins: [varlockVitePlugin()],
});
`;

function mainSource(read: (key: string) => string): string {
  return `document.getElementById('app')!.innerHTML = \`
  <h1>bench</h1>
  <p class="public-var">\${${read('PUBLIC_VAR')}}</p>
  <p class="api-url">\${${read('API_URL')}}</p>
  <p class="env-specific">\${${read('ENV_SPECIFIC_VAR')}}</p>
\`;
`;
}

const BASELINE_MAIN = mainSource((key) => `import.meta.env.VITE_${key}`);
const VARLOCK_MAIN = `import { ENV } from 'varlock/env';

${mainSource((key) => `ENV.${key}`)}`;

/**
 * Dev-server middleware used for latency benches:
 * - /api/echo: large body without secrets (preventLeaks still scans)
 * - /api/log: many console.log lines containing the secret (redactLogs cost)
 */
const LATENCY_VITE_CONFIG = `import { defineConfig } from 'vite';
import { varlockVitePlugin } from '@varlock/vite-integration';
import { ENV } from 'varlock/env';

const SECRET_KEYS = [
  'SECRET_KEY',
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

export default defineConfig({
  plugins: [
    varlockVitePlugin(),
    {
      name: 'bench-latency-middleware',
      configureServer(server) {
        server.middlewares.use('/api/echo', (_req, res) => {
          res.setHeader('content-type', 'text/plain');
          res.end(\`ok padding=\${'x'.repeat(${LEAK_SCAN_BODY_BYTES})}\`);
        });
        server.middlewares.use('/api/log', (_req, res) => {
          for (let i = 0; i < ${REDACT_LOG_LINES}; i++) {
            const key = SECRET_KEYS[i % SECRET_KEYS.length];
            console.log(\`bench-log-\${i}:\`, ENV[key]);
          }
          res.setHeader('content-type', 'text/plain');
          res.end('ok');
        });
      },
    },
  ],
});
`;

function createViteEnv(ctx: BenchContext, mode: 'baseline' | 'varlock'): FrameworkTestEnv {
  const withVarlock = mode === 'varlock';
  const integrationVersion = ctx.integrationVersions.vite ?? 'latest';
  return new FrameworkTestEnv({
    testDir: VITE_TEST_DIR,
    framework: `bench-vite-${mode}`,
    packageManager: 'npm',
    usePublished: true,
    installTimeout: 180_000,
    dependencies: {
      vite: '^6',
      ...(withVarlock
        ? {
          varlock: ctx.version,
          '@varlock/vite-integration': integrationVersion,
        }
        : {}),
    },
    templateFiles: {
      '.env.schema': 'schemas/.env.schema',
      '.env.dev': 'schemas/.env.dev',
      '.env.prod': 'schemas/.env.prod',
    },
  });
}

function prepareBuildFiles(env: FrameworkTestEnv, mode: 'baseline' | 'varlock'): void {
  env.prepareFiles({
    templateFiles: {
      '.env.dev': 'schemas/.env.dev',
      'index.html': 'html/basic.html',
    },
    files: [
      { path: '.env.schema', content: VITE_MANY_SECRETS_SCHEMA },
      {
        path: 'vite.config.ts',
        content: mode === 'baseline' ? BASELINE_VITE_CONFIG : VARLOCK_VITE_CONFIG,
      },
      { path: 'src/main.ts', content: mode === 'baseline' ? BASELINE_MAIN : VARLOCK_MAIN },
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
      rmSync(join(fixture.dir, 'dist'), { recursive: true, force: true });
      return measureCommand(['npx', 'vite', 'build'], {
        cwd: fixture.dir,
        timeoutMs: 180_000,
        env: { ...telemetryEnv(telemetry, mockEnv), ...BUILD_ENV, CI: '1' },
      });
    },
    { iterations, warmup: 0 },
  );
}

export async function runViteScenarios(ctx: BenchContext): Promise<Array<ScenarioResult>> {
  const results: Array<ScenarioResult> = [];
  const buildIterations = Math.max(2, Math.min(4, ctx.iterations));
  const requestIterations = Math.max(10, ctx.iterations * 2);

  console.log('  preparing vite baseline (framework-tests)...');
  const baseline = createViteEnv(ctx, 'baseline');
  await baseline.setup();
  try {
    prepareBuildFiles(baseline, 'baseline');
    results.push({
      id: 'integration.vite.build.baseline',
      facet: 'integration-vite',
      installMethod: 'npm',
      packageManager: 'npm',
      telemetry: 'off',
      metrics: await measureBuild(baseline, buildIterations, 'off', ctx.telemetryMockEnv),
      notes: 'Cold vite build, no varlock installed',
    });
  } finally {
    await baseline.teardown();
  }

  console.log('  preparing vite varlock (framework-tests)...');
  const fixture = createViteEnv(ctx, 'varlock');
  await fixture.setup();
  try {
    prepareBuildFiles(fixture, 'varlock');
    for (const telemetry of ctx.telemetryModes) {
      console.log(`  vite varlock build, telemetry=${telemetry}...`);
      results.push({
        id: `integration.vite.build.varlock.telemetry.${telemetry}`,
        facet: 'integration-vite',
        installMethod: 'npm',
        packageManager: 'npm',
        telemetry,
        metrics: await measureBuild(fixture, buildIterations, telemetry, ctx.telemetryMockEnv),
        notes: 'Cold vite build; telemetry affects sync varlock load spawn',
      });
    }

    console.log('  measuring vite request latency (preventLeaks / redactLogs)...');
    for (const [label, preventLeaks, redactLogs, port, path] of [
      ['preventLeaks.on', true, true, 3461, '/api/echo'],
      ['preventLeaks.off', false, true, 3462, '/api/echo'],
      ['redactLogs.on', true, true, 3463, '/api/log'],
      ['redactLogs.off', true, false, 3464, '/api/log'],
    ] as const) {
      fixture.prepareFiles({
        templateFiles: {
          '.env.dev': 'schemas/.env.dev',
          'index.html': 'html/basic.html',
          'src/main.ts': 'pages/minimal-page.ts',
        },
        files: [
          { path: '.env.schema', content: withSchemaFlags(VITE_MANY_SECRETS_SCHEMA, preventLeaks, redactLogs) },
          { path: 'vite.config.ts', content: LATENCY_VITE_CONFIG },
        ],
      });

      const latency = await withServer(
        ['npx', 'vite', 'dev', '--host', '127.0.0.1', '--port', String(port)],
        {
          cwd: fixture.dir,
          env: { ...telemetryEnv('off'), APP_ENV: 'dev', CI: '1' },
          readyUrl: `http://127.0.0.1:${port}${path}`,
        },
        () => measurePathLatency(`http://127.0.0.1:${port}`, path, requestIterations, 3),
      );

      results.push({
        id: `integration.vite.request.${label}`,
        facet: 'integration-vite',
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
