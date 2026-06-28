import {
  existsSync, readFileSync, rmSync, unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function getUserVarlockDir() {
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'varlock');
  const legacyDir = join(homedir(), '.varlock');
  if (existsSync(legacyDir)) return legacyDir;
  return join(homedir(), '.config', 'varlock');
}

function getDaemonDir() {
  return join(getUserVarlockDir(), 'local-encrypt');
}

export function resetVarlockDaemon() {
  const daemonDir = getDaemonDir();
  const pidPath = join(daemonDir, 'daemon.pid');
  const socketPath = join(daemonDir, 'daemon.sock');
  const stateFiles = [
    pidPath,
    join(daemonDir, 'daemon.info'),
    socketPath,
    `${socketPath}.lock`,
  ];

  try {
    const pid = Number.parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  } catch {
    // No daemon pid file.
  }

  for (const file of stateFiles) {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
}

export function resetVarlockDaemonAfterKeychainSmoke() {
  resetVarlockDaemon();

  // Best-effort cleanup for empty directories left after daemon state removal.
  try {
    rmSync(getDaemonDir(), { recursive: false });
  } catch {
    // Directory may contain keys or other state; leave it alone.
  }
}
