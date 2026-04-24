import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { getUserVarlockDir } from '../src/lib/user-config-dir';
import { resolveNativeBinary } from '../src/lib/local-encrypt/binary-resolver';

type JsonObject = Record<string, unknown>;

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    verbose: args.includes('--verbose'),
    status: args.includes('--status'),
  };
}

function log(msg: string) {
  process.stdout.write(`${msg}\n`);
}

function logVerbose(enabled: boolean, msg: string) {
  if (enabled) log(msg);
}

function runNativeJson(binaryPath: string, args: Array<string>): JsonObject | undefined {
  const result = spawnSync(binaryPath, args, {
    encoding: 'utf-8',
    timeout: 30_000,
  });

  if (result.error || result.status !== 0) {
    return undefined;
  }

  const output = (result.stdout || '').trim();
  if (!output) return undefined;

  try {
    const parsed = JSON.parse(output) as JsonObject;
    if (typeof parsed.error === 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function removeFile(filePath: string, dryRun: boolean, verbose: boolean): boolean {
  if (!fs.existsSync(filePath)) return false;

  if (dryRun) {
    log(`[dry-run] remove ${filePath}`);
    return true;
  }

  try {
    fs.rmSync(filePath, { force: true });
    logVerbose(verbose, `removed ${filePath}`);
    return true;
  } catch {
    return false;
  }
}

function removeEmptyDir(dirPath: string, dryRun: boolean, verbose: boolean): boolean {
  if (!fs.existsSync(dirPath)) return false;

  try {
    const entries = fs.readdirSync(dirPath);
    if (entries.length > 0) return false;

    if (dryRun) {
      log(`[dry-run] remove empty dir ${dirPath}`);
      return true;
    }

    fs.rmdirSync(dirPath);
    logVerbose(verbose, `removed empty dir ${dirPath}`);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const { dryRun, verbose, status } = parseArgs();

  const userVarlockDir = getUserVarlockDir();
  const localEncryptDir = path.join(userVarlockDir, 'local-encrypt');
  const keysDir = path.join(localEncryptDir, 'keys');
  const daemonPidPath = path.join(localEncryptDir, 'daemon.pid');
  const daemonInfoPath = path.join(localEncryptDir, 'daemon.info');
  const daemonSockPath = path.join(localEncryptDir, 'daemon.sock');
  const daemonSockLockPath = `${daemonSockPath}.lock`;

  log(`Local encryption state dir: ${localEncryptDir}`);

  let deletedKeyCount = 0;
  let removedFileArtifacts = 0;
  let removedDirs = 0;

  const nativeBinary = resolveNativeBinary();
  if (nativeBinary) {
    const listResult = runNativeJson(nativeBinary, ['list-keys']);
    const keyList = Array.isArray(listResult?.keys)
      ? listResult.keys.filter((k): k is string => typeof k === 'string')
      : [];

    for (const keyId of keyList) {
      if (dryRun) {
        log(`[dry-run] native delete-key --key-id ${keyId}`);
        deletedKeyCount += 1;
        continue;
      }

      const deleted = runNativeJson(nativeBinary, ['delete-key', '--key-id', keyId]);
      if (deleted && deleted.deleted === true) {
        deletedKeyCount += 1;
        logVerbose(verbose, `deleted key ${keyId} via native helper`);
      }
    }
  }

  if (fs.existsSync(keysDir)) {
    const keyFiles = fs.readdirSync(keysDir)
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) => path.join(keysDir, fileName));

    for (const filePath of keyFiles) {
      if (removeFile(filePath, dryRun, verbose)) {
        removedFileArtifacts += 1;
      }
    }
  }

  if (fs.existsSync(daemonPidPath)) {
    try {
      const pidRaw = fs.readFileSync(daemonPidPath, 'utf-8').trim();
      const pid = Number.parseInt(pidRaw, 10);
      if (!Number.isNaN(pid) && pid > 0) {
        if (dryRun) {
          log(`[dry-run] kill daemon pid ${pid}`);
        } else {
          try {
            process.kill(pid, 'SIGTERM');
            logVerbose(verbose, `sent SIGTERM to daemon pid ${pid}`);
          } catch {
            // stale pid or permission issue; file cleanup still proceeds
          }
        }
      }
    } catch {
      // ignore parse/read issues
    }
  }

  for (const filePath of [daemonPidPath, daemonInfoPath, daemonSockPath, daemonSockLockPath]) {
    if (removeFile(filePath, dryRun, verbose)) {
      removedFileArtifacts += 1;
    }
  }

  if (removeEmptyDir(keysDir, dryRun, verbose)) {
    removedDirs += 1;
  }
  if (removeEmptyDir(localEncryptDir, dryRun, verbose)) {
    removedDirs += 1;
  }

  log('');
  log('Reset summary:');
  log(`  Deleted keys via helper: ${deletedKeyCount}`);
  log(`  Removed files: ${removedFileArtifacts}`);
  log(`  Removed empty dirs: ${removedDirs}`);
  log(`  Mode: ${dryRun ? 'dry-run' : 'apply'}`);

  if (!status) return;

  log('');
  log('Post-reset status:');
  if (!nativeBinary) {
    log('  Native helper: not found');
    return;
  }

  const nativeStatus = runNativeJson(nativeBinary, ['status']);
  if (!nativeStatus) {
    log('  Native helper status: unavailable');
    return;
  }

  const backend = typeof nativeStatus.backend === 'string' ? nativeStatus.backend : 'unknown';
  const hardwareBacked = nativeStatus.hardwareBacked === true ? 'yes' : 'no';
  const biometricAvailable = nativeStatus.biometricAvailable === true ? 'yes' : 'no';

  const listResult = runNativeJson(nativeBinary, ['list-keys']);
  const keyCount = Array.isArray(listResult?.keys)
    ? listResult.keys.filter((k): k is string => typeof k === 'string').length
    : 0;

  log(`  Backend: ${backend}`);
  log(`  Hardware-backed: ${hardwareBacked}`);
  log(`  Biometric available: ${biometricAvailable}`);
  log(`  Keys remaining: ${keyCount}`);
}

main();
