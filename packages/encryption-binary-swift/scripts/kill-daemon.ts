#!/usr/bin/env bun

/**
 * Kill the running VarlockEnclave daemon (if any).
 *
 * Reads the PID from the local-encrypt daemon.pid,
 * sends SIGTERM, and cleans up PID and socket files.
 */

import path from 'node:path';
import fs from 'node:fs';
import { getUserVarlockDir } from '../../../packages/varlock/src/lib/user-config-dir';

const socketDir = path.join(getUserVarlockDir(), 'local-encrypt');
const pidPath = path.join(socketDir, 'daemon.pid');
const socketPath = path.join(socketDir, 'daemon.sock');

if (!fs.existsSync(pidPath)) {
  console.log('No daemon PID file found, nothing to kill');
  process.exit(0);
}

const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
if (Number.isNaN(pid)) {
  console.log('Invalid PID file, cleaning up');
  fs.unlinkSync(pidPath);
  process.exit(0);
}

try {
  process.kill(pid, 'SIGTERM');
  console.log(`Killed daemon (PID ${pid})`);
} catch (err: any) {
  if (err.code === 'ESRCH') {
    console.log(`Daemon (PID ${pid}) was not running, cleaning up stale PID file`);
  } else {
    throw err;
  }
}

// Clean up PID and socket files
try {
  fs.unlinkSync(pidPath);
} catch { /* ignore */ }
try {
  fs.unlinkSync(socketPath);
} catch { /* ignore */ }
