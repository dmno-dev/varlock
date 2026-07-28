/*
  Helpers for real-deployment tests against Vercel.

  These tests deploy an actual Next.js app (built remotely by Vercel) and assert
  runtime behavior on real infrastructure: lambda SSR, the real Edge runtime for
  middleware, runtime leak detection, and log redaction in Vercel's log pipeline.

  Auth: uses VERCEL_TOKEN if set (CI), otherwise falls back to the local Vercel
  CLI login (~/Library/Application Support/com.vercel.cli/auth.json or XDG path).
*/

import {
  cpSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { packPackages, getPackedDeps } from '../harness/pack.js';

const FRAMEWORK_TESTS_DIR = resolve(import.meta.dirname, '..');
const NEXTJS_FILES_DIR = join(FRAMEWORK_TESTS_DIR, 'frameworks/nextjs/files');

export const VERCEL_PROJECT_NAME = 'varlock-deploy-test';

export function getVercelToken(): string {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  // fall back to local CLI login
  const candidates = [
    join(homedir(), 'Library/Application Support/com.vercel.cli/auth.json'),
    join(homedir(), '.local/share/com.vercel.cli/auth.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const token = JSON.parse(readFileSync(p, 'utf8')).token;
      if (token) return token;
    }
  }
  throw new Error('No Vercel auth found — set VERCEL_TOKEN or run `vercel login`');
}

function vercelCliBase(): string {
  // bunx resolves the CLI without requiring a global install.
  // Only pass --token when explicitly provided (CI): with --token the CLI has no
  // team context and first-run deploys die at an interactive scope prompt, while
  // the stored local login carries its team. In CI, VERCEL_ORG_ID and
  // VERCEL_PROJECT_ID env vars (read natively by the CLI) provide the scoping.
  const tokenArg = process.env.VERCEL_TOKEN ? ` --token "${process.env.VERCEL_TOKEN}"` : '';
  return `bunx vercel${tokenArg}`;
}

/**
 * Build the deployable fixture app: the same shape the nextjs framework tests
 * use (app router + pages router + middleware + runtime-leaky page), with the
 * workspace-packed varlock tarballs vendored in via relative file: paths so
 * Vercel's remote build can install them.
 */
export function buildDeployFixture(opts?: { usePublished?: boolean, encrypted?: boolean }): string {
  const dir = join(FRAMEWORK_TESTS_DIR, '.test-projects', VERCEL_PROJECT_NAME);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // base skeleton (next.config with varlock plugin, tsconfig, app/layout)
  cpSync(join(NEXTJS_FILES_DIR, '_base'), dir, { recursive: true });

  for (const [dest, src] of Object.entries({
    '.env.schema': 'schemas/.env.schema',
    '.env.dev': 'schemas/.env.dev',
    '.env.prod': 'schemas/.env.prod',
    'app/page.tsx': 'pages/basic-page.tsx',
    'app/client-page/page.tsx': 'pages/client-page.tsx',
    'pages/pages-ssr.tsx': 'pages-router/ssr-page.tsx',
    'pages/leaky-ssr.tsx': 'pages-router/leaky-ssr-page.tsx',
    'middleware.ts': 'middleware/middleware.ts',
  })) {
    const destPath = join(dir, dest);
    mkdirSync(join(destPath, '..'), { recursive: true });
    cpSync(join(NEXTJS_FILES_DIR, src), destPath);
  }

  // make the middleware log the secret at request time so we can assert
  // console redaction inside Vercel's real Edge runtime
  const mwPath = join(dir, 'middleware.ts');
  writeFileSync(mwPath, readFileSync(mwPath, 'utf8').replace(
    'export function middleware() {',
    "export function middleware() {\n  console.log('mw-secret-log-test:', ENV.SENSITIVE_VAR);",
  ));

  // optionally enable encrypted deployments — the recommended setup on Vercel:
  // the build encrypts the injected env blob, and it is decrypted at boot using
  // _VARLOCK_ENV_KEY (an ephemeral key set on the project around the deploy —
  // see setProjectEnvKey). A build without the key fails loudly, so a green run
  // proves the decorator was honored and decryption worked.
  if (opts?.encrypted) {
    const schemaPath = join(dir, '.env.schema');
    writeFileSync(schemaPath, readFileSync(schemaPath, 'utf8').replace(
      '# ---',
      '# @encryptInjectedEnv\n# ---',
    ));
  }

  let varlockDep: string;
  let integrationDep: string;
  let nextEnvOverride: string;
  if (opts?.usePublished) {
    // monitor mode: test what users actually have installed
    varlockDep = 'latest';
    integrationDep = 'latest';
    nextEnvOverride = 'npm:@varlock/nextjs-integration@latest';
  } else {
    // default: test the current workspace code via packed tarballs, vendored
    // into the app dir so Vercel's remote build can resolve them
    packPackages(['varlock', '@varlock/nextjs-integration']);
    const packed = getPackedDeps(['varlock', '@varlock/nextjs-integration']);
    const varlockTgz = packed.varlock.replace(/^file:/, '');
    const integrationTgz = packed['@varlock/nextjs-integration'].replace(/^file:/, '');
    for (const tgz of [varlockTgz, integrationTgz]) cpSync(tgz, join(dir, tgz.split('/').pop()!));
    varlockDep = `file:./${varlockTgz.split('/').pop()}`;
    integrationDep = `file:./${integrationTgz.split('/').pop()}`;
    nextEnvOverride = integrationDep;
  }

  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: VERCEL_PROJECT_NAME,
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      next: '^16',
      react: '^19',
      'react-dom': '^19',
      '@types/react': '^19',
      // next's typescript setup verification hard-requires these; without them the
      // remote build dies with a swallowed exit-1 right after "Skipping validation"
      typescript: '^5.9.3',
      '@types/node': '^24',
      varlock: varlockDep,
      '@varlock/nextjs-integration': integrationDep,
    },
    scripts: { build: 'next build' },
    pnpm: { overrides: { '@next/env': nextEnvOverride } },
  }, null, 2)}\n`);

  // lockfile makes Vercel pick pnpm (the @next/env override is pnpm-shaped)
  writeFileSync(join(dir, '.npmrc'), 'ignore-workspace-root-check=true\n');
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 0\n');
  execSync('pnpm install', {
    cwd: dir,
    stdio: 'pipe',
    env: { ...process.env, COREPACK_ENABLE_PROJECT_SPEC: '0', COREPACK_ENABLE_STRICT: '0' },
  });

  writeFileSync(join(dir, '.vercelignore'), 'node_modules\n.next\n');
  return dir;
}

/** Deploy the fixture as a preview; resolves with the deployment URL. */
export function deployToVercel(dir: string): { url: string, output: string } {
  let output: string;
  try {
    output = execSync(`${vercelCliBase()} deploy --yes`, {
      cwd: dir,
      stdio: 'pipe',
      timeout: 10 * 60_000,
      env: { ...process.env, VERCEL_TELEMETRY_DISABLED: '1' },
    }).toString();
  } catch (err: any) {
    // execSync errors embed the full command line — scrub the token so it never
    // lands in test output / CI logs / local log files
    const scrubbed = String(err.message || err).replace(/--token "[^"]+"/g, '--token "<redacted>"');
    throw new Error(`vercel deploy failed: ${scrubbed}
${(err.stderr || '').toString().slice(-2000)}`);
  }
  const url = output.match(/https:\/\/[a-z0-9-]+\.vercel\.app/g)?.pop();
  if (!url) throw new Error(`could not find deployment url in vercel output:\n${output.slice(-2000)}`);
  return { url, output };
}

/**
 * These are throwaway test projects with fake values only — disable deployment
 * protection so the test can hit routes without SSO (idempotent).
 */
function teamIdQuery(): string {
  // when running with the CI token, the project lives under the varlockdev team
  // (VERCEL_ORG_ID from deploy/.env.schema); without it, the local CLI login's
  // default scope applies
  return process.env.VERCEL_ORG_ID ? `?teamId=${process.env.VERCEL_ORG_ID}` : '';
}

/**
 * Set/remove the ephemeral _VARLOCK_ENV_KEY on the project via the API.
 * `vercel deploy --env` rejects keys with a leading underscore ("must begin
 * with a letter"), so per-deployment env flags can't carry it — instead the
 * encrypted variant sets a project-level key just before deploying and removes
 * it right after. Env is snapshotted into a deployment at creation, so the
 * deployed lambda/edge keep decrypting after removal, and the plaintext
 * variant (which must NOT see a key — its mere presence triggers encryption)
 * clears it defensively before deploying.
 */
export async function setProjectEnvKey(value: string): Promise<void> {
  const token = getVercelToken();
  const upsertSep = process.env.VERCEL_ORG_ID ? '&' : '?';
  const resp = await fetch(`https://api.vercel.com/v10/projects/${VERCEL_PROJECT_NAME}/env${teamIdQuery()}${upsertSep}upsert=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: '_VARLOCK_ENV_KEY', value, type: 'sensitive', target: ['preview', 'production'],
    }),
  });
  if (!resp.ok) throw new Error(`failed to set _VARLOCK_ENV_KEY: ${resp.status} ${await resp.text()}`);
}

export async function removeProjectEnvKey(): Promise<void> {
  const token = getVercelToken();
  const list = await (await fetch(`https://api.vercel.com/v9/projects/${VERCEL_PROJECT_NAME}/env${teamIdQuery()}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json() as { envs?: Array<{ id: string, key: string }> };
  for (const env of list.envs ?? []) {
    if (env.key === '_VARLOCK_ENV_KEY') {
      await fetch(`https://api.vercel.com/v9/projects/${VERCEL_PROJECT_NAME}/env/${env.id}${teamIdQuery()}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  }
}

export async function disableDeploymentProtection(): Promise<void> {
  const token = getVercelToken();
  const resp = await fetch(`https://api.vercel.com/v9/projects/${VERCEL_PROJECT_NAME}${teamIdQuery()}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ssoProtection: null }),
  });
  if (!resp.ok) throw new Error(`failed to disable deployment protection: ${resp.status} ${await resp.text()}`);
}

/** Fetch the remote build logs for a deployment. */
export function getBuildLogs(url: string): string {
  return execSync(`${vercelCliBase()} inspect --logs ${url} 2>&1`, {
    stdio: 'pipe',
    timeout: 120_000,
  }).toString();
}

/**
 * Poll a deployed route until its body contains the expected marker — freshly
 * uploaded static routes can lag behind lambda/edge routes for a little while
 * (CDN propagation), so deploy tests must not assert immediately.
 */
export async function waitForRoute(
  url: string,
  mustContain: string,
  timeoutMs = 90_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastBody = '';
  while (Date.now() < deadline) {
    try {
      lastBody = await (await fetch(url)).text();
      if (lastBody.includes(mustContain)) return lastBody;
    } catch { /* transient */ }
    await new Promise<void>((r) => {
      setTimeout(r, 3_000);
    });
  }
  throw new Error(`route ${url} never contained "${mustContain}" within ${timeoutMs}ms; last body:\n${lastBody.slice(0, 2000)}`);
}

async function getDeploymentInfo(url: string): Promise<{ id: string, projectId: string }> {
  const token = getVercelToken();
  const host = url.replace(/^https:\/\//, '');
  const resp = await fetch(`https://api.vercel.com/v13/deployments/${host}${teamIdQuery()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`failed to look up deployment ${host}: ${resp.status}`);
  const data = await resp.json() as { id: string, projectId: string };
  return { id: data.id, projectId: data.projectId };
}

/**
 * Read recent runtime (function/edge) logs via Vercel's runtime-logs API.
 * The endpoint streams (historical logs first, then live), so we read for a
 * bounded window and return whatever accumulated.
 */
async function fetchRuntimeLogs(url: string, readMs = 8_000): Promise<string> {
  const token = getVercelToken();
  const { id, projectId } = await getDeploymentInfo(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), readMs);
  const chunks: Array<string> = [];
  try {
    const resp = await fetch(
      `https://api.vercel.com/v1/projects/${projectId}/deployments/${id}/runtime-logs?format=json${process.env.VERCEL_ORG_ID ? `&teamId=${process.env.VERCEL_ORG_ID}` : ''}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
    );
    if (!resp.ok || !resp.body) throw new Error(`runtime-logs request failed: ${resp.status}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
  } catch { /* aborted after readMs — expected */ } finally {
    clearTimeout(timer);
  }
  return chunks.join('');
}

/**
 * Capture runtime logs generated by `during()`'s requests. Vercel's log
 * pipeline can lag by tens of seconds, so we poll the runtime-logs API until
 * all expected markers appear (re-firing the requests periodically) or the
 * deadline passes.
 */
export async function captureRuntimeLogs(
  url: string,
  during: () => Promise<void>,
  expectedMarkers: Array<string>,
  timeoutMs = 150_000,
): Promise<string> {
  await during();
  const deadline = Date.now() + timeoutMs;
  let lastRefire = Date.now();
  let logs = '';

  while (true) {
    logs = await fetchRuntimeLogs(url);
    const captured = logs;
    if (expectedMarkers.every((m) => captured.includes(m))) break;
    if (Date.now() > deadline) break;
    if (Date.now() - lastRefire > 30_000) {
      lastRefire = Date.now();
      await during();
    }
    await new Promise<void>((r) => {
      setTimeout(r, 5_000);
    });
  }
  return logs;
}

/** Best-effort removal of a deployment (keeps the throwaway project tidy). */
export function removeDeployment(url: string): void {
  try {
    execSync(`${vercelCliBase()} remove ${url} --yes`, { stdio: 'pipe', timeout: 60_000 });
  } catch { /* best effort */ }
}

/** Clean up old fixture dirs (the project on Vercel persists across runs). */
export function cleanupFixture(dir: string): void {
  if (process.env.KEEP_TEST_DIRS) return;
  rmSync(dir, { recursive: true, force: true });
}
