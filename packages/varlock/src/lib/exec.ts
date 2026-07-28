import { spawn, type ChildProcess } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { Readable } from 'node:stream';
import {
  join, delimiter, extname, isAbsolute,
} from 'node:path';
import {
  existsSync, statSync, openSync, readSync, closeSync, accessSync, constants as fsConstants,
} from 'node:fs';

interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'pipe' | [string, string, string];
  stdin?: 'inherit' | 'pipe';
  stdout?: 'inherit' | 'pipe';
  stderr?: 'inherit' | 'pipe';
  /**
   * Run the child in its own process group (POSIX `setsid`). Lets callers
   * forward signals to the whole group (`process.kill(-pid, sig)`) so that
   * grandchildren are terminated too. Ignored on Windows.
   */
  detached?: boolean;
}

/**
 * Convert a signal name into the conventional shell exit status (128 + signal number),
 * matching how shells report a process terminated by a signal.
 */
function signalExitCode(signal: NodeJS.Signals): number {
  const signalNumber = osConstants.signals[signal];
  return signalNumber ? 128 + signalNumber : 1;
}

export interface ExecResult {
  exitCode: number;
  signal?: NodeJS.Signals;
  stdout?: Readable;
  stderr?: Readable;
  pid?: number;
  kill: (signal?: number | NodeJS.Signals) => boolean;
}

/**
 * Get Windows executable extensions from PATHEXT or use defaults
 */
function getWindowsExtensions(): Array<string> {
  const pathExt = process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM';
  // Create both upper and lowercase variants
  const exts = pathExt.split(';').filter(Boolean);
  const result: Array<string> = [];
  for (const ext of exts) {
    result.push(ext.toUpperCase());
    result.push(ext.toLowerCase());
  }
  return result;
}

/**
 * Check if a path is executable (POSIX)
 */
function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    const stats = statSync(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Check if a file is executable on Windows (by extension)
 */
function isExecutableOnWindows(filePath: string): boolean {
  if (!existsSync(filePath)) return false;

  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return false;
  } catch {
    return false;
  }

  const ext = extname(filePath).toLowerCase();
  const extensions = getWindowsExtensions().map((e) => e.toLowerCase());
  return extensions.includes(ext);
}

/**
 * Read shebang from file (first 150 bytes only).
 *
 * Must not use readFileSync on the whole file: `varlock run -- node ...` resolves
 * bare `node` via PATH and probes candidates for a shebang. Reading a ~100MB+
 * Node binary into a UTF-8 string spikes the parent to hundreds of MiB and can
 * OOM 256Mi containers.
 */
function readShebang(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(150);
    const bytesRead = readSync(fd, buf, 0, 150, 0);
    const first150 = buf.toString('utf8', 0, bytesRead);
    const match = first150.match(/^#!([^\r\n]+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

/**
 * Find command in PATH with proper cross-platform support
 * Based on the `which` package logic
 */
function findCommand(command: string): string {
  const isWin = process.platform === 'win32';
  const hasPathSep = command.includes('/') || command.includes('\\');

  // If it's an absolute or relative path, use it directly
  if (isAbsolute(command) || hasPathSep) {
    return command;
  }

  // Get PATH with proper handling
  const pathEnv = process.env.PATH || '';

  // On Windows, prepend current directory to search paths
  const searchPaths: Array<string> = [];
  if (isWin) {
    searchPaths.push(process.cwd());
  }

  // Split PATH and handle quoted entries
  const pathParts = pathEnv.split(delimiter);
  for (const part of pathParts) {
    // Strip surrounding quotes from PATH entries
    const cleanPart = /^".*"$/.test(part) ? part.slice(1, -1) : part;
    if (cleanPart) {
      searchPaths.push(cleanPart);
    }
  }

  // Get extensions to try
  let extensions: Array<string> = [''];
  if (isWin) {
    extensions = getWindowsExtensions();
    // If command has a dot and PATHEXT is set, try without extension first
    if (command.includes('.') && process.env.PATHEXT) {
      extensions.unshift('');
    }
  }

  // Search in each path
  for (const dir of searchPaths) {
    for (const ext of extensions) {
      const fullPath = join(dir, command + ext);

      if (isWin) {
        if (isExecutableOnWindows(fullPath)) {
          return fullPath;
        }
      } else {
        if (isExecutable(fullPath)) {
          // Check for shebang on non-Windows
          const shebang = readShebang(fullPath);
          if (shebang && shebang.startsWith('/')) {
            // Has shebang, can execute directly
            return fullPath;
          } else if (!shebang) {
            // No shebang, assume it's a native executable
            return fullPath;
          }
        }
      }
    }
  }

  // If not found, return the command as-is and let spawn handle the error
  return command;
}

/**
 * Escape a string for use inside a double-quoted cmd.exe argument.
 * cmd.exe convention: a literal " is represented as "".
 */
function escapeCmdExeArg(str: string): string {
  return str.replace(/"/g, '""');
}


/**
 * Simple command executor that replaces execa
 * Uses Node.js child_process.spawn under the hood
 */
export function exec(
  command: string,
  args: Array<string>,
  options: ExecOptions = {},
): Promise<ExecResult> & {
  stdout?: Readable;
  stderr?: Readable;
  pid?: number;
  kill: (signal?: number | NodeJS.Signals) => boolean;
} {
  // Find command in PATH if it's not an absolute path
  const resolvedCommand = findCommand(command);

  // Detect whether findCommand found a different path for the command.
  // Absolute/relative paths (containing a path separator) are always used as-is
  // (findCommand returns them unchanged), so we treat those as "found" too.
  const isCommandFound = resolvedCommand !== command
    || isAbsolute(command)
    || command.includes('/')
    || command.includes('\\');

  // On Windows, .cmd/.bat files must go through cmd.exe.
  // Also fall back to cmd.exe when the command wasn't found in PATH, so that
  // cmd.exe can handle PATHEXT lookups (e.g. tsx → tsx.cmd, pnpm → pnpm.cmd).
  const needsShell = process.platform === 'win32'
    && (/\.(cmd|bat)$/i.test(resolvedCommand) || !isCommandFound);

  let spawnCommand = resolvedCommand;
  let spawnArgs = args;
  const spawnOptions: any = {
    env: options.env || process.env,
    shell: false,
    // process groups are a POSIX concept; on Windows we forward to the child pid directly
    detached: options.detached === true && process.platform !== 'win32',
  };

  // On Windows, wrap .cmd/.bat (or unresolved commands) in cmd.exe
  if (needsShell) {
    // Use the resolved path when available; otherwise let cmd.exe handle the
    // PATHEXT lookup by passing the original bare command name.
    const cmdToUse = isCommandFound ? resolvedCommand : command;
    // Always quote the command path to handle spaces and special characters.
    // Escape any embedded double-quotes as "" (cmd.exe convention).
    const quotedCmd = `"${escapeCmdExeArg(cmdToUse)}"`;
    // Build the inner string: quote every argument and escape embedded double-quotes,
    // then join with the command. Wrap the whole thing in one outer pair of quotes.
    // cmd.exe /s /c strips the first and last " from the command string, so the outer
    // quotes are consumed and the quoted inner content is processed correctly.
    const cmdStr = [quotedCmd, ...args.map((a) => `"${escapeCmdExeArg(a)}"`)]
      .join(' ');
    spawnArgs = ['/d', '/s', '/c', `"${cmdStr}"`];
    spawnCommand = process.env.comspec || 'cmd.exe';
    spawnOptions.windowsVerbatimArguments = true;
  }

  // Normalize stdio options
  let stdio: 'inherit' | ['inherit' | 'pipe', 'inherit' | 'pipe', 'inherit' | 'pipe'];
  if (options.stdio === 'inherit') {
    stdio = 'inherit';
  } else if (options.stdio === 'pipe') {
    stdio = ['pipe', 'pipe', 'pipe'];
  } else if (options.stdio) {
    stdio = options.stdio as ['inherit' | 'pipe', 'inherit' | 'pipe', 'inherit' | 'pipe'];
  } else {
    // Default based on individual stdin/stdout/stderr
    stdio = [
      options.stdin || 'inherit',
      options.stdout || 'inherit',
      options.stderr || 'inherit',
    ] as ['inherit' | 'pipe', 'inherit' | 'pipe', 'inherit' | 'pipe'];
  }

  spawnOptions.stdio = stdio;

  const childProcess: ChildProcess = spawn(spawnCommand, spawnArgs, spawnOptions);

  const result: Partial<ExecResult> = {
    stdout: childProcess.stdout || undefined,
    stderr: childProcess.stderr || undefined,
    pid: childProcess.pid,
    kill: (signal?: number | NodeJS.Signals) => childProcess.kill(signal),
  };

  const promise = new Promise<ExecResult>((resolve, reject) => {
    let errorEmitted = false;

    childProcess.on('error', (error) => {
      errorEmitted = true;
      reject(
        Object.assign(error, {
          exitCode: 1,
          ...result,
        }),
      );
    });

    childProcess.on('exit', (code, signal) => {
      // Windows special case: exit code 1 without error event might be ENOENT
      if (process.platform === 'win32' && code === 1 && !errorEmitted && !existsSync(resolvedCommand)) {
        const error: any = new Error(`Command not found: ${command}`);
        error.code = 'ENOENT';
        error.exitCode = 1;
        Object.assign(error, result);
        reject(error);
        return;
      }

      // a process killed by a signal has a null exit code; report it as 128+N like a shell does
      const exitCode = code ?? (signal ? signalExitCode(signal) : 0);
      const exitResult: ExecResult = {
        exitCode,
        signal: signal || undefined,
        ...result,
      } as ExecResult;

      if (exitCode !== 0) {
        const error: any = new Error(`Command failed with exit code ${exitCode}`);
        error.exitCode = exitCode;
        error.signal = signal;
        Object.assign(error, result);
        reject(error);
      } else {
        resolve(exitResult);
      }
    });
  }) as Promise<ExecResult> & Partial<ExecResult> & { kill: (signal?: number | NodeJS.Signals) => boolean };

  // Attach stream properties and methods to the promise
  Object.assign(promise, result);

  return promise as Promise<ExecResult> & {
    stdout?: Readable;
    stderr?: Readable;
    pid?: number;
    kill: (signal?: number | NodeJS.Signals) => boolean;
  };
}
