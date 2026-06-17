import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir, readFile, rename, writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getProxySessionDir } from './session-registry';

/**
 * File-based request/result channel between `varlock proxy refresh` and the
 * process that owns a live proxy runtime (a `proxy start` daemon or a
 * self-owned `proxy run`). The refresh process writes a request; the owner polls
 * for it, hot-reloads its policy, and writes back a result the refresh process
 * blocks on. Cross-platform (no signals) and holds no secret values.
 *
 * This is interim plumbing: when the native app / phone approver lands it talks
 * to the proxy process directly, inserting an approval step and superseding this
 * file handshake. The request → (approve) → reload → result contract is shaped
 * for that drop-in. There is intentionally no real authentication here — on a
 * shared uid it could not be enforced anyway; the out-of-band approver is the
 * actual trust boundary. See notes.ignore/proxy-refresh-reload-design.md.
 */
export type ProxyReloadRequest = {
  requestId: string;
  requestedAt: string;
  /** Entry paths to resolve from; falls back to the session's stored paths. */
  entryPaths?: Array<string>;
};

/** `done`/`error` are terminal. A future approver adds `denied` (+ a pending phase). */
export type ProxyReloadStatus = 'reloading' | 'done' | 'error';

export type ProxyReloadResult = {
  requestId: string;
  status: ProxyReloadStatus;
  completedAt: string;
  /** Count of managed items after reload (for a friendly confirmation message). */
  managedItemCount?: number;
  error?: string;
};

function reloadRequestPath(uuid: string): string {
  return join(getProxySessionDir(uuid), 'reload-request.json');
}

function reloadResultPath(uuid: string): string {
  return join(getProxySessionDir(uuid), 'reload-result.json');
}

export function newReloadRequestId(): string {
  return randomBytes(8).toString('hex');
}

/** Write JSON via tmp-file + rename so a reader never sees a torn/partial file. */
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  await rename(tmp, filePath);
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined; // torn read mid-write; the caller polls again
  }
}

export async function writeReloadRequest(uuid: string, request: ProxyReloadRequest): Promise<void> {
  await writeJsonAtomic(reloadRequestPath(uuid), request);
}

export async function readReloadRequest(uuid: string): Promise<ProxyReloadRequest | undefined> {
  return readJson<ProxyReloadRequest>(reloadRequestPath(uuid));
}

export async function writeReloadResult(uuid: string, result: ProxyReloadResult): Promise<void> {
  await writeJsonAtomic(reloadResultPath(uuid), result);
}

export async function readReloadResult(uuid: string): Promise<ProxyReloadResult | undefined> {
  return readJson<ProxyReloadResult>(reloadResultPath(uuid));
}
