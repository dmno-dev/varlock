/**
 * Rewrite device-encrypted values (v1) as identity-encrypted values (v2).
 *
 * Migration is a decrypt followed by a re-encrypt, so it can only run where
 * this process is allowed to hold both keys. That means the file backend for
 * now; hardware backends wait for the daemon that can do the same work without
 * handing the identity key to V8.
 */

import fs from 'node:fs';
import {
  parseEnvSpecDotEnvFile,
  ParsedEnvSpecFunctionCall,
} from '@env-spec/parser';
import { DEFAULT_KEY_ID } from './constants';
import { DEVICE_PAYLOAD_VERSION, IDENTITY_PAYLOAD_VERSION, readPayloadVersion } from './crypto';
import { isIdentityEnabled } from './identity';
import * as localEncrypt from './index';
import { buildVarlockReference, LOCAL_SCHEME, parseVarlockReference } from './reference';
import { writeBackValue } from './write-back';

export type MigrateSkipReason = | 'not-a-varlock-reference'
  | 'not-a-static-payload'
  | 'unknown-scheme'
  | 'already-identity-encrypted'
  | 'write-back-failed';

export interface MigrateFileResult {
  filePath: string;
  /** keys rewritten from v1 to v2 */
  migrated: Array<string>;
  /** keys left alone, and why */
  skipped: Array<{ key: string; reason: MigrateSkipReason }>;
}

/** Whether this machine can run a migration at all */
export function canMigrateToIdentity(): { ok: true } | { ok: false; reason: string } {
  const backend = localEncrypt.getBackendInfo();
  if (backend.type !== 'file') {
    return {
      ok: false,
      reason: `The ${backend.type} backend cannot migrate values yet, because migrating means holding the `
        + 'identity key in this process. It arrives with the daemon update.',
    };
  }
  if (!isIdentityEnabled()) {
    return { ok: false, reason: 'The identity layer is disabled, so there is nothing to migrate to.' };
  }
  return { ok: true };
}

/**
 * Migrate every v1 `varlock("local:...")` value in one env file.
 *
 * Values that are already v2, prompts, and anything that is not a local
 * reference are left exactly as they are, including their formatting: only the
 * entries that actually change get rewritten.
 */
export async function migrateFileToIdentity(
  filePath: string,
  opts?: { keyId?: string; dryRun?: boolean },
): Promise<MigrateFileResult> {
  const keyId = opts?.keyId ?? DEFAULT_KEY_ID;
  const result: MigrateFileResult = { filePath, migrated: [], skipped: [] };

  const parsed = parseEnvSpecDotEnvFile(fs.readFileSync(filePath, 'utf-8'));

  for (const item of parsed.configItems) {
    const value = item.value;
    if (!(value instanceof ParsedEnvSpecFunctionCall) || value.name !== 'varlock') continue;

    const args = value.simplifiedArgs;
    if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string') {
      // varlock(prompt=1) and friends carry no payload to migrate
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
    if (reference.scheme !== LOCAL_SCHEME) {
      result.skipped.push({ key: item.key, reason: 'unknown-scheme' });
      continue;
    }

    const version = readPayloadVersion(reference.payload);
    if (version === IDENTITY_PAYLOAD_VERSION) {
      result.skipped.push({ key: item.key, reason: 'already-identity-encrypted' });
      continue;
    }
    if (version !== DEVICE_PAYLOAD_VERSION) {
      result.skipped.push({ key: item.key, reason: 'not-a-varlock-reference' });
      continue;
    }


    const plaintext = await localEncrypt.decryptValue(reference.payload, keyId);

    const reEncrypted = await localEncrypt.encryptValue(plaintext, keyId);

    if (opts?.dryRun) {
      result.migrated.push(item.key);
      continue;
    }

    const writeResult = writeBackValue(
      item.key,
      buildVarlockReference(LOCAL_SCHEME, reEncrypted),
      filePath,
    );
    if (!writeResult.updated) {
      result.skipped.push({ key: item.key, reason: 'write-back-failed' });
      continue;
    }
    result.migrated.push(item.key);
  }

  return result;
}
