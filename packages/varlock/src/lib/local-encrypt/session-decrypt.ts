/**
 * Opening identity-encrypted (v2) payloads on a hardware backend.
 *
 * The identity private key must never enter this process on these backends, so
 * the daemon holds it and does the decrypting. Two ops make that work:
 *
 *   unlock-session  open a grant, at the cost of one user-presence check
 *   decrypt-v2      spend that grant on a batch of payloads
 *
 * The batching is the point. A whole env file resolves at once, so the grouping
 * here turns a file full of secrets into a single unlock: one panel, one scan,
 * however many values. Splitting a batch would cost a prompt per value, which is
 * the behaviour the identity layer exists to get rid of.
 */

import path from 'node:path';
import { VARLOCK_VERSION } from '../varlock-version';
import { DaemonError, type DaemonClient } from './daemon-client';
import type {
  SessionGrantInfo, UnlockDisplayInfo, UnlockInvocationMode, UnlockKeyDisplay, UnlockValueFile,
} from './types';

/** Thrown when the user was shown the unlock panel and said no */
export class UnlockDeclinedError extends Error {
  constructor() {
    super('Unlock was declined');
    this.name = 'UnlockDeclinedError';
  }
}

/**
 * Thrown when there is no screen to ask on.
 *
 * An unlock needs a person, so an SSH session or a headless host has nowhere to
 * put the question. The way out is a key that carries no presence gate.
 */
export class UnlockNoUiError extends Error {
  constructor() {
    super(
      'This machine has no graphical session to show the unlock panel on, so the '
      + 'encrypted values cannot be opened here.',
    );
    this.name = 'UnlockNoUiError';
  }
}

/** One payload to open, and the device key whose identity wrap opens it */
export interface IdentityPayloadRequest {
  ciphertext: string;
  keyId: string;
  /**
   * The env var this payload belongs to, and the file that defined it.
   *
   * Both are for the panel only. They travel as display metadata, are never
   * bound into the crypto, and a wrong or missing one changes nothing but the
   * wording of a row the user can expand.
   */
  valueName?: string;
  sourceFile?: string;
}

/**
 * Grants this process believes are live, by key id, with the epoch ms they run
 * out at.
 *
 * Only an optimisation: it lets a second batch skip straight to decrypt-v2
 * rather than re-asking for an unlock the daemon would answer trivially. Being
 * wrong is harmless, because a decrypt against a dead grant comes back as
 * NO_SESSION_GRANT and the retry below opens a new one.
 */
const liveGrants = new Map<string, number>();

/** Forget the grants this process thinks it holds (used by the lock flows) */
export function clearKnownGrants() {
  liveGrants.clear();
}

function rememberGrant(grant: SessionGrantInfo | undefined) {
  if (grant?.keyId && typeof grant.expiresAt === 'number') {
    liveGrants.set(grant.keyId, grant.expiresAt);
  }
}

/** Leaves a little room, so a grant about to lapse is treated as already gone */
const GRANT_FRESHNESS_MARGIN_MS = 5_000;

function grantLooksLive(keyId: string): boolean {
  const expiresAt = liveGrants.get(keyId);
  return expiresAt !== undefined && expiresAt - GRANT_FRESHNESS_MARGIN_MS > Date.now();
}

function daemonErrorCode(err: unknown): string | undefined {
  return err instanceof DaemonError ? err.code : undefined;
}

/** Turn the daemon's refusals into errors that say what the user should do */
function translateSessionError(err: unknown): unknown {
  switch (daemonErrorCode(err)) {
    case 'APPROVAL_DENIED': return new UnlockDeclinedError();
    case 'NO_UI': return new UnlockNoUiError();
    default: return err;
  }
}

/**
 * Open a grant covering every key in one go.
 *
 * `scope: 'session'` is what makes this a session rather than a per-command
 * prompt. `lockOn` is deliberately not sent: the machine config decides which
 * system events end the session, and a project must not get to weaken that.
 */
async function unlock(
  client: DaemonClient,
  keyIds: Array<string>,
  display: UnlockDisplayInfo | undefined,
) {
  try {
    const result = await client.unlockSession({ keyIds, scope: 'session', display });
    for (const grant of result.grants ?? []) rememberGrant(grant);
    return result;
  } catch (err) {
    for (const keyId of keyIds) liveGrants.delete(keyId);
    throw translateSessionError(err);
  }
}

async function decryptGroup(
  client: DaemonClient,
  keyId: string,
  ciphertexts: Array<string>,
  display: UnlockDisplayInfo | undefined,
): Promise<Array<string>> {
  try {
    const result = await client.decryptV2({ keyId, ciphertexts });
    rememberGrant(result.grant);
    return result.plaintexts;
  } catch (err) {
    // The grant can die between the unlock and the decrypt: the session may have
    // been locked from the menu bar, or the machine may have slept. One more
    // unlock covers that, and a second failure is a real refusal rather than a race.
    if (daemonErrorCode(err) !== 'NO_SESSION_GRANT' && daemonErrorCode(err) !== 'SESSION_GRANT_EXPIRED') {
      throw translateSessionError(err);
    }
    liveGrants.delete(keyId);
    await unlock(client, [keyId], display);
    try {
      const retried = await client.decryptV2({ keyId, ciphertexts });
      rememberGrant(retried.grant);
      return retried.plaintexts;
    } catch (retryErr) {
      throw translateSessionError(retryErr);
    }
  }
}

/**
 * How varlock came to be running here.
 *
 * `auto-load` is set by whatever spawned this CLI, because from inside the child
 * an auto-load and a typed command look identical: both are the varlock CLI.
 * Failing that, an entry point named varlock is somebody running varlock, and
 * anything else is varlock being used as a library.
 */
export function detectInvocationMode(): UnlockInvocationMode {
  const declared = process.env._VARLOCK_INVOCATION_MODE;
  if (declared === 'auto-load' || declared === 'cli' || declared === 'sdk') return declared;
  const entry = process.argv[1] ? path.basename(process.argv[1]).replace(/\.(c|m)?[jt]s$/, '') : '';
  return entry === 'varlock' ? 'cli' : 'sdk';
}

/**
 * Describe what this batch is asking each key to open.
 *
 * The panel says who is asking on its own authority, but it cannot know what
 * the values are called: that lives in the env graph in this process. So the
 * value names and the files that defined them are sent as display metadata, and
 * the panel draws them as client-reported. Nothing here is bound into the
 * crypto, and the daemon does not check any of it, on purpose: display metadata
 * that a decrypt depended on would turn a cosmetic mismatch into a failed
 * unlock.
 *
 * A caller's own `keys` entries (a vault label and colour, once vaults exist)
 * are kept, since only the caller knows those.
 */
function buildDisplayInfo(
  payloads: Array<IdentityPayloadRequest>,
  groups: Map<string, Array<number>>,
  supplied: UnlockDisplayInfo | undefined,
): UnlockDisplayInfo {
  const keys: Record<string, UnlockKeyDisplay> = {};

  for (const [keyId, indexes] of groups) {
    // Grouped by file, in the order the files first appear, so the panel reads
    // the way the env files were loaded rather than in some hash order.
    const byFile = new Map<string, UnlockValueFile>();
    for (const index of indexes) {
      const { valueName, sourceFile } = payloads[index];
      if (!valueName) continue;
      // Values whose file is unknown still get listed, under no heading.
      const groupKey = sourceFile ?? '';
      let file = byFile.get(groupKey);
      if (!file) {
        file = { path: sourceFile, valueNames: [] };
        byFile.set(groupKey, file);
      }
      file.valueNames.push(valueName);
    }

    keys[keyId] = {
      ...supplied?.keys?.[keyId],
      valueCount: indexes.length,
      ...(byFile.size > 0 ? { files: [...byFile.values()] } : {}),
    };
  }

  return {
    invocationMode: detectInvocationMode(),
    // Which build of varlock is asking. The daemon resolves this for itself when
    // varlock is running as JavaScript, since it can find the package on disk;
    // the standalone binary carries no package to read, so this is the only
    // answer available there, and the panel draws it as the caller's claim.
    varlockVersion: VARLOCK_VERSION,
    ...supplied,
    // how much each key is being asked to cover, so the panel can say so
    itemCounts: Object.fromEntries([...groups].map(([keyId, indexes]) => [keyId, indexes.length])),
    keys,
  };
}

/**
 * Open every payload, in payload order, using as few unlocks as possible.
 *
 * Keys already covered by a grant this process opened are left out of the unlock
 * request, so a second batch in the same run costs no panel at all.
 */
export async function decryptIdentityPayloadsViaDaemon(
  client: DaemonClient,
  payloads: Array<IdentityPayloadRequest>,
  opts?: { display?: UnlockDisplayInfo },
): Promise<Array<string>> {
  if (payloads.length === 0) return [];

  // group by key, keeping each payload's position so results come back in order
  const groups = new Map<string, Array<number>>();
  for (const [index, payload] of payloads.entries()) {
    const existing = groups.get(payload.keyId);
    if (existing) existing.push(index);
    else groups.set(payload.keyId, [index]);
  }

  const keyIds = [...groups.keys()];
  const display = buildDisplayInfo(payloads, groups, opts?.display);

  const needUnlock = keyIds.filter((keyId) => !grantLooksLive(keyId));
  if (needUnlock.length > 0) await unlock(client, needUnlock, display);

  const plaintexts = new Array<string>(payloads.length);
  for (const [keyId, indexes] of groups) {
    // sequential on purpose: a second unlock racing the first would draw a
    // second panel for a session the first one is already opening

    const opened = await decryptGroup(
      client,
      keyId,
      indexes.map((i) => payloads[i].ciphertext),
      display,
    );
    if (opened.length !== indexes.length) {
      throw new Error(
        `Daemon returned ${opened.length} plaintexts for ${indexes.length} payloads on key "${keyId}"`,
      );
    }
    indexes.forEach((payloadIndex, position) => {
      plaintexts[payloadIndex] = opened[position];
    });
  }

  return plaintexts;
}
