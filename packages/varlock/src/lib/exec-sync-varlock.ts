import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { isBunStandaloneExecutable } from './detect-runtime';

// evaluated per call so tests can simulate other platforms
const isWindows = () => /^win/i.test(os.platform());


/**
 * Walk up the directory tree from startDir looking for a node_modules/.bin/varlock binary.
 * Returns the full path to the binary if found, or null if not found.
 */
function findVarlockBin(startDir: string): string | null {
  // On Windows, npm creates varlock.exe while pnpm only creates varlock.cmd
  // (and a shell script). Check .exe first, then fall back to .cmd.
  const binNames = isWindows() ? ['varlock.exe', 'varlock.cmd'] : ['varlock'];

  let currentDir = startDir;
  while (currentDir) {
    const possibleBinPath = path.join(currentDir, 'node_modules', '.bin');
    if (fs.existsSync(possibleBinPath)) {
      for (const binName of binNames) {
        const possibleVarlockPath = path.join(possibleBinPath, binName);
        if (fs.existsSync(possibleVarlockPath)) {
          return possibleVarlockPath;
        }
      }
      // Found a .bin directory but varlock is not in it - keep walking up.
      // In a monorepo the root node_modules/.bin may exist without varlock,
      // which is installed only in a sub-package.
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return null;
}


/**
 * Whether a failed shell `varlock ...` invocation means the command was not on PATH,
 * as opposed to varlock running and exiting non-zero.
 * - sh exits 127 when the command is not found
 * - the shell itself missing surfaces as ENOENT
 * - cmd.exe exits 1 (not 9009, which is only the in-shell ERRORLEVEL) and prints
 *   "'varlock' is not recognized as an internal or external command" to stderr.
 *   A real varlock failure also exits 1, so on Windows we key off that message.
 */
function isShellCommandNotFound(err: unknown): boolean {
  const errAny = err as any;
  if (errAny?.status === 127 || errAny?.code === 'ENOENT') return true;
  if (isWindows()) {
    const stderr = errAny?.stderr?.toString() ?? '';
    if (/is not recognized as an internal or external command/i.test(stderr)) return true;
  }
  return false;
}


/** Error thrown by `execSyncVarlock` when the CLI exits with a non-zero status code and `fullResult` is enabled. */
export class VarlockExecError extends Error {
  constructor(
    message: string,
    public stdout: string,
    public stderr: string,
    public exitCode: number,
  ) {
    super(message);
  }
}

export type ExecVarlockResult = { stdout: string, stderr: string };

export function integrationTelemetryEnv(name: string, version: string) {
  return { __VARLOCK_INTEGRATION: `${name}@${version}` };
}

function mergeExecEnv(
  opts?: ExecSyncVarlockOpts,
): NodeJS.ProcessEnv {
  const baseEnv = opts?.env ?? process.env;

  const merged = { ...baseEnv } as NodeJS.ProcessEnv;
  // NODE_OPTIONS is meant for the parent app's node process, not the varlock CLI child.
  // A preloaded module (e.g. NODE_OPTIONS="-r next-logger") can write to stdout and
  // corrupt the JSON the CLI emits over stdio, crashing auto-load / integrations.
  // Windows matches env keys case-insensitively, so casing variants must go too.
  for (const key of Object.keys(merged)) {
    if (key.toUpperCase() === 'NODE_OPTIONS') delete merged[key];
  }
  if (opts?.integrationTelemetry) {
    // __VARLOCK_INTEGRATION is for our internal use only — the integration-provided
    // identity is authoritative and always wins over any inherited/user-set value.
    Object.assign(
      merged,
      integrationTelemetryEnv(opts.integrationTelemetry.name, opts.integrationTelemetry.version),
    );
  }
  return merged;
}

type ExecSyncVarlockOpts = Parameters<typeof execSync>[1] & {
  exitOnError?: boolean,
  showLogsOnError?: boolean,
  /**
   * Additional directory to start searching for the varlock binary from.
   * Searched before process.cwd(). Pass `import.meta.dirname` from the
   * call-site so that in monorepos the binary installed next to the
   * importing package is found even when cwd is an unrelated workspace root.
   */
  callerDir?: string,
  /**
   * When true, return `{ stdout, stderr }` instead of just the stdout string,
   * and throw `VarlockExecError` (with `.stdout`, `.stderr`, `.exitCode`) on failure
   * instead of the raw execSync error.
   */
  fullResult?: boolean,
  /** Identifies the framework integration invoking varlock (passed as __VARLOCK_INTEGRATION) */
  integrationTelemetry?: { name: string, version: string },
};

/**
 * Small helper to run the varlock CLI synchronously.
 *
 * The CLI must come from the same install as the library that is calling it, otherwise the
 * runtime and the CLI can be different versions and disagree about resolution behavior
 * (e.g. a global CLI silently ignoring a feature the imported runtime relies on).
 * So we always look for a local `node_modules/.bin/varlock` first, walking up from
 * `opts.cwd`, then `opts.callerDir` (the importing module's directory, passed by auto-load),
 * then the directory of a Bun standalone executable, then `process.cwd()`.
 *
 * Only if no local install is found do we fall back to a shell `varlock ...` PATH lookup,
 * which keeps the standalone-binary / global-only case working (no npm install at all).
 *
 * @returns stdout as a string by default, or `{ stdout, stderr }` when `fullResult: true`
 */
export function execSyncVarlock(command: string, opts?: ExecSyncVarlockOpts & { fullResult?: false }): string;
export function execSyncVarlock(command: string, opts: ExecSyncVarlockOpts & { fullResult: true }): ExecVarlockResult;
export function execSyncVarlock(
  command: string,
  opts?: ExecSyncVarlockOpts,
): string | ExecVarlockResult {
  const execEnv = mergeExecEnv(opts);
  const {
    exitOnError: _exitOnError,
    showLogsOnError: _showLogsOnError,
    callerDir: _callerDir,
    fullResult: _fullResult,
    integrationTelemetry: _integrationTelemetry,
    ...childProcessOpts
  } = opts ?? {};
  try {
    // Prefer the CLI installed alongside the imported library so both are the same version.
    // Search from cwd (if provided), callerDir, then process.cwd().
    // This handles monorepo setups where cwd may be an unrelated workspace
    // root while varlock is only installed in a sub-package - the callerDir
    // supplied by auto-load.ts points inside that sub-package's node_modules.
    // Bun-compiled executables are the exception: callerDir points into Bun's
    // virtual /$bunfs filesystem, while process.execPath points at the real
    // executable inside the workspace.
    const cwdStr = opts?.cwd ? String(opts.cwd) : undefined;
    const searchDirs = [
      ...(cwdStr ? [cwdStr] : []),
      ...(opts?.callerDir ? [opts.callerDir] : []),
      ...(isBunStandaloneExecutable() ? [path.dirname(process.execPath)] : []),
      process.cwd(),
    ];

    for (const startDir of searchDirs) {
      const varlockPath = findVarlockBin(startDir);
      if (varlockPath) {
        // .cmd files are batch scripts that must be run through cmd.exe
        const needsShell = varlockPath.endsWith('.cmd');
        const result = execFileSync(varlockPath, command.split(' '), {
          ...childProcessOpts,
          env: execEnv,
          stdio: 'pipe',
          ...(needsShell && { shell: true }),
        });
        return opts?.fullResult
          ? { stdout: result.toString(), stderr: '' }
          : result.toString();
      }
    }

    // No local install found. Fall back to whatever `varlock` is on PATH, which covers
    // users of the standalone binary or a global install with no npm install of varlock.
    try {
      const result = execSync(`varlock ${command}`, {
        env: execEnv,
        ...opts?.cwd && { cwd: opts.cwd },
        stdio: 'pipe',
      });
      return opts?.fullResult
        ? { stdout: result.toString(), stderr: '' }
        : result.toString();
    } catch (err) {
      // The CLI ran but failed: surface its real error rather than "not found".
      if (!isShellCommandNotFound(err)) throw err;
    }
    throw new Error('Unable to find varlock executable');
  } catch (err) {
    // In fullResult mode, wrap the error as VarlockExecError with structured fields
    if (opts?.fullResult) {
      if (err instanceof VarlockExecError) throw err; // already wrapped
      const errAny = err as any;
      // execSync/execFileSync attach stdout/stderr Buffers on the error
      if (errAny.status != null) {
        throw new VarlockExecError(
          `varlock ${command} failed (exit code ${errAny.status})`,
          errAny.stdout?.toString() ?? '',
          errAny.stderr?.toString() ?? '',
          errAny.status ?? 1,
        );
      }
      throw err; // not a process error (e.g. "Unable to find varlock executable")
    }

    // Legacy behavior for non-fullResult callers
    const errAny = err as any;
    if (opts?.showLogsOnError) {
      /* eslint-disable no-console */
      if (errAny.stdout) console.log(errAny.stdout.toString());
      if (errAny.stderr) console.error(errAny.stderr.toString());

      if (!errAny.stdout && !errAny.stderr) {
        console.error(errAny);
      }
    }
    if (opts?.exitOnError) {
      process.exit((err as any).status ?? 1);
    }
    throw err;
  }
}
