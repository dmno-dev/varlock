/*
  Real-deployment tests: deploy the nextjs smoke app to Vercel (remote build)
  and assert runtime behavior on real infrastructure — lambda SSR, the real
  Edge runtime for middleware, runtime leak detection, and log redaction in
  Vercel's log pipeline.

  Two deployments are tested:
  - plaintext env (full matrix incl. middleware)
  - encrypted env via @encryptInjectedEnv — the recommended Vercel setup: the
    build encrypts the injected env blob and lambda decrypts it at boot using
    an ephemeral _VARLOCK_ENV_KEY passed to that single deployment's build +
    runtime env (nothing stored on the project).

  NOT part of normal test runs — gated by VERCEL_DEPLOY_TESTS=1 and run on a
  weekly schedule / manual dispatch (deploy-tests.workflow.yaml), or locally:

    cd framework-tests && VERCEL_DEPLOY_TESTS=1 varlock run --path ./deploy -- bunx vitest run deploy/

  Auth is resolved by varlock from 1Password (see deploy/.env.schema); without
  the wrapper the helpers fall back to your `vercel login`.
  Set DEPLOY_TESTS_PUBLISHED=1 to test the latest published packages instead
  of the current workspace code.
*/

import { randomBytes } from 'node:crypto';
import {
  describe, test, expect, beforeAll, afterAll, afterEach,
} from 'vitest';
import {
  buildDeployFixture, deployToVercel, disableDeploymentProtection,
  getBuildLogs, captureRuntimeLogs, removeDeployment, cleanupFixture, waitForRoute,
} from './vercel-helpers.js';

const SECRET_VALUE = 'super-secret-var';

function defineDeploymentTests(label: string, opts: { encrypted: boolean }) {
  describe(label, () => {
    let fixtureDir: string;
    let url: string;
    let buildOutput: string;
    let failed = false;

    beforeAll(async () => {
      fixtureDir = buildDeployFixture({
        usePublished: !!process.env.DEPLOY_TESTS_PUBLISHED,
        encrypted: opts.encrypted,
      });
      await disableDeploymentProtection().catch(() => {
        // project may not exist yet on the very first deploy — retried after
      });
      // ephemeral key, scoped to this single deployment (build encrypt + runtime decrypt)
      const deployed = deployToVercel(fixtureDir, {
        envKey: opts.encrypted ? randomBytes(32).toString('hex') : undefined,
      });
      url = deployed.url;
      buildOutput = deployed.output;
      await disableDeploymentProtection();
      console.log(`deployed (${label}): ${url}`);
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
      // no varlock binary exists at runtime — env comes entirely from the
      // injected bundle (decrypted at boot in the encrypted variant)
      const body = await (await fetch(`${url}/pages-ssr`)).text();
      expect(body).toContain('Varlock Pages Router SSR Page');
      expect(body).toContain('unprefixed-public-var');
      expect(body).toContain('pages-ssr-sensitive-available');
      expect(body).not.toContain(SECRET_VALUE);
    });

    if (!opts.encrypted) {
      test('middleware on the real Edge runtime reads env (incl. sensitive)', async () => {
        const body = await (await fetch(`${url}/middleware-test`)).text();
        expect(body).toContain('varlock-middleware-response');
        expect(body).toContain('unprefixed-public-var');
        expect(body).toContain('middleware-sensitive-available');
        expect(body).not.toContain(SECRET_VALUE);
      });
    } else {
      test('KNOWN LIMITATION: middleware cannot decrypt on the Edge runtime', async () => {
        // Vercel's edge-light runtime has no node:crypto (no process.getBuiltinModule,
        // no resolvable require), so decryptEnvBlobSync fails at boot and middleware
        // 500s with a clear "[varlock] node:crypto is not available" error. Fixing
        // this needs an async WebCrypto decrypt path in init-edge. When that lands,
        // this test will fail — replace it with the full middleware assertions above.
        const resp = await fetch(`${url}/middleware-test`);
        expect(resp.status).toBe(500);
        expect(await resp.text()).not.toContain(SECRET_VALUE);
      });
    }

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

    test('runtime logs: secrets redacted, leak detection fires', async () => {
      // middleware's redacted secret log only exists where middleware runs
      // (see the KNOWN LIMITATION above for the encrypted variant)
      const expectedMarkers = [
        'DETECTED LEAKED SENSITIVE CONFIG',
        ...opts.encrypted ? [] : ['mw-secret-log-test:'],
      ];
      const logs = await captureRuntimeLogs(url, async () => {
        await fetch(`${url}/middleware-test`).catch(() => undefined);
        await fetch(`${url}/leaky-ssr`).catch(() => undefined);
      }, expectedMarkers);
      for (const marker of expectedMarkers) expect(logs).toContain(marker);
      // the raw secret must not appear anywhere in the log pipeline
      expect(logs).not.toContain(SECRET_VALUE);
    }, 240_000);
  });
}

describe.skipIf(!process.env.VERCEL_DEPLOY_TESTS)('vercel deployment', () => {
  defineDeploymentTests('plaintext env', { encrypted: false });
  defineDeploymentTests('encrypted env (@encryptInjectedEnv)', { encrypted: true });
});
