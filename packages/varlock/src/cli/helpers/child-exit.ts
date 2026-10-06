/**
 * Report a failure from a child command spawned by `varlock run` / `varlock proxy run`,
 * and return the exit code varlock should exit with.
 *
 * A child that ran and exited non-zero has already explained itself (or chose not to), so
 * we stay silent and only propagate its status. Only a failure to start the child at all
 * (missing executable, permission denied, ...) is reported, and always on stderr: stdout
 * belongs to the child and may be parsed by whatever wraps us.
 */
export function reportChildCommandError(error: unknown, commandStr: string): number {
  const err = error as NodeJS.ErrnoException & { exitCode?: number };
  // spawn errors carry a string `code` (ENOENT, EACCES, ...); a non-zero exit does not
  if (typeof err?.code !== 'string') return err?.exitCode || 1;

  // `path` is what was actually spawned (may be a sandbox wrapper rather than the user's command)
  const executable = (err as { path?: string }).path || commandStr.split(' ')[0];
  if (err.code === 'ENOENT') {
    console.error(`varlock: command not found: ${executable}`);
    return 127;
  }
  if (err.code === 'EACCES') {
    console.error(`varlock: permission denied: ${executable}`);
    return 126;
  }
  console.error(`varlock: failed to start command [${commandStr}]: ${err.message}`);
  return 1;
}
