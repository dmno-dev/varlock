import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { isBunRuntime, isBunStandaloneExecutable } from './detect-runtime';
import { CLI_CHILD_MARKER } from './cli-child-marker';
import { warnIfNoConfigLoaded } from './empty-config-check';

const isWindows = () => /^win/i.test(os.platform());


/**
 * Walk up the directory tree from startDir looking for a node_modules/.bin/varlock binary.
 * Returns the full path to the binary if found, or null if not found.
 *
 * The walk stops after the git repository root (the first directory containing `.git`),
 * so a stray install above the project (e.g. an accidental `npm i varlock` in $HOME)
 * cannot shadow a standalone binary on PATH. Outside a git checkout (e.g. inside a
 * container image) the walk continues to the filesystem root as before.
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
    // `.git` is a directory in a normal checkout and a file in worktrees/submodules
    if (fs.existsSync(path.join(currentDir, '.git'))) break;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return null;
}

/**
 * Whether `process.execPath` can run a JS file given as its first argument, like `node cli.js`.
 * Electron's execPath launches the app itself and Deno needs `deno run`, so those use the shim.
 */
function execPathRunsScripts(): boolean {
  if (isBunRuntime()) return !isBunStandaloneExecutable();
  return process.versions?.node != null
    && process.versions.electron == null
    && (globalThis as typeof globalThis & { Deno?: unknown }).Deno == null;
}

/**
 * Find the JS entry point behind a `node_modules/.bin/varlock` shim, so it can be run with
 * the current Bun runtime instead of the `#!/usr/bin/env node` shebang.
 * npm/bun/yarn create a symlink to the script; pnpm creates a shell wrapper and Windows
 * installs create .exe/.cmd shims, so we also check the package next to the .bin dir.
 */
function findVarlockCliScript(binPath: string): string | null {
  try {
    const realPath = fs.realpathSync(binPath);
    if (/\.[cm]?js$/.test(realPath)) return realPath;
  } catch {
    // fall through to the package lookup
  }
  const pkgCliPath = path.join(path.dirname(binPath), '..', 'varlock', 'bin', 'cli.js');
  return fs.existsSync(pkgCliPath) ? pkgCliPath : null;
}


/** Error thrown by `execSyncVarlock` when the CLI exits with a non-zero status code and `fullResult` is enabled. */
export class VarlockExecError extends Error {
  constructor(
    message: string,
    public stdout: string,
    public stderr: string,
    public exitCode: number,
    public signal: NodeJS.Signals | null = null,
    public code?: string,
  ) {
    super(message);
  }

  get crashed(): boolean {
    // Windows NTSTATUS failures may be reported as signed or unsigned 32-bit integers.
    // eslint-disable-next-line no-bitwise
    return this.signal != null || (this.exitCode >>> 0) >= 0xC0000000;
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
  // Tag the child as a varlock CLI process so that a preloaded `varlock/auto-load` inside it
  // (bunfig `preload`, with bun standing in for `node`) does not spawn yet another CLI.
  // The CLI strips this from its own env on startup. See lib/cli-child-marker.ts.
  merged[CLI_CHILD_MARKER] = '1';
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
/**
 * Callers of `load --format json-full` (auto-load and every framework integration) discard the
 * CLI's stderr on success, so the CLI's own "no .env files" message never reaches the user.
 * Warn here, in the one place they all share.
 */
function successResult(command: string, stdout: string, opts?: ExecSyncVarlockOpts) {
  if (command.startsWith('load ') && command.includes('--format json-full')) {
    try {
      warnIfNoConfigLoaded(JSON.parse(stdout));
    } catch {
      // unparseable output is the caller's problem to report
    }
  }
  return opts?.fullResult ? { stdout, stderr: '' } : stdout;
}

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
  let executedCommand = `varlock ${command}`;
  try {
    // Prefer the CLI installed alongside the imported library so both are the same version.
    // Search from cwd (if provided), callerDir, then process.cwd().
    // This handles monorepo setups where cwd may be an unrelated workspace
    // root while varlock is only installed in a sub-package - the callerDir
    // supplied by auto-load.ts points inside that sub-package's node_modules.
    // Bun-compiled executables are the exception: callerDir points into Bun's
    // virtual /$bunfs filesystem, while process.execPath points at the real
    // executable inside the workspace.
    // `opts.cwd` may be relative (e.g. wrangler's `--cwd nested` passed straight through).
    // Resolve it first: the walk-up must start from a real directory, and the bin path it
    // returns is later executed with `cwd` set to that same directory, so a relative bin
    // path found from the parent would resolve against the wrong directory (ENOENT).
    const cwdStr = opts?.cwd ? path.resolve(String(opts.cwd)) : undefined;
    const searchDirs = [
      ...(cwdStr ? [cwdStr] : []),
      ...(opts?.callerDir ? [opts.callerDir] : []),
      ...(isBunStandaloneExecutable() ? [path.dirname(process.execPath)] : []),
      process.cwd(),
    ];

    for (const startDir of searchDirs) {
      const varlockPath = findVarlockBin(startDir);
      if (varlockPath) {
        // Run the CLI script directly for Bun compatibility and to avoid shell:true for .cmd shims.
        const canRunCliScript = execPathRunsScripts()
          && (isBunRuntime() || varlockPath.endsWith('.cmd'));
        const cliScript = canRunCliScript
          ? findVarlockCliScript(varlockPath)
          : null;
        const execOpts = {
          ...childProcessOpts,
          env: execEnv,
          stdio: 'pipe' as const,
        };
        // A .cmd shim needs cmd.exe, but execFileSync with args and shell:true is deprecated
        // because Node concatenates the arguments without escaping them.
        const executable = cliScript ? process.execPath : varlockPath;
        const args = [...(cliScript ? [cliScript] : []), ...command.split(' ')];
        executedCommand = [executable, ...args].map((arg) => JSON.stringify(arg)).join(' ');
        const result = varlockPath.endsWith('.cmd') && !cliScript
          ? execSync(`"${varlockPath}" ${command}`, execOpts)
          : execFileSync(
            executable,
            args,
            execOpts,
          );
        return successResult(command, result.toString(), opts);
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
      return successResult(command, result.toString(), opts);
    } catch (err) {
      // sh exits 127 when the command is not found; ENOENT means the shell itself is missing.
      // cmd.exe exits 1 for both "not found" and a real CLI failure, and its message is
      // localized, so on Windows a missing varlock surfaces as the raw shell error instead.
      const errAny = err as any;
      if (errAny.status === 127 || errAny.code === 'ENOENT') {
        throw new Error('Unable to find varlock executable');
      }
      throw err;
    }
  } catch (err) {
    // In fullResult mode, wrap the error as VarlockExecError with structured fields
    if (opts?.fullResult) {
      if (err instanceof VarlockExecError) throw err; // already wrapped
      const errAny = err as any;
      // execSync/execFileSync attach stdout/stderr Buffers on the error
      if (errAny.status != null || errAny.signal != null) {
        const execError = new VarlockExecError(
          '',
          errAny.stdout?.toString() ?? '',
          errAny.stderr?.toString() ?? '',
          errAny.status ?? 1,
          errAny.signal ?? null,
          errAny.code,
        );
        const status = execError.signal
          ? `signal ${execError.signal}`
          // eslint-disable-next-line no-bitwise
          : `exit code ${execError.crashed ? `0x${(execError.exitCode >>> 0).toString(16).toUpperCase()}` : execError.exitCode}`;
        let failure = 'the varlock CLI crashed';
        if (execError.code === 'ENOBUFS') failure = 'the varlock CLI exceeded the captured output buffer limit (ENOBUFS)';
        if (execError.code === 'ETIMEDOUT') failure = 'the varlock CLI timed out (ETIMEDOUT)';
        execError.message = execError.crashed
          ? `varlock env resolution failed: ${failure} (${status}).\n[varlock] Command: ${executedCommand}\n[varlock] Run "varlock load" manually to see the underlying error.`
          : `${executedCommand} failed (${status})`;
        throw execError;
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
