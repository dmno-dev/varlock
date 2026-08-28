/**
 * Identity keys for local encryption.
 *
 * Values used to be encrypted straight to the device key (Secure Enclave / TPM /
 * file). That ties every value to one machine and, on macOS, to the enclave's
 * 5-minute biometric reuse window. An identity key sits in between:
 *
 *   device key -> identity key -> values
 *
 * The identity is a software P-256 key pair. Its private key is never stored in
 * the clear: it is wrapped (ECIES) to one or more device keys, so unwrapping it
 * goes through whatever gate the device backend applies. Values are then
 * encrypted to the identity public key as v2 payloads.
 *
 * Custody rule: for hardware backends the identity private key must never enter
 * this process, so only the native daemon may unwrap it. This module is used
 * for the file backend, which already does all of its crypto in TS anyway.
 *
 * Nothing here ever touches project files. Identities live in user-level state
 * at `<user varlock dir>/identities/<id>.json`, mode 0600.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getUserVarlockDir } from '../user-config-dir';
import {
  createKeyPair, decrypt, encrypt, IDENTITY_PAYLOAD_VERSION,
} from './crypto';

const IDENTITY_STORE_SUBDIR = 'identities';

/** Format version of the identity file itself (not the payload version) */
export const IDENTITY_FILE_VERSION = 1;

/** Identity used when a caller does not name one */
export const DEFAULT_IDENTITY_ID = 'default';

export interface StoredIdentity {
  version: number;
  id: string;
  /** Base64-encoded uncompressed P-256 public key */
  publicKey: string;
  /**
   * The identity private key, encrypted to each device key that is allowed to
   * unwrap it, keyed by device key id.
   */
  wraps: Record<string, string>;
  createdAt: string;
}

/**
 * The device-key crypto the identity layer builds on.
 *
 * Injected rather than imported so this module stays a leaf: `index.ts` owns
 * backend routing and imports this, not the other way around.
 */
export interface DeviceCrypto {
  encrypt(plaintext: string, keyId: string): Promise<string>;
  decrypt(ciphertext: string, keyId: string): Promise<string>;
}

/** Thrown when a v2 payload turns up on a backend whose identity path is not built yet */
export class IdentityBackendUnsupportedError extends Error {
  constructor(public backendType: string) {
    super(
      `Identity-encrypted values are not yet supported on the ${backendType} backend; `
      + 'support arrives with the daemon update. Until then, encrypt with the file backend '
      + 'or keep using device-encrypted values.',
    );
    this.name = 'IdentityBackendUnsupportedError';
  }
}

/** Thrown when a v2 payload needs an identity this machine does not have */
export class IdentityNotFoundError extends Error {
  constructor(identityId: string) {
    super(`No local identity "${identityId}" found to decrypt this value`);
    this.name = 'IdentityNotFoundError';
  }
}

// ── Storage ────────────────────────────────────────────────────────────

function getIdentityStorePath(): string {
  return path.join(getUserVarlockDir(), IDENTITY_STORE_SUBDIR);
}

export function getIdentityFilePath(identityId: string = DEFAULT_IDENTITY_ID): string {
  return path.join(getIdentityStorePath(), `${identityId}.json`);
}

export function identityExists(identityId: string = DEFAULT_IDENTITY_ID): boolean {
  return fs.existsSync(getIdentityFilePath(identityId));
}


export function readIdentity(identityId: string = DEFAULT_IDENTITY_ID): StoredIdentity | undefined {
  const filePath = getIdentityFilePath(identityId);
  if (!fs.existsSync(filePath)) return undefined;

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<StoredIdentity>;
  if (parsed.version !== IDENTITY_FILE_VERSION) {
    throw new Error(`unsupported identity file version ${parsed.version}; upgrade varlock`);
  }
  if (!parsed.publicKey || !parsed.wraps || typeof parsed.wraps !== 'object') {
    throw new Error(`Invalid identity file format for identity: ${identityId}`);
  }
  return {
    version: parsed.version,
    id: parsed.id || identityId,
    publicKey: parsed.publicKey,
    wraps: parsed.wraps,
    createdAt: parsed.createdAt || new Date().toISOString(),
  };
}

function serializeIdentity(identity: StoredIdentity) {
  return `${JSON.stringify(identity, null, 2)}\n`;
}

/**
 * Write a brand-new identity file, refusing to clobber one that already exists.
 *
 * Two varlock processes can reach first use at the same moment. Without the
 * exclusive create the loser would overwrite the winner's identity, orphaning
 * every value the winner had just encrypted. Returns false when someone else
 * got there first, and the caller adopts their identity instead.
 */
function tryWriteNewIdentity(identity: StoredIdentity): boolean {
  fs.mkdirSync(getIdentityStorePath(), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(
      getIdentityFilePath(identity.id),
      serializeIdentity(identity),
      { mode: 0o600, flag: 'wx' },
    );
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Add a wrap to an identity that already exists on disk.
 *
 * Re-reads immediately before writing so a wrap another process added in the
 * meantime survives.
 */
function addWrapToIdentity(identityId: string, deviceKeyId: string, wrapped: string): StoredIdentity {
  const current = readIdentity(identityId);
  if (!current) throw new IdentityNotFoundError(identityId);
  current.wraps[deviceKeyId] = wrapped;
  fs.writeFileSync(getIdentityFilePath(identityId), serializeIdentity(current), { mode: 0o600 });
  return current;
}

// ── Unwrapped key cache ────────────────────────────────────────────────

/**
 * Unwrapped identity private keys, per identity + device key, for this process.
 *
 * Without this every decrypt in a load would re-run a device-key unwrap. The
 * key is only ever held here on the file backend, where the device key it was
 * wrapped to is itself a plaintext file, so this does not weaken anything.
 * Hardware backends never reach this module.
 */
const unwrappedPrivateKeys = new Map<string, string>();

function cacheKeyFor(identityId: string, deviceKeyId: string) {
  return `${identityId}\u0000${deviceKeyId}`;
}

/** Drop any unwrapped private keys held for this process (tests, and lock flows) */
export function clearUnwrappedIdentityCache() {
  unwrappedPrivateKeys.clear();
}

// ── Identity lifecycle ─────────────────────────────────────────────────

/**
 * Create a new identity whose private key is wrapped to the given device key.
 * Returns undefined when another process created one first.
 */
async function createIdentity(
  device: DeviceCrypto,
  deviceKeyId: string,
  identityId: string,
): Promise<StoredIdentity | undefined> {
  const keyPair = await createKeyPair();
  const wrapped = await device.encrypt(keyPair.privateKey, deviceKeyId);

  const identity: StoredIdentity = {
    version: IDENTITY_FILE_VERSION,
    id: identityId,
    publicKey: keyPair.publicKey,
    wraps: { [deviceKeyId]: wrapped },
    createdAt: new Date().toISOString(),
  };
  if (!tryWriteNewIdentity(identity)) return undefined;

  unwrappedPrivateKeys.set(cacheKeyFor(identityId, deviceKeyId), keyPair.privateKey);
  return identity;
}

/**
 * Unwrap the identity private key using any device key this machine can reach.
 * Tries the wraps in file order, so a machine that has picked up wraps from
 * several devices still opens on the one it actually holds.
 */
async function unwrapIdentityPrivateKey(
  device: DeviceCrypto,
  identity: StoredIdentity,
  identityId: string,
): Promise<string> {
  const wrapEntries = Object.entries(identity.wraps);
  if (wrapEntries.length === 0) {
    throw new Error(`Identity "${identityId}" has no wrapped private key`);
  }

  let lastError: unknown;
  for (const [deviceKeyId, wrapped] of wrapEntries) {
    const cached = unwrappedPrivateKeys.get(cacheKeyFor(identityId, deviceKeyId));
    if (cached) return cached;
    try {
      const privateKey = await device.decrypt(wrapped, deviceKeyId);
      unwrappedPrivateKeys.set(cacheKeyFor(identityId, deviceKeyId), privateKey);
      return privateKey;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `Unable to unwrap identity "${identityId}" with any device key on this machine`,
    { cause: lastError },
  );
}

async function resolveIdentity(
  device: DeviceCrypto,
  deviceKeyId: string,
  identityId: string,
): Promise<StoredIdentity> {
  let existing = readIdentity(identityId);

  if (!existing) {
    const created = await createIdentity(device, deviceKeyId, identityId);
    if (created) return created;
    // someone else created one between our read and our write: adopt theirs,
    // and fall through so it picks up a wrap for our device key if it needs one
    existing = readIdentity(identityId);
    if (!existing) throw new IdentityNotFoundError(identityId);
  }

  if (existing.wraps[deviceKeyId]) return existing;

  const privateKey = await unwrapIdentityPrivateKey(device, existing, identityId);
  const wrapped = await device.encrypt(privateKey, deviceKeyId);
  const updated = addWrapToIdentity(identityId, deviceKeyId, wrapped);
  unwrappedPrivateKeys.set(cacheKeyFor(identityId, deviceKeyId), privateKey);
  return updated;
}

/** In-flight ensures, so concurrent first-use callers share one creation */
const pendingEnsures = new Map<string, Promise<StoredIdentity>>();

/**
 * Load the identity, creating it on first use, and make sure it carries a wrap
 * for the given device key.
 *
 * Adding a wrap for a device key that has none requires unwrapping through a
 * device key that does, which is the same trust step as any other decrypt.
 *
 * Concurrent callers share a single ensure. A batch of values encrypted at once
 * on a fresh machine would otherwise each generate their own identity, and all
 * but the last would end up encrypted to a key nothing can unwrap.
 */
export async function ensureIdentity(
  device: DeviceCrypto,
  deviceKeyId: string,
  identityId: string = DEFAULT_IDENTITY_ID,
): Promise<StoredIdentity> {
  const pendingKey = cacheKeyFor(identityId, deviceKeyId);
  const pending = pendingEnsures.get(pendingKey);
  if (pending) return pending;

  const ensuring = resolveIdentity(device, deviceKeyId, identityId)
    .finally(() => pendingEnsures.delete(pendingKey));
  pendingEnsures.set(pendingKey, ensuring);
  return ensuring;
}

// ── Encrypt / Decrypt ──────────────────────────────────────────────────

/** Encrypt a value to the identity public key, producing a v2 payload. */
export async function encryptToIdentity(
  device: DeviceCrypto,
  plaintext: string,
  deviceKeyId: string,
  identityId: string = DEFAULT_IDENTITY_ID,
): Promise<string> {
  const identity = await ensureIdentity(device, deviceKeyId, identityId);
  return encrypt(identity.publicKey, plaintext, { version: IDENTITY_PAYLOAD_VERSION });
}

/** Decrypt a v2 payload by unwrapping the identity private key first. */
export async function decryptWithIdentity(
  device: DeviceCrypto,
  ciphertext: string,
  identityId: string = DEFAULT_IDENTITY_ID,
): Promise<string> {
  const identity = readIdentity(identityId);
  if (!identity) throw new IdentityNotFoundError(identityId);

  const privateKey = await unwrapIdentityPrivateKey(device, identity, identityId);
  return decrypt(privateKey, identity.publicKey, ciphertext);
}
