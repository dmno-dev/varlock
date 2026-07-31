import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir, readFile, rename, writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getProxySessionDir } from './session-registry';

/**
 * File-based request/result channel between `varlock proxy reload` and the
 * process that owns a live proxy runtime (a `proxy start` daemon or a
 * self-owned `proxy run`). The reload process writes a request; the owner polls
 * for it, hot-reloads its policy, and writes back a result the reload process
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
  /**
   * Set when the reload was requested from inside the proxied agent (self-reported
   * via the proxy-context markers). The owner refuses these so an agent can't
   * self-approve its own schema edit; a human must run `proxy reload` from a
   * trusted terminal. Not a hard boundary on a shared uid (a marker-stripping
   * agent evades it, same as the other in-tree guards), but it catches the
   * honest path and surfaces the attempt in the owner's log. The out-of-band
   * approver is the real gate.
   */
  requestedFromProxyChild?: boolean;
};

/** All terminal. `denied` = the owner refused it (today: requested from inside the agent). */
export type ProxyReloadStatus = 'done' | 'error' | 'denied';

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
