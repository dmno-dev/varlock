import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const RUN_KEYCHAIN_SMOKE = process.env.VARLOCK_RUN_KEYCHAIN_SMOKE === '1';
const VARLOCK_PACKAGE_DIR = join(import.meta.dirname, '..', 'node_modules', 'varlock');
const HELPER_APP_PATH = join(
  VARLOCK_PACKAGE_DIR,
  'native-bins',
  'darwin',
  'VarlockEnclave.app',
);

function signingHint(reason: string) {
  return [
    'macOS Keychain smoke-test preflight failed.',
    '',
    reason,
    '',
    'The Keychain smoke tests require VarlockEnclave to be signed with an Apple',
    'development or distribution certificate. Ad-hoc signed helper binaries have',
    'no stable Team ID and produce more macOS Keychain security prompts than',
    'correctly signed development binaries.',
    '',
    'To configure local signing:',
    '  1. Run: security find-identity -v -p codesigning',
    '  2. Set APPLE_SIGNING_IDENTITY in packages/encryption-binary-swift/.env.local',
    '  3. Rebuild with: bun run build:swift',
    '',
    `Expected helper bundle: ${HELPER_APP_PATH}`,
  ].join('\n');
}

export default function keychainSignaturePreflight() {
  if (!RUN_KEYCHAIN_SMOKE || process.platform !== 'darwin') return;

  if (!existsSync(HELPER_APP_PATH)) {
    throw new Error(signingHint('The VarlockEnclave app bundle was not found.'));
  }

  const verification = spawnSync('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    HELPER_APP_PATH,
  ], { encoding: 'utf-8' });

  if (verification.status !== 0) {
    const details = (verification.stderr || verification.stdout).trim();
    throw new Error(signingHint(`The VarlockEnclave signature is invalid.${details ? `\n\n${details}` : ''}`));
  }

  const inspection = spawnSync('codesign', [
    '-dv',
    '--verbose=4',
    HELPER_APP_PATH,
  ], { encoding: 'utf-8' });
  const inspectionOutput = `${inspection.stdout}\n${inspection.stderr}`;
  const teamId = inspectionOutput.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const signature = inspectionOutput.match(/^Signature=(.+)$/m)?.[1]?.trim();

  if (inspection.status !== 0 || !teamId || teamId === 'not set' || signature === 'adhoc') {
    throw new Error(signingHint('The VarlockEnclave helper is unsigned or ad-hoc signed; no stable Team ID was found.'));
  }
}
