import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';

/**
 * Find executable in PATH (simplified which implementation)
 */
export function findExecutable(command: string): string | null {
  // If it's an absolute or relative path, return as-is
  if (command.includes('/') || command.includes('\\')) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }

  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(process.platform === 'win32' ? ';' : ':');
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : [''];

  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const fullPath = join(dir, command + ext);
      try {
        accessSync(fullPath, constants.X_OK);
        return fullPath;
      } catch {
        // Continue to next path
      }
    }
  }

  return null;
}

export interface ExecOptions {
  env?: Record<string, string>;
  stdio?: 'inherit' | 'pipe';
  stdin?: 'inherit' | 'pipe';
  stdout?: 'inherit' | 'pipe';
  stderr?: 'inherit' | 'pipe';
}

export interface ExecResult extends Promise<ExecResult> {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  pid?: number;
  stdout?: any;
  stderr?: any;
  kill: (signal?: number | NodeJS.Signals) => boolean;
}

/**
 * Execute a command (simplified execa replacement)
 */
export function execCommand(
  command: string,
  args: Array<string>,
  options: ExecOptions = {},
): ExecResult {
  const stdio = options.stdio || 'pipe';

  let stdioConfig: [any, any, any];
  if (stdio === 'inherit') {
    stdioConfig = ['inherit', 'inherit', 'inherit'];
  } else {
    stdioConfig = [
      options.stdin || 'inherit',
      options.stdout || 'pipe',
      options.stderr || 'pipe',
    ];
  }

  const childProcess = spawn(command, args, {
    env: options.env || process.env,
    stdio: stdioConfig,
    shell: false,
  });

  const result = {
    exitCode: null as number | null,
    signal: null as NodeJS.Signals | null,
    pid: childProcess.pid,
    stdout: childProcess.stdout,
    stderr: childProcess.stderr,
    kill: (signal?: number | NodeJS.Signals) => childProcess.kill(signal),
  };

  // Create a promise that resolves when the process exits
  const exitPromise = new Promise<ExecResult>((resolve, reject) => {
    childProcess.on('exit', (code, signal) => {
      result.exitCode = code;
      result.signal = signal;

      if (code !== 0 && code !== null) {
        const error = new Error(`Command failed with exit code ${code}`) as any;
        error.exitCode = code;
        error.signal = signal;
        reject(error);
      } else if (signal) {
        const error = new Error(`Command was killed with signal ${signal}`) as any;
        error.exitCode = code;
        error.signal = signal;
        reject(error);
      } else {
        resolve(result as ExecResult);
      }
    });

    childProcess.on('error', (err) => {
      reject(err);
    });
  });

  // Make the result object thenable
  return Object.assign(exitPromise, result) as ExecResult;
}
