import type { Readable } from 'node:stream';
import { CliExitError } from './exit-error';

const drainTimeoutMs = 2000;

export async function drainChildOutput(commandProcess: {
  stdout?: Readable;
  stderr?: Readable;
}, completion: { exitCode?: number; shutdownRequested?: boolean } = {}): Promise<void> {
  const streams = [commandProcess.stdout, commandProcess.stderr]
    .filter((stream): stream is Readable => stream !== undefined);
  if (!streams.length) return;

  const cleanup: Array<() => void> = [];
  const closed = streams.map((stream) => new Promise<void>((resolve) => {
    if (stream.closed) {
      resolve();
    } else {
      stream.once('close', resolve);
      cleanup.push(() => {
        stream.off('close', resolve);
      });
    }
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      for (const stream of streams) stream.destroy();
      reject(new CliExitError(`Child output did not finish draining within ${drainTimeoutMs}ms`, {
        details: 'The child has exited, but an inherited pipe or output destination is still open. Output may be incomplete.',
        forceExit: true,
      }));
    }, drainTimeoutMs);
  });

  try {
    await Promise.race([
      (async () => {
        await Promise.all(closed);
        await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve, reject) => {
          stream.write('', (error) => {
            if (error) reject(error);
            else resolve();
          });
        })));
      })(),
      deadline,
    ]);
  } catch (error) {
    if (!(error instanceof CliExitError) || (!completion.exitCode && !completion.shutdownRequested)) throw error;
    console.error(error.getFormattedOutput());
  } finally {
    clearTimeout(timer);
    for (const remove of cleanup) remove();
  }
}
