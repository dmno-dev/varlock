import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';

// weird tsup issue using `typeof execSync` from node:child_process
// see https://github.com/egoist/tsup/issues/1367
import type { execSync as execSyncType } from 'child_process';

const platform = os.platform();
const isWindows = platform.match(/^win/i);
const moduleDir = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
// Keep this URL static so serverless file tracers include the CLI entry.
const tracedPackageCliPath = fileURLToPath(new URL('./cli/cli-executable.js', import.meta.url));


/**
 * Walk up the directory tree from startDir looking for a node_modules/.bin/varlock binary.
 * Returns the full path to the binary if found, or null if not found.
 */
function findVarlockBin(startDir: string): string | null {
  // On Windows, npm creates varlock.exe while pnpm only creates varlock.cmd
  // (and a shell script). Check .exe first, then fall back to .cmd.
  const binNames = isWindows ? ['varlock.exe', 'varlock.cmd'] : ['varlock'];

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
 * Find the CLI entry inside the varlock package itself.
 * Serverless bundlers often omit node_modules/.bin, but they do include traced
 * package files. Running the package-local JS entry avoids depending on .bin.
 */
function findVarlockPackageCli(startDir: string): string | null {
  const checkedPaths = new Set<string>();

  function checkCliPath(cliPath: string) {
    if (checkedPaths.has(cliPath)) return null;
    checkedPaths.add(cliPath);
    return fs.existsSync(cliPath) ? cliPath : null;
  }

  const tracedCliPath = checkCliPath(tracedPackageCliPath);
  if (tracedCliPath) return tracedCliPath;

  let currentDir = startDir;
  while (currentDir) {
    for (const cliPath of [
      path.join(currentDir, 'cli', 'cli-executable.js'),
      path.join(currentDir, 'dist', 'cli', 'cli-executable.js'),
      path.join(currentDir, 'bin', 'cli.js'),
    ]) {
      const foundCliPath = checkCliPath(cliPath);
      if (foundCliPath) return foundCliPath;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return null;
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

type ExecSyncVarlockOpts = Parameters<typeof execSyncType>[1] & {
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
};

function getExecOpts(opts?: ExecSyncVarlockOpts): Parameters<typeof execSyncType>[1] {
  if (!opts) return undefined;
  const {
    callerDir: _callerDir,
    exitOnError: _exitOnError,
    showLogsOnError: _showLogsOnError,
    fullResult: _fullResult,
    ...execOpts
  } = opts;
  return execOpts;
}

function formatResult(result: Buffer | string, fullResult?: boolean) {
  return fullResult
    ? { stdout: result.toString(), stderr: '' }
    : result.toString();
}

/**
 * Small helper to call execSync and call the varlock cli.
 *
 * When the user runs via a package manager, it will inject node_modules/.bin into PATH
 * but otherwise we may need to try to find that path ourselves.
 *
 * @returns stdout as a string by default, or `{ stdout, stderr }` when `fullResult: true`
 */
export function execSyncVarlock(command: string, opts?: ExecSyncVarlockOpts & { fullResult?: false }): string;
export function execSyncVarlock(command: string, opts: ExecSyncVarlockOpts & { fullResult: true }): ExecVarlockResult;
export function execSyncVarlock(
  command: string,
  opts?: ExecSyncVarlockOpts,
): string | ExecVarlockResult {
  const execOpts = getExecOpts(opts);
  const commandArgs = command.split(' ');

  try {
    // in most cases, user will be running via their package manager
    // and a package.json script (ie `pnpm run start`)
    // which will inject node_modules/.bin into PATH
    try {
      const result = execSync(`varlock ${command}`, {
        ...execOpts,
        stdio: 'pipe',
      });
      return formatResult(result, opts?.fullResult);
    } catch (err) {
      // code 127 means not found (on linux only)
      // ENOENT from execSync means that a shell was not found
      if (!isWindows && (err as any).status !== 127 && (err as any).code !== 'ENOENT') throw err;
      // on windows, we'll just do the extra checks anyway
    }

    // if varlock was not found, it either means it is not installed
    // or we must find the path to node_modules/.bin ourselves.
    // Search from cwd (if provided), callerDir, then process.cwd().
    // This handles monorepo setups where cwd may be an unrelated workspace
    // root while varlock is only installed in a sub-package - the callerDir
    // supplied by auto-load.ts points inside that sub-package's node_modules.
    const cwdStr = opts?.cwd ? String(opts.cwd) : undefined;
    const searchDirs = [
      ...(cwdStr ? [cwdStr] : []),
      ...(opts?.callerDir ? [opts.callerDir] : []),
      moduleDir,
      process.cwd(),
    ];

    for (const startDir of searchDirs) {
      const varlockPath = findVarlockBin(startDir);
      if (varlockPath) {
        // .cmd files are batch scripts that must be run through cmd.exe
        const needsShell = varlockPath.endsWith('.cmd');
        const result = execFileSync(varlockPath, commandArgs, {
          ...execOpts,
          stdio: 'pipe',
          ...(needsShell && { shell: true }),
        });
        return formatResult(result, opts?.fullResult);
      }
    }

    for (const startDir of searchDirs) {
      const packageCliPath = findVarlockPackageCli(startDir);
      if (packageCliPath) {
        const result = execFileSync(process.execPath, [packageCliPath, ...commandArgs], {
          ...execOpts,
          stdio: 'pipe',
        });
        return formatResult(result, opts?.fullResult);
      }
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
