import { spawn, exec, SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';

export class ExecError extends Error {
  constructor(
    readonly exitCode: number,
    readonly signal: NodeJS.Signals | null,
    readonly data: string = 'command gave no output',
  ) {
    super(data);
  }
}

export function spawnAsyncHelper(
  command: string,
  args: Array<string>,
  spawnOptions?: SpawnOptions,
) {
  const childProcess = spawn(command, args, spawnOptions || {});

  const deferred = new Promise((resolve, reject) => {
    let stdoutData: string = '';
    let stderrData: string = '';
    childProcess.stdout?.on('data', (data) => {
      stdoutData += data.toString();
    });
    childProcess.stderr?.on('data', (data) => {
      stderrData += data.toString();
    });
    childProcess.stdout?.on('error', (err) => {
      reject(err);
    });
    childProcess.stderr?.on('error', (err) => {
      reject(err);
    });
    childProcess.on('error', (err) => {
      reject(err);
    });
    childProcess.on('exit', (exitCode, signal) => {
      if (!exitCode) {
        resolve(stdoutData);
      } else {
        reject(
          new ExecError(exitCode, signal, stderrData),
        );
      }
    });
  });

  return { childProcess, execResult: deferred };
}

export async function spawnAsync(
  command: string,
  args: Array<string>,
  opts?: SpawnOptions,
) {
  const { execResult } = spawnAsyncHelper(command, args, opts);
  return execResult;
}


export const asyncExec = promisify(exec);
