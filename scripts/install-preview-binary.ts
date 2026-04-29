/**
 * Download and install a preview varlock binary from a PR's CI artifacts.
 *
 * Usage:
 *   bun run scripts/install-preview-binary.ts [PR_NUMBER]
 *
 * If PR_NUMBER is omitted, uses the current branch's open PR.
 * Detects your platform automatically and installs to ~/.config/varlock/bin.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKFLOW_NAME = 'binary-preview.yaml';

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8' }).trim();
}

function getArchiveName(): string {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  }
  if (platform === 'win32') {
    return 'win-x64';
  }
  throw new Error(`Unsupported platform: ${platform}/${arch}`);
}

function getInstallDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) return path.join(xdgConfig, 'varlock', 'bin');

  const legacyDir = path.join(os.homedir(), '.varlock');
  if (fs.existsSync(legacyDir)) return path.join(legacyDir, 'bin');

  return path.join(os.homedir(), '.config', 'varlock', 'bin');
}

// --- Resolve PR number ---
let prNumber = process.argv[2];

if (!prNumber) {
  console.log('No PR number provided, detecting from current branch...');
  try {
    const prJson = run('gh pr view --json number');
    prNumber = JSON.parse(prJson).number;
    console.log(`Found PR #${prNumber}`);
  } catch {
    console.error('Could not detect a PR for the current branch. Pass a PR number as an argument.');
    process.exit(1);
  }
}

// --- Find the workflow run ---
console.log(`Looking for preview binary workflow run on PR #${prNumber}...`);

let runId: string;
try {
  const runsJson = run(
    `gh run list --workflow=${WORKFLOW_NAME} --branch=$(gh pr view ${prNumber} --json headRefName -q .headRefName) --status=success --limit=1 --json databaseId`,
  );
  const runs = JSON.parse(runsJson);
  if (!runs.length) {
    console.error(
      `No successful "${WORKFLOW_NAME}" runs found for PR #${prNumber}.\n`
      + 'Make sure the PR has the "preview:standalone" label and the workflow has completed.',
    );
    process.exit(1);
  }
  runId = runs[0].databaseId;
  console.log(`Found workflow run: ${runId}`);
} catch (e) {
  console.error('Failed to find workflow run:', (e as Error).message);
  process.exit(1);
}

// --- Download the platform-specific artifact ---
const archiveName = getArchiveName();
const artifactName = `varlock-preview-${archiveName}`;
const isWin = os.platform() === 'win32';
const ext = isWin ? 'zip' : 'tar.gz';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-preview-'));
console.log(`Downloading ${artifactName} to ${tmpDir}...`);

try {
  run(`gh run download ${runId} --name ${artifactName} --dir "${tmpDir}"`);
} catch (e) {
  console.error('Failed to download artifact:', (e as Error).message);
  console.error('The workflow may still be running, or the artifact may have expired (14 day retention).');
  fs.rmSync(tmpDir, { recursive: true });
  process.exit(1);
}

const archiveFile = path.join(tmpDir, `varlock-${archiveName}.${ext}`);

if (!fs.existsSync(archiveFile)) {
  console.error(`Archive not found: varlock-${archiveName}.${ext}`);
  console.error('Available files:', fs.readdirSync(tmpDir).join(', '));
  fs.rmSync(tmpDir, { recursive: true });
  process.exit(1);
}

const installDir = getInstallDir();
fs.mkdirSync(installDir, { recursive: true });

console.log(`Extracting varlock-${archiveName}.${ext} to ${installDir}...`);

if (isWin) {
  run(`unzip -o "${archiveFile}" -d "${installDir}"`);
} else {
  run(`tar xzf "${archiveFile}" -C "${installDir}"`);
}

// --- Verify ---
const binaryPath = path.join(installDir, isWin ? 'varlock.exe' : 'varlock');
if (!fs.existsSync(binaryPath)) {
  console.error('Installation failed — binary not found after extraction.');
  fs.rmSync(tmpDir, { recursive: true });
  process.exit(1);
}

// Clean up
fs.rmSync(tmpDir, { recursive: true });

console.log(`\nInstalled preview binary to: ${binaryPath}`);
try {
  const version = run(`"${binaryPath}" --version`);
  console.log(`Version: ${version}`);
} catch {
  // version check is best-effort
}

// Check if it's on PATH
const pathDirs = (process.env.PATH || '').split(path.delimiter);
if (!pathDirs.includes(installDir)) {
  console.log(`\nNote: ${installDir} is not in your PATH.`);
  console.log(`Add it with: export PATH="${installDir}:$PATH"`);
}
