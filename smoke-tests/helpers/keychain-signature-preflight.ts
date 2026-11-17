import { spawnSync } from 'node:child_process';
import { runVarlock } from './run-varlock.js';

function signingHint(reason: string, helperPath?: string) {
  return [
    'macOS Keychain smoke-test preflight failed.',
    '',
    reason,
    '',
    'The Keychain smoke tests require VarlockEnclave to be signed with an Apple',
    'development or distribution certificate. Ad-hoc signed helper binaries have',
    'no stable Team ID, so macOS treats every rebuild as a new app and keeps',
    'prompting for Keychain access.',
    '',
    'To configure local signing:',
    '  1. Run: security find-identity -v -p codesigning',
    '  2. Set APPLE_SIGNING_IDENTITY in packages/encryption-binary-swift/.env.local',
    '  3. Rebuild with: bun run build:swift',
    ...(helperPath ? ['', `Resolved helper: ${helperPath}`] : []),
  ].join('\n');
}

/** Ask varlock which native helper it resolves, so we check the binary that will actually run */
function resolveHelperPath() {
  const result = runVarlock(['keychain', 'list', 'varlock-smoke-preflight'], {
    env: { VARLOCK_DEBUG: '1' },
  });
  const binaryPath = result.stderr.match(/\[varlock:binary-resolver\] resolved via [^:]+: (.+)$/m)?.[1]?.trim();
  if (!binaryPath) return undefined;
  // Sign checks apply to the .app bundle when the helper lives inside one
  const appBundleMatch = binaryPath.match(/^(.+?\.app)\//);
  return appBundleMatch?.[1] ?? binaryPath;
}

/**
 * Fail fast when the macOS helper is missing or not signed with a stable Team ID.
 * Call from a `beforeAll` inside the gated keychain describe block.
 */
export function assertKeychainHelperSigned() {
  const helperPath = resolveHelperPath();
  if (!helperPath) {
    throw new Error(signingHint('Could not resolve the VarlockEnclave helper binary.'));
  }

  const verification = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', helperPath], { encoding: 'utf-8' });
  if (verification.status !== 0) {
    const details = (verification.stderr || verification.stdout).trim();
    throw new Error(signingHint(`The VarlockEnclave signature is invalid.${details ? `\n\n${details}` : ''}`, helperPath));
  }

  const inspection = spawnSync('codesign', ['-dv', '--verbose=4', helperPath], { encoding: 'utf-8' });
  const inspectionOutput = `${inspection.stdout}\n${inspection.stderr}`;
  const teamId = inspectionOutput.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const signature = inspectionOutput.match(/^Signature=(.+)$/m)?.[1]?.trim();
  if (inspection.status !== 0 || !teamId || teamId === 'not set' || signature === 'adhoc') {
    throw new Error(signingHint('The VarlockEnclave helper is unsigned or ad-hoc signed; no stable Team ID was found.', helperPath));
  }
}
