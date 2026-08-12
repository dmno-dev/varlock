import { gracefulExit } from 'exit-hook';

/**
 * Broken pipe (EPIPE) handling for the CLI's stdio streams.
 *
 * When a downstream consumer closes the pipe early (`varlock flatten | head -3`),
 * node emits an `error` event on process.stdout / process.stderr. Nothing listens
 * for it by default, so it becomes an unhandled `error` event and node crashes the
 * process with a stack trace. Conventional CLI behavior is to treat a closed pipe as
 * "the reader is done" and exit quietly instead.
 *
 * This also covers writes we don't control, like exit-hook's stdio flush. That helper
 * does attach a one-shot error listener around its write, but removes it again in the
 * write callback, and node emits the `error` event on a later tick - after the listener
 * is already gone.
 */

let isExiting = false;

function handleStreamError(err: NodeJS.ErrnoException, exitOnBrokenPipe: boolean) {
  // anything other than a broken pipe is a real error - rethrowing from the listener
  // surfaces it as an uncaught exception, same as if we were not listening at all
  if (err.code !== 'EPIPE') throw err;

  if (!exitOnBrokenPipe || isExiting) return;
  isExiting = true;
  // exit via the normal path so cleanup hooks still run (child processes, terminal state, ...)
  // the flush those hooks trigger will hit EPIPE again, which the guard above ignores
  gracefulExit(0);
}

/**
 * Swallow EPIPE on stdout/stderr so piping into a consumer that exits early
 * (`| head`, `| grep -q`, ...) ends the process cleanly rather than crashing.
 *
 * Call this as early as possible, before anything can write to stdio.
 */
export function handleBrokenPipe() {
  // a broken stdout means our output has nowhere left to go, so we stop
  process.stdout.on('error', (err) => handleStreamError(err, true));
  // a broken stderr only means logs/warnings are going nowhere, so we keep running
  process.stderr.on('error', (err) => handleStreamError(err, false));
}
