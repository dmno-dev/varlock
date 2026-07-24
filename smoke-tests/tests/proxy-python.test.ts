import { describe, expect, test } from 'vitest';
import { execSync } from 'node:child_process';

import { runVarlock } from '../helpers/run-varlock';
import { hasBinary, runBinary } from '../helpers/run-varlock-binary';

// End-to-end proof that a real Python client works through the credential
// proxy with zero client-side setup: python picks up HTTPS_PROXY + SSL_CERT_FILE
// from the injected env, opens a CONNECT tunnel, and verifies the minted MITM
// leaf with STRICT verification. python 3.13+ enables VERIFY_X509_STRICT by
// default, which rejects chains missing subject/authority key identifiers; we
// force the flag so any CPython exercises the same check. The target
// (example.com) matches the fixture's @proxy rule, so the request takes the
// full MITM path (summary shows matched=1), not a passthrough tunnel.
//
// Apple's system python (LibreSSL build) ignores SSL_CERT_FILE and its strict
// checks differ, so only an OpenSSL-backed python is meaningful here; skip
// otherwise. CI runners (linux/macos/windows) all provide OpenSSL pythons.
function findOpensslPython(): string | undefined {
  // Versioned names cover macOS dev machines where plain python3 is Apple's
  // LibreSSL build but a homebrew/pyenv python is also on PATH.
  for (const cmd of ['python3', 'python', 'python3.14', 'python3.13', 'python3.12']) {
    try {
      const backend = execSync(`${cmd} -c "import ssl; print(ssl.OPENSSL_VERSION)"`, {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
      });
      if (backend.trim().startsWith('OpenSSL')) return cmd;
    } catch {
      // not installed / broken; try the next candidate
    }
  }
  return undefined;
}

const PYTHON = findOpensslPython();
// proxy run is not exercised on windows yet; scope the smoke test accordingly
const SKIP = process.platform === 'win32' || !PYTHON;

const PYTHON_CLIENT = `
import ssl, urllib.request, urllib.error
ctx = ssl.create_default_context()
ctx.verify_flags |= ssl.VERIFY_X509_STRICT
try:
    r = urllib.request.urlopen('https://example.com/', timeout=30, context=ctx)
    print('STATUS', r.status)
except urllib.error.HTTPError as e:
    print('STATUS', e.code)
except urllib.error.URLError as e:
    print('URLERROR', e.reason)
`;

describe('python through the credential proxy (strict TLS verification)', () => {
  test.skipIf(SKIP)('urllib completes a strict-verified MITM request (installed CLI)', () => {
    const result = runVarlock(
      ['proxy', 'run', '--', PYTHON!, '-c', PYTHON_CLIENT],
      { cwd: 'smoke-test-proxy' },
    );

    // A cert-chain failure surfaces as URLERROR (CERTIFICATE_VERIFY_FAILED),
    // never a STATUS line. matched=1 in the session summary proves the request
    // took the MITM path (rule matched), not a passthrough tunnel.
    expect(result.output).toContain('STATUS 200');
    expect(result.output).toContain('matched=1');
  }, 120_000);

  test.skipIf(SKIP || !hasBinary())('urllib completes a strict-verified MITM request (compiled binary)', () => {
    // The bundled/compiled binary is the risky artifact for cert generation
    // (module init order differs from bun run / vitest), so prove it there too.
    const result = runBinary(
      ['proxy', 'run', '--', PYTHON!, '-c', PYTHON_CLIENT],
      { cwd: 'smoke-test-proxy' },
    );

    expect(result.output).toContain('STATUS 200');
    expect(result.output).toContain('matched=1');
  }, 120_000);
});
