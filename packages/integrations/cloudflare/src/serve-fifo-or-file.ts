import { execSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const isWindows = process.platform === 'win32';

export type FifoServeHandle = {
  stop(): void;
  /** Child process pid when serving via FIFO (Unix). */
  pid?: number;
};

/**
 * Serves `content` at `filePath` for reading by miniflare.
 * On Unix: uses a FIFO (named pipe) so secrets never touch disk.
 * On Windows: falls back to a regular temp file.
 *
 * The FIFO child process writes to the pipe in a loop. Each sync read by
 * wrangler/miniflare gets the content, and the child immediately starts
 * the next write so subsequent reads also work. The loop must live in the
 * child: wrangler's blocking sync read freezes the parent's event loop,
 * so a parent-side re-arm would deadlock.
 *
 * Content is passed on stdin (not argv) so secrets never appear in
 * ps /proc cmdline listings. A control fd signals when the child has buffered
 * the payload and is about to open the FIFO, avoiding the deadlock that would
 * occur if the parent blocked on a sync FIFO read before stdin was flushed.
 */
export async function serveFifoOrFile(
  filePath: string,
  content: string,
): Promise<FifoServeHandle> {
  if (isWindows) {
    writeFileSync(filePath, content);
    return {
      stop() {
        /* noop on Windows */
      },
    };
  }

  execSync(`mkfifo -m 0600 "${filePath}"`);
  const parentPid = process.pid;
  // Spawn a child that buffers content from stdin, signals ready on fd 3,
  // then writes to the FIFO in a loop. Same stdin + control-fd pattern as
  // varlock-wrangler spawnWriter: keeps secrets out of argv while still
  // avoiding the readFileSync / stdin-flush deadlock.
  const fifoProcess = spawn(process.execPath, [
    '-e', `
      const fs = require('fs');
      const path = ${JSON.stringify(filePath)};
      const parentPid = ${parentPid};
      const ctrl = fs.createWriteStream(null, { fd: 3 });
      const chunks = [];
      process.stdin.on('data', d => chunks.push(d));
      process.stdin.on('end', () => {
        // concat Buffers once at end - '+=' on a Buffer corrupts split UTF-8
        const content = Buffer.concat(chunks).toString('utf8');
        // signal readiness *before* the blocking FIFO open so the parent
        // knows it's safe for a reader (e.g. wrangler/miniflare) to proceed.
        ctrl.write('ready\\n');
        // Exit if the parent process dies (orphan protection).
        setInterval(() => {
          try { process.kill(parentPid, 0); }
          catch { process.exit(); }
        }, 2000);
        (function serve() {
          try { fs.writeFileSync(path, content); setImmediate(serve); }
          catch { process.exit(); }
        })();
      });
    `,
  ], {
    // stdin=pipe (content), stdout/stderr ignored, fd 3 = control pipe
    stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
  });

  fifoProcess.stdin!.write(content);
  fifoProcess.stdin!.end();

  const controlPipe = (fifoProcess.stdio as Array<any>)[3] as NodeJS.ReadableStream;

  await new Promise<void>((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      if (buf.includes('ready\n')) {
        controlPipe.off('data', onData);
        resolve();
      } else if (buf.startsWith('err:')) {
        reject(new Error(`fifo-server failed before ready: ${buf.trim()}`));
      }
    };
    controlPipe.on('data', onData);
    fifoProcess.once('exit', (code, signal) => {
      if (!buf.includes('ready\n')) {
        reject(new Error(`fifo-server exited before ready (code=${code}, signal=${signal})`));
      }
    });
  });

  return {
    stop() {
      fifoProcess.kill();
    },
    pid: fifoProcess.pid,
  };
}
