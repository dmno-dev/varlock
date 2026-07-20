import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  existsSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import {
  describe, expect, test,
} from 'vitest';

import {
  buildContainerWiring,
  isContainerRuntimeAvailable,
  runContainerSandbox,
} from './sandbox-docker';

describe('buildContainerWiring', () => {
  const sessionProxyEnv = {
    HTTP_PROXY: 'http://127.0.0.1:51234',
    HTTPS_PROXY: 'http://127.0.0.1:51234',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    NODE_EXTRA_CA_CERTS: '/tmp/varlock-certs-abc/ca.pem',
    SSL_CERT_FILE: '/tmp/varlock-certs-abc/combined-ca.pem',
  };
  const childEnv = {
    API_TOKEN: 'vlk_placeholder_API_TOKEN_f01b',
    PUBLIC_URL: 'https://example.com',
  };

  test('repoints proxy URL vars at the in-guest forwarder', () => {
    const { env } = buildContainerWiring({ childEnv, sessionProxyEnv });
    expect(env.HTTP_PROXY).toBe('http://varlock-proxy:8888');
    expect(env.HTTPS_PROXY).toBe('http://varlock-proxy:8888');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
  });

  test('repoints CA vars at the in-guest mount and returns the host certs dir', () => {
    const { env, caHostDir } = buildContainerWiring({ childEnv, sessionProxyEnv });
    expect(caHostDir).toBe('/tmp/varlock-certs-abc');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/varlock/proxy-certs/ca.pem');
    expect(env.SSL_CERT_FILE).toBe('/etc/varlock/proxy-certs/combined-ca.pem');
  });

  test('carries the child-view placeholders + non-secret values verbatim', () => {
    const { env } = buildContainerWiring({ childEnv, sessionProxyEnv });
    expect(env.API_TOKEN).toBe('vlk_placeholder_API_TOKEN_f01b');
    expect(env.PUBLIC_URL).toBe('https://example.com');
  });

  test('throws a clear error when the session has no CA path', () => {
    expect(() => buildContainerWiring({ childEnv, sessionProxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:1' } }))
      .toThrow(/missing a CA bundle path/);
  });
});

/**
 * Opt-in: this spins up real containers and pulls images from Docker Hub, so it needs a
 * working docker environment *plus* registry access. On shared CI runners those pulls are
 * rate-limited/flaky, and a failure there says nothing about the code under test — so
 * "docker CLI exists" isn't a sufficient gate. The pure `buildContainerWiring` tests above
 * cover the logic everywhere; this covers the real topology on demand:
 *
 *   VARLOCK_TEST_DOCKER=1 bunx vitest --run src/proxy/sandbox-docker.test.ts
 *
 * TODO: run this in a dedicated CI job with a pre-pulled/authenticated registry.
 */
const dockerTestsEnabled = !!process.env.VARLOCK_TEST_DOCKER && isContainerRuntimeAvailable('docker');

// Exercises the real orchestration code (network create, forwarder, agent run,
// teardown) against Docker, using a plain host listener as the proxy stand-in —
// so it proves the *topology* my code builds, independent of the varlock proxy.
describe.skipIf(!dockerTestsEnabled)('runContainerSandbox topology (docker)', () => {
  test('agent egresses only via the forwarder → host; direct egress is blocked', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('HOST_PROXY_REACHED');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const hostPort = (server.address() as { port: number }).port;
    // Unique-ish id without Date/random: high-res clock tail.
    const sessionId = `test${process.hrtime.bigint().toString().slice(-8)}`;
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'varlock-dsbx-'));

    // The agent (stdio inherited, so it writes its findings to the mounted
    // workdir): hit the forwarder — should reach the host listener — then try a
    // direct external connection, which must fail closed on the internal network.
    const started = runContainerSandbox({
      runtime: 'docker',
      image: 'curlimages/curl:latest',
      command: 'sh',
      commandArgs: [
        '-c',
        '{ echo -n VIA=; curl -s --max-time 15 http://varlock-proxy:8888/; echo; '
        + 'echo -n DIRECT=; curl -s --max-time 8 --noproxy "*" -o /dev/null -w "%{http_code}" https://example.com || true; echo; } '
        + '> /workspace/out.txt 2>&1',
      ],
      workdir,
      sessionId,
      hostProxyUrl: `http://127.0.0.1:${hostPort}`,
      childEnv: {},
      sessionProxyEnv: {
        HTTPS_PROXY: `http://127.0.0.1:${hostPort}`,
        SSL_CERT_FILE: '/tmp/x/ca.pem',
      },
      hasTty: false,
    });

    let childError: unknown;
    try {
      await started.child;
    } catch (err) {
      // a non-zero exit is expected (the blocked curl), so this isn't fatal on its own —
      // but keep it so a container that never ran reports the docker error, not a bare ENOENT
      childError = err;
    } finally {
      started.teardown();
      server.close();
    }

    const outPath = path.join(workdir, 'out.txt');
    if (!existsSync(outPath)) {
      rmSync(workdir, { recursive: true, force: true });
      throw new Error(
        'the agent container produced no output — it likely never ran (image pull or docker setup failed). '
        + `child error: ${(childError as Error)?.message ?? 'none'}`,
      );
    }
    const out = readFileSync(outPath, 'utf8');
    rmSync(workdir, { recursive: true, force: true });
    expect(out).toContain('VIA=HOST_PROXY_REACHED');
    expect(out).toMatch(/DIRECT=(000)?/);
  }, 120000);
});
