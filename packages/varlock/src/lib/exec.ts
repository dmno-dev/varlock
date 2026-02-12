import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import {
  join, delimiter, extname, isAbsolute,
} from 'node:path';
import {
  existsSync, statSync, readFileSync, accessSync, constants as fsConstants,
} from 'node:fs';

interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'pipe' | [string, string, string];
  stdin?: 'inherit' | 'pipe';
  stdout?: 'inherit' | 'pipe';
  stderr?: 'inherit' | 'pipe';
}

interface ExecResult {
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
 * Read shebang from file (first 150 bytes)
 */
function readShebang(filePath: string): string | null {
  try {
    const fd = readFileSync(filePath, { encoding: 'utf8', flag: 'r' });
    const first150 = fd.slice(0, 150);
    const match = first150.match(/^#!([^\r\n]+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
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

  // Check if we need shell on Windows for .cmd/.bat files
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedCommand);

  let spawnCommand = resolvedCommand;
  let spawnArgs = args;
  const spawnOptions: any = {
    env: options.env || process.env,
    shell: false,
  };

  // On Windows, wrap .cmd/.bat in cmd.exe
  if (needsShell) {
    spawnArgs = ['/d', '/s', '/c', `"${resolvedCommand}" ${args.map((a) => `"${a}"`).join(' ')}`];
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

      const exitCode = code ?? (signal ? 1 : 0);
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
