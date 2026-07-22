import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { FrameworkTestEnv } from '../../../framework-tests/harness/fixture-env.ts';
import type { BenchContext, ScenarioResult } from '../types.ts';
import { measureCommand, repeatMeasure } from '../measure.ts';
import { TELEMETRY_MODES, telemetryEnv } from '../telemetry.ts';
import { VITE_MANY_SECRETS_SCHEMA, withSchemaFlags } from '../many-secrets-schema.ts';

const VITE_TEST_DIR = resolve(import.meta.dirname, '../../../framework-tests/frameworks/vite');

const BASELINE_VITE_CONFIG = `import { defineConfig } from 'vite';

export default defineConfig({});
`;

const BASELINE_MAIN = `document.querySelector('#app')!.textContent = 'bench';
`;

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
          res.end(\`ok padding=\${'x'.repeat(16_384)}\`);
        });
        server.middlewares.use('/api/log', (_req, res) => {
          for (let i = 0; i < 200; i++) {
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

function createViteEnv(
  ctx: BenchContext,
  mode: 'baseline' | 'varlock',
  labelSuffix = '',
): FrameworkTestEnv {
  const withVarlock = mode === 'varlock';
  return new FrameworkTestEnv({
    testDir: VITE_TEST_DIR,
    framework: `bench-vite-${mode}${labelSuffix}`,
    packageManager: 'npm',
    usePublished: true,
    installTimeout: 180_000,
    dependencies: {
      vite: '^6',
      ...(withVarlock
        ? {
          varlock: ctx.version,
          '@varlock/vite-integration': 'latest',
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

function prepareViteFiles(env: FrameworkTestEnv, mode: 'baseline' | 'varlock'): void {
  if (mode === 'baseline') {
    env.prepareFiles({
      templateFiles: {
        '.env.dev': 'schemas/.env.dev',
        'index.html': 'html/basic.html',
      },
      files: [
        { path: '.env.schema', content: VITE_MANY_SECRETS_SCHEMA },
        { path: 'vite.config.ts', content: BASELINE_VITE_CONFIG },
        { path: 'src/main.ts', content: BASELINE_MAIN },
      ],
    });
    return;
  }

  env.prepareFiles({
    templateFiles: {
      '.env.dev': 'schemas/.env.dev',
      'vite.config.ts': 'vite-configs/vite.config.ts',
      'index.html': 'html/basic.html',
      'src/main.ts': 'pages/basic-page.ts',
    },
    files: [{ path: '.env.schema', content: VITE_MANY_SECRETS_SCHEMA }],
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

async function withViteDevServer<T>(
  projectDir: string,
  port: number,
  fn: () => Promise<T>,
): Promise<T> {
  const server = spawn('npx', ['vite', 'dev', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: projectDir,
    env: {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(telemetryEnv('off')).filter(([, v]) => v !== undefined),
      ),
      APP_ENV: 'dev',
      CI: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  let stdout = '';
  server.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString();
  });
  server.stdout?.on('data', (c: Buffer) => {
    stdout += c.toString();
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/api/echo`, 90_000);
    return await fn();
  } catch (err) {
    throw new Error(`${String(err)}\nvite dev stdout:\n${stdout}\nstderr:\n${stderr}`);
  } finally {
    server.kill('SIGTERM');
    await new Promise<void>((r) => {
      setTimeout(r, 500);
    });
    if (!server.killed) server.kill('SIGKILL');
  }
}

export async function runViteScenarios(ctx: BenchContext): Promise<Array<ScenarioResult>> {
  const results: Array<ScenarioResult> = [];
  const buildIterations = Math.max(2, Math.min(4, ctx.iterations));
  const requestIterations = Math.max(10, ctx.iterations * 2);

  // Baseline: telemetry N/A (no varlock CLI). Tag as off for schema consistency.
  console.log('  preparing vite baseline (framework-tests)...');
  {
    const fixture = createViteEnv(ctx, 'baseline');
    await fixture.setup();
    prepareViteFiles(fixture, 'baseline');
    const build = await repeatMeasure(
      async () => {
        rmSync(join(fixture.dir, 'dist'), { recursive: true, force: true });
        return measureCommand(['npx', 'vite', 'build'], {
          cwd: fixture.dir,
          timeoutMs: 180_000,
          env: { ...telemetryEnv('off'), APP_ENV: 'dev', CI: '1' },
        });
      },
      { iterations: buildIterations, warmup: 0 },
    );
    results.push({
      id: 'integration.vite.build.baseline',
      facet: 'integration-vite',
      installMethod: 'npm',
      packageManager: 'npm',
      telemetry: 'off',
      metrics: build,
    });
    await fixture.teardown();
  }

  // Varlock build: telemetry on/off (plugin shells out to `varlock load`)
  for (const telemetry of TELEMETRY_MODES) {
    console.log(`  preparing vite varlock telemetry.${telemetry} (framework-tests)...`);
    const fixture = createViteEnv(ctx, 'varlock', `-telemetry-${telemetry}`);
    await fixture.setup();
    prepareViteFiles(fixture, 'varlock');
    const build = await repeatMeasure(
      async () => {
        rmSync(join(fixture.dir, 'dist'), { recursive: true, force: true });
        return measureCommand(['npx', 'vite', 'build'], {
          cwd: fixture.dir,
          timeoutMs: 180_000,
          env: { ...telemetryEnv(telemetry), APP_ENV: 'dev', CI: '1' },
        });
      },
      { iterations: buildIterations, warmup: 0 },
    );
    results.push({
      id: `integration.vite.build.varlock.telemetry.${telemetry}`,
      facet: 'integration-vite',
      installMethod: 'npm',
      packageManager: 'npm',
      telemetry,
      metrics: build,
      notes: 'Cold vite build; telemetry affects sync varlock load spawn',
    });
    await fixture.teardown();
  }

  console.log('  measuring vite request latency (preventLeaks / redactLogs)...');
  for (const [label, preventLeaks, redactLogs, port, path] of [
    ['preventLeaks.on', true, true, 3461, '/api/echo'],
    ['preventLeaks.off', false, true, 3462, '/api/echo'],
    ['redactLogs.on', true, true, 3463, '/api/log'],
    ['redactLogs.off', true, false, 3464, '/api/log'],
  ] as const) {
    const fixture = createViteEnv(ctx, 'varlock', `-${label}`);
    await fixture.setup();

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

    try {
      const latency = await withViteDevServer(fixture.dir, port, () => measurePathLatency(
        `http://127.0.0.1:${port}`,
        path,
        requestIterations,
        3,
      ));
      results.push({
        id: `integration.vite.request.${label}`,
        facet: 'integration-vite',
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
