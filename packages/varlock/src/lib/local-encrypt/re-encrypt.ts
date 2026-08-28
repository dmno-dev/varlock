/**
 * Re-encrypt values that are already encrypted, in place, in an env file.
 *
 * A pass is a decrypt followed by an encrypt, described as a source (which
 * existing values to pick up, and how to open them) and a target (where they
 * should land). Today the only pass is device-encrypted (v1) values moving to
 * whatever the local backend currently encrypts to, but the same core is meant
 * to carry `encrypt --to <vault>`, key rotation, and cloud migration, so it
 * takes source and target rather than hardcoding v1 to v2.
 *
 * A local pass can only run where this process may hold both keys. That means
 * the file backend for now; hardware backends wait for the daemon that can do
 * the same work without handing the identity key to V8.
 */

import fs from 'node:fs';
import {
  parseEnvSpecDotEnvFile,
  ParsedEnvSpecFunctionCall,
} from '@env-spec/parser';
import { DEFAULT_KEY_ID } from './constants';
import { DEVICE_PAYLOAD_VERSION, readPayloadVersion } from './crypto';
import * as localEncrypt from './index';
import {
  buildVarlockReference, LOCAL_SCHEME, parseVarlockReference, type ParsedVarlockReference,
  type VarlockScheme,
} from './reference';
import { writeBackValue } from './write-back';

/** Which already-encrypted values a pass picks up, and how it opens them */
export interface ReEncryptSource {
  /** Whether this value is one the pass should re-encrypt */
  matches: (reference: ParsedVarlockReference) => boolean;
  /** Turn a matched value back into plaintext */
  decrypt: (reference: ParsedVarlockReference) => Promise<string>;
}

/** Where a re-encrypted value lands */
export interface ReEncryptTarget {
  /** Scheme the rewritten `varlock()` reference is built with */
  scheme: VarlockScheme;
  encrypt: (plaintext: string) => Promise<string>;
}

/**
 * Why a value was left alone.
 *
 * - `not-a-static-payload`: carries no payload to re-encrypt (e.g. `varlock(prompt=1)`)
 * - `unknown-scheme`: the reference names a scheme this build does not know
 * - `not-a-source-value`: not what this pass is looking for, including values already at the target
 * - `write-back-failed`: decrypted and re-encrypted, but the file could not be updated
 */
export type ReEncryptSkipReason = 'not-a-static-payload'
  | 'unknown-scheme'
  | 'not-a-source-value'
  | 'write-back-failed';

export interface ReEncryptFileResult {
  filePath: string;
  /** keys rewritten from the source to the target */
  reEncrypted: Array<string>;
  /** keys left alone, and why */
  skipped: Array<{ key: string; reason: ReEncryptSkipReason }>;
}

/**
 * Values encrypted directly to this device's key, as a source.
 *
 * v2 values are deliberately not matched: they are already where a local pass
 * would put them.
 */
export function deviceEncryptedSource(keyId: string = DEFAULT_KEY_ID): ReEncryptSource {
  return {
    matches: (reference) => reference.scheme === LOCAL_SCHEME
      && readPayloadVersion(reference.payload) === DEVICE_PAYLOAD_VERSION,
    decrypt: (reference) => localEncrypt.decryptValue(reference.payload, keyId),
  };
}

/**
 * Whatever the local backend currently encrypts to, as a target. That is the
 * identity key on the file backend and the device key elsewhere, so this stays
 * correct as backends gain identity support.
 */
export function currentLocalTarget(keyId: string = DEFAULT_KEY_ID): ReEncryptTarget {
  return {
    scheme: LOCAL_SCHEME,
    encrypt: (plaintext) => localEncrypt.encryptValue(plaintext, keyId),
  };
}

/** Whether this machine can run a local re-encryption pass at all */
export function canReEncryptLocally(): { ok: true } | { ok: false; reason: string } {
  const backend = localEncrypt.getBackendInfo();
  if (backend.type !== 'file') {
    return {
      ok: false,
      reason: `The ${backend.type} backend cannot re-encrypt values yet, because that means holding the `
        + 'identity key in this process. It arrives with the daemon update.',
    };
  }
  return { ok: true };
}

/**
 * Re-encrypt every value in one env file that the source matches.
 *
 * Values the source does not match, prompts, and anything that is not a
 * `varlock()` reference are left exactly as they are: only the entries that
 * actually change get rewritten.
 */
export async function reEncryptFile(
  filePath: string,
  opts: { source: ReEncryptSource; target: ReEncryptTarget; dryRun?: boolean },
): Promise<ReEncryptFileResult> {
  const { source, target } = opts;
  const result: ReEncryptFileResult = { filePath, reEncrypted: [], skipped: [] };

  const parsed = parseEnvSpecDotEnvFile(fs.readFileSync(filePath, 'utf-8'));

  for (const item of parsed.configItems) {
    const value = item.value;
    if (!(value instanceof ParsedEnvSpecFunctionCall) || value.name !== 'varlock') continue;

    const args = value.simplifiedArgs;
    if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string') {
      // varlock(prompt=1) and friends carry no payload to re-encrypt
      result.skipped.push({ key: item.key, reason: 'not-a-static-payload' });
      continue;
    }

    let reference;
    try {
      reference = parseVarlockReference(args[0]);
    } catch {
      result.skipped.push({ key: item.key, reason: 'unknown-scheme' });
      continue;
    }

    if (!source.matches(reference)) {
      result.skipped.push({ key: item.key, reason: 'not-a-source-value' });
      continue;
    }

    const plaintext = await source.decrypt(reference);
    const reEncrypted = await target.encrypt(plaintext);

    if (opts.dryRun) {
      result.reEncrypted.push(item.key);
      continue;
    }

    const writeResult = writeBackValue(
      item.key,
      buildVarlockReference(target.scheme, reEncrypted),
      filePath,
    );
    if (!writeResult.updated) {
      result.skipped.push({ key: item.key, reason: 'write-back-failed' });
      continue;
    }
    result.reEncrypted.push(item.key);
  }

  return result;
}
