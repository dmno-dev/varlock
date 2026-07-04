/*
  Real-deployment tests: deploy the nextjs smoke app to Vercel (remote build)
  and assert runtime behavior on real infrastructure — lambda SSR, the real
  Edge runtime for middleware, runtime leak detection, and log redaction in
  Vercel's log pipeline.

  NOT part of normal test runs — gated by VERCEL_DEPLOY_TESTS=1 and run on a
  weekly schedule / manual dispatch (.github/workflows/deploy-tests.yaml), or
  locally via:

    cd framework-tests && VERCEL_DEPLOY_TESTS=1 bunx vitest run deploy/

  Local runs use your `vercel login`; CI uses the VERCEL_TOKEN secret.
  Set DEPLOY_TESTS_PUBLISHED=1 to test the latest published packages instead
  of the current workspace code.
*/

import {
  describe, test, expect, beforeAll, afterAll, afterEach,
} from 'vitest';
import {
  buildDeployFixture, deployToVercel, disableDeploymentProtection,
  getBuildLogs, captureRuntimeLogs, removeDeployment, cleanupFixture, waitForRoute,
} from './vercel-helpers.js';

const SECRET_VALUE = 'super-secret-var';

describe.skipIf(!process.env.VERCEL_DEPLOY_TESTS)('vercel deployment', () => {
  let fixtureDir: string;
  let url: string;
  let buildOutput: string;
  let failed = false;

  beforeAll(async () => {
    fixtureDir = buildDeployFixture({ usePublished: !!process.env.DEPLOY_TESTS_PUBLISHED });
    await disableDeploymentProtection().catch(() => {
      // project may not exist yet on the very first deploy — retried after
    });
    const deployed = deployToVercel(fixtureDir);
    url = deployed.url;
    buildOutput = deployed.output;
    await disableDeploymentProtection();
    console.log(`deployed: ${url}`);
    // static routes can lag behind lambda/edge routes right after a deploy —
    // wait for CDN propagation before asserting anything
    await waitForRoute(`${url}/`, 'Varlock Framework Test');
    await waitForRoute(`${url}/client-page`, 'Varlock Client Component Page');
  }, 15 * 60_000);

  afterAll(() => {
    // keep failed deployments around for debugging (they're throwaway previews)
    if (url && !failed) removeDeployment(url);
    if (fixtureDir) cleanupFixture(fixtureDir);
  });

  afterEach((ctx) => {
    if (ctx.task.result?.state === 'fail') failed = true;
  });

  test('remote build succeeded', () => {
    expect(url).toMatch(/^https:\/\//);
  });

  test('app-router static page serves correct env values (CDN)', async () => {
    const body = await (await fetch(`${url}/`)).text();
    expect(body).toContain('next-prefixed-public-var');
    expect(body).toContain('unprefixed-public-var');
    expect(body).toContain('sensitive-var-available');
    expect(body).not.toContain(SECRET_VALUE);
  });

  test('client component page has public env values inlined', async () => {
    const body = await (await fetch(`${url}/client-page`)).text();
    expect(body).toContain('next-prefixed-public-var');
    expect(body).toContain('unprefixed-public-var');
    expect(body).not.toContain(SECRET_VALUE);
  });

  test('pages-router SSR on a real lambda reads env at request time', async () => {
    // no varlock binary exists at runtime — env must come from the injected bundle
    const body = await (await fetch(`${url}/pages-ssr`)).text();
    expect(body).toContain('Varlock Pages Router SSR Page');
    expect(body).toContain('unprefixed-public-var');
    expect(body).toContain('pages-ssr-sensitive-available');
    expect(body).not.toContain(SECRET_VALUE);
  });

  test('middleware on the real Edge runtime reads env (incl. sensitive)', async () => {
    const body = await (await fetch(`${url}/middleware-test`)).text();
    expect(body).toContain('varlock-middleware-response');
    expect(body).toContain('unprefixed-public-var');
    expect(body).toContain('middleware-sensitive-available');
    expect(body).not.toContain(SECRET_VALUE);
  });

  test('runtime leak detection blocks a request-time leak on lambda', async () => {
    // getServerSideProps leaks the secret — invisible to build scans, must be
    // caught by response scanning at runtime (500 or killed connection)
    let status = 0;
    let body = '';
    try {
      const resp = await fetch(`${url}/leaky-ssr`);
      status = resp.status;
      body = await resp.text();
    } catch { /* connection killed mid-stream also counts as blocked */ }
    expect(status, 'leaky response must not be served successfully').not.toBe(200);
    expect(body).not.toContain(SECRET_VALUE);
  });

  test('build logs: pre-render secret log is redacted', () => {
    const logs = buildOutput + getBuildLogs(url);
    // the static page logs the secret during pre-render — the log line must be
    // present (proving the worker ran) but the value must be redacted
    expect(logs).toContain('secret-log-test:');
    expect(logs).not.toContain(SECRET_VALUE);
  });

  test('runtime logs: secrets redacted in lambda + edge, leak detection fires', async () => {
    const logs = await captureRuntimeLogs(url, async () => {
      await fetch(`${url}/middleware-test`);
      await fetch(`${url}/leaky-ssr`).catch(() => undefined);
    }, ['mw-secret-log-test:', 'DETECTED LEAKED SENSITIVE CONFIG']);
    // edge middleware logged the secret — must come out redacted
    expect(logs).toContain('mw-secret-log-test:');
    // the leaky lambda response triggered detection
    expect(logs).toContain('DETECTED LEAKED SENSITIVE CONFIG');
    // and the raw secret must not appear anywhere in the log pipeline
    expect(logs).not.toContain(SECRET_VALUE);
  }, 240_000);
});
