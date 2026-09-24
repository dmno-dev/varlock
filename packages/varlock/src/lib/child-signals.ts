import { openSync, closeSync } from 'node:fs';

/**
 * Signals we forward to a long-running child so it can shut down gracefully: the
 * terminating signals an orchestrator (docker stop, k8s, a shell) would send.
 */
export const FORWARDED_SIGNALS: Array<NodeJS.Signals> = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];

/**
 * By default we forward-and-wait (like tini/dumb-init) and never impose our own kill
 * deadline: the orchestrator/operator owns SIGKILL, and a timer would wrongly assume every
 * forwarded signal is terminal (SIGHUP often means "reload") and could truncate a
 * legitimately slow graceful shutdown. Opt in by setting _VARLOCK_FORCE_KILL_TIMEOUT_MS to
 * a number of milliseconds to escalate to SIGKILL that long after the first signal.
 */
function getForceKillTimeoutMs(): number | undefined {
  const raw = process.env._VARLOCK_FORCE_KILL_TIMEOUT_MS;
  if (raw === undefined) return undefined;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * Whether this process is part of a terminal session, i.e. has a controlling terminal.
 *
 * We can't just check `isTTY` on the std streams: a process can keep its controlling
 * terminal while its std fds are pipes (e.g. a task runner like turbo running
 * interactively but piping a task's output instead of giving it a PTY). The daemon's
 * session scoping keys off the controlling terminal (`e_tdev`), not fd tty-ness, so we
 * use the canonical POSIX probe (`/dev/tty` opens iff a controlling terminal exists)
 * with the std-stream check as a fast path.
 */
export function hasControllingTerminal(): boolean {
  if (process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY) return true;
  if (process.platform === 'win32') return false; // no /dev/tty; we never setsid on Windows anyway
  try {
    const fd = openSync('/dev/tty', 'r');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make `keep` the ONLY listeners for `signals`, removing any other listener that was
 * registered earlier.
 *
 * Libraries loaded before a command runs register their own signal listeners. Notably
 * `exit-hook` (used by the telemetry module) installs SIGINT/SIGTERM listeners that run
 * its hooks and then `process.exit(128+N)`. Left in place alongside a handler that wants
 * to forward the signal and wait (or run a bounded cleanup), such a listener ends the
 * process within its short hook window, cutting the child or the cleanup off. Their exit
 * hooks still run when the command finishes via gracefulExit().
 */
export function claimSignals(signals: Array<NodeJS.Signals>, keep: (...args: Array<any>) => void) {
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (listener !== keep) process.removeListener(signal, listener);
    }
  }
}

interface ChildLike {
  pid?: number;
  kill: (signal?: number | NodeJS.Signals) => boolean;
}

export interface ChildSignalForwarder {
  /**
   * Whether the child should be spawned in its own process group (`detached: true`).
   * True only when there is no controlling terminal (containers, CI, agents); see
   * `createChildSignalForwarder` for why.
   */
  useProcessGroup: boolean;
  /**
   * Call right after spawning the child. A signal that arrived between creation and
   * attach is forwarded now, so an `await` in that window can't drop it. Idempotent.
   */
  attach(child: ChildLike): void;
  /** Call once the child has exited and been reaped, so we never signal a recycled pid. */
  detach(): void;
}

/**
 * Forward terminating signals to a child and wait for it, instead of letting varlock
 * die out from under it. Create this BEFORE spawning the child:
 *
 *  (a) it closes the window where a signal arriving between spawn and registration
 *      would kill varlock without forwarding, and
 *  (b) varlock then holds a real handler for these signals at fork time, so the child
 *      inherits the default disposition (SIG_DFL) rather than an inherited "ignored"
 *      state; otherwise the child can't react to a forwarded signal.
 *
 * When the child lives in its own process group we signal the whole group (negative
 * pid) so grandchildren are terminated too; otherwise we signal the child pid directly.
 * We only detach the child (`useProcessGroup`) when there is NO controlling terminal:
 *  - No-terminal context (containers, CI, agents): setsid changes neither env vars nor
 *    parent PIDs, and there's no controlling terminal to lose, so the daemon's
 *    peer/session scoping (env-anchored for agents, or process-tree) is unaffected.
 *  - Terminal context: we stay in the shared group, preserving the child's controlling
 *    terminal, which interactive tools (psql, vim, claude), /dev/tty access, SIGWINCH,
 *    and the enclave's tty-based session scoping of any nested varlock all need (incl.
 *    fan-out runners like turbo whose per-task PTYs we must not sever).
 *
 * A last-resort `exit` handler SIGKILLs the child if varlock exits while it is somehow
 * still alive (e.g. an unexpected error in varlock itself). After `detach()` that is a
 * no-op, so a clean run never blasts SIGKILL at a reaped (possibly recycled) group.
 */
export function createChildSignalForwarder(): ChildSignalForwarder {
  const useProcessGroup = !hasControllingTerminal() && process.platform !== 'win32';
  const forceKillTimeoutMs = getForceKillTimeoutMs();

  let child: ChildLike | undefined;
  let childExited = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  // signals received before attach(); replayed once we know the child
  const pendingSignals: Array<NodeJS.Signals> = [];

  const signalChild = (signal: NodeJS.Signals | number) => {
    if (childExited || !child?.pid) return;
    try {
      if (useProcessGroup) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      // child (or its group) is already gone, nothing to forward to
    }
  };

  process.on('exit', () => {
    signalChild('SIGKILL');
  });

  FORWARDED_SIGNALS.forEach((signal) => {
    const forwardSignal = () => {
      if (!child) {
        pendingSignals.push(signal);
        return;
      }
      signalChild(signal);
      // opt-in only: escalate to SIGKILL if the child hasn't exited in time
      if (forceKillTimeoutMs !== undefined && !forceKillTimer) {
        forceKillTimer = setTimeout(() => signalChild('SIGKILL'), forceKillTimeoutMs);
        // don't let the fallback timer keep the process alive on its own
        forceKillTimer.unref();
      }
    };
    try {
      process.on(signal, forwardSignal);
    } catch {
      // some signals (e.g. SIGQUIT) can't be listened for on every platform; skip those
      return;
    }
    // while a child is running, ours must be the only listener (see claimSignals)
    claimSignals([signal], forwardSignal);
  });

  return {
    useProcessGroup,
    attach(c) {
      if (child) return;
      child = c;
      for (const signal of pendingSignals.splice(0)) {
        process.emit(signal, signal);
      }
    },
    detach() {
      childExited = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
    },
  };
}
