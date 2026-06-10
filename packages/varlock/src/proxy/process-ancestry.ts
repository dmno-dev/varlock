import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Walk a process's parent-PID chain. Used to detect whether the current process
 * is running inside a `varlock proxy run` session's process tree — a signal a
 * child can't forge by clearing an inherited env var (it would have to
 * daemonize/reparent to escape, a much higher bar).
 *
 * Linux reads /proc/<pid>/stat per level (sub-ms). Other POSIX platforms take a
 * single `ps` snapshot of all pid/ppid pairs and walk it in memory, so depth
 * costs one subprocess regardless of how deep the chain is.
 */

function getParentPidViaProc(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The comm field (2nd) is wrapped in parens and may contain spaces/parens,
    // so parse after the final ')'. Remaining fields: state ppid pgrp ...
    const after = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = after.split(' ');
    const ppid = Number(fields[1]);
    return Number.isFinite(ppid) ? ppid : undefined;
  } catch {
    return undefined;
  }
}

function buildPpidMapViaPs(): Map<number, number> {
  const map = new Map<number, number>();
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      if (Number.isFinite(pid) && Number.isFinite(ppid)) map.set(pid, ppid);
    }
  } catch {
    // ps unavailable — return what we have (empty); callers degrade gracefully.
  }
  return map;
}

/** Returns the ancestor PIDs of `startPid` (nearest first), excluding itself. */
export function getAncestorPids(startPid: number = process.pid, maxDepth = 40): Array<number> {
  const ancestors: Array<number> = [];
  const isLinux = process.platform === 'linux';
  const ppidMap = isLinux ? undefined : buildPpidMapViaPs();

  let current = startPid;
  const seen = new Set<number>([startPid]);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const parent = isLinux ? getParentPidViaProc(current) : ppidMap!.get(current);
    if (parent === undefined || parent <= 0 || seen.has(parent)) break;
    ancestors.push(parent);
    seen.add(parent);
    if (parent === 1) break;
    current = parent;
  }
  return ancestors;
}
