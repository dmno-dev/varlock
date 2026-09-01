/**
 * Built-in varlock() resolver function.
 *
 * Replaces the plugin-based resolver from @varlock/secure-enclave-plugin.
 * Works cross-platform using the local-encrypt abstraction layer.
 */

import path from 'node:path';
import { createResolver, Resolver } from '../../env-graph/lib/resolver';
import { ResolutionError, SchemaError } from '../../env-graph/lib/errors';
import prompts from '../../cli/helpers/prompts';
import { IDENTITY_PAYLOAD_VERSION, readPayloadVersion } from './crypto';
import * as localEncrypt from './index';
import { buildVarlockReference, LOCAL_SCHEME, parseVarlockReference } from './reference';
import { projectDisplay } from './session-decrypt';
import { writeBackValue } from './write-back';

const PLUGIN_ICON = 'mdi:fingerprint';

// ── Unified varlock() batch queue ──────────────────────────────
// Collects all concurrent varlock() calls (both prompt and decrypt) into a
// single batch using setImmediate, then processes them sequentially.
// Prompts are sorted first so the user enters values before biometric decrypts.
// If the user cancels a prompt or biometric auth, all remaining items in the
// batch are rejected immediately.
//
// Identity-encrypted (v2) values are the exception to "sequentially": they are
// opened as one group before the loop runs, so a file full of secrets costs a
// single unlock instead of one per value. The loop then just hands out results
// that are already in hand.

type VarlockBatchEntry = {
  kind: 'prompt' | 'decrypt';
  /** local encryption key id this entry encrypts or decrypts with */
  keyId: string;
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
} & (
  | {
    kind: 'decrypt';
    ciphertext: string;
    /** the env var this value belongs to, and the file that set it, for the panel */
    itemKey?: string;
    sourceFilePath?: string;
  }
  | { kind: 'prompt'; execute: () => Promise<string> }
);

let pendingBatch: Array<VarlockBatchEntry> | undefined;

function enqueueBatchEntry(entry: VarlockBatchEntry) {
  let triggerBatch = false;
  if (!pendingBatch) {
    pendingBatch = [];
    triggerBatch = true;
  }
  pendingBatch.push(entry);

  if (triggerBatch) {
    // eslint-disable-next-line no-use-before-define
    setImmediate(() => executeBatch());
  }
}

function enqueueDecrypt(
  ciphertext: string,
  keyId: string,
  origin: { itemKey?: string; sourceFilePath?: string } = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    enqueueBatchEntry({
      kind: 'decrypt',
      ciphertext,
      keyId,
      itemKey: origin.itemKey,
      sourceFilePath: origin.sourceFilePath,
      resolve,
      reject,
    });
  });
}

function enqueuePrompt(keyId: string, execute: () => Promise<string>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    enqueueBatchEntry({
      kind: 'prompt', keyId, execute, resolve, reject,
    });
  });
}

function bailRemaining(batch: Array<VarlockBatchEntry>, startIndex: number, error: Error) {
  for (let j = startIndex; j < batch.length; j++) {
    batch[j].reject(error);
  }
}

type DecryptBatchEntry = Extract<VarlockBatchEntry, { kind: 'decrypt' }>;

function isIdentityEntry(entry: VarlockBatchEntry): entry is DecryptBatchEntry {
  return entry.kind === 'decrypt'
    && readPayloadVersion(entry.ciphertext) === IDENTITY_PAYLOAD_VERSION;
}

/**
 * Open every identity-encrypted entry in the batch as one group.
 *
 * Run once, at the first v2 value the loop reaches rather than up front, so the
 * prompts sorted ahead of it still get the user's attention first: nobody wants
 * an unlock panel over the top of a dialog asking them to type a secret.
 */
async function openIdentityEntries(
  batch: Array<VarlockBatchEntry>,
): Promise<Map<VarlockBatchEntry, string>> {
  const identityEntries = batch.filter(isIdentityEntry);
  const opened = new Map<VarlockBatchEntry, string>();
  if (identityEntries.length === 0) return opened;

  const plaintexts = await localEncrypt.decryptIdentityPayloads(
    identityEntries.map((entry) => ({
      ciphertext: entry.ciphertext,
      keyId: entry.keyId,
      // What the panel lists behind each key's row. Display only: the daemon
      // never checks it and the crypto never sees it.
      valueName: entry.itemKey,
      sourceFile: entry.sourceFilePath,
    })),
    // decoration for the unlock panel. The daemon works out who is asking from
    // the connection itself and treats all of this as secondary.
    { display: projectDisplay() },
  );
  identityEntries.forEach((entry, i) => opened.set(entry, plaintexts[i]));
  return opened;
}

async function executeBatch() {
  const batch = pendingBatch;
  pendingBatch = undefined;
  if (!batch?.length) return;

  // Sort prompts before decrypts so the user enters values first
  batch.sort((a, b) => {
    if (a.kind === b.kind) return 0;
    return a.kind === 'prompt' ? -1 : 1;
  });

  // Ensure every key this batch touches exists before processing any items
  for (const keyId of new Set(batch.map((e) => e.keyId))) {
    await localEncrypt.ensureKey(keyId);
  }

  let identityValues: Map<VarlockBatchEntry, string> | undefined;

  for (let i = 0; i < batch.length; i++) {
    const entry = batch[i];
    try {
      if (entry.kind === 'decrypt') {
        if (isIdentityEntry(entry) && !identityValues) {
          // the single unlock that covers every v2 value in this batch; a failure
          // here belongs to all of them, so it takes the whole rest of the batch
          try {
            identityValues = await openIdentityEntries(batch);
          } catch (err) {
            bailRemaining(batch, i, err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
        const alreadyOpened = identityValues?.get(entry);
        const plaintext = alreadyOpened !== undefined
          ? alreadyOpened
          : await localEncrypt.decryptValue(entry.ciphertext, entry.keyId);
        entry.resolve(plaintext);
      } else {
        const result = await entry.execute();
        entry.resolve(result);
      }
    } catch (err) {
      entry.reject(err);

      // If this looks like a user cancellation or auth failure, bail on remaining items
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('cancelled') || msg.includes('canceled')
        || msg.includes('verification failed')
      ) {
        bailRemaining(batch, i + 1, new ResolutionError('Skipped — user cancelled'));
        return;
      }
    }
  }
}

/**
 * The file an env value came from, named the way a person would name it.
 *
 * `.env.local` rather than a home-directory-deep absolute path: the panel row
 * is about recognising your own project, and the full path is neither
 * recognisable nor small enough to draw.
 */
function displayFilePath(fullPath: string | undefined): string | undefined {
  if (!fullPath) return undefined;
  const relative = path.relative(process.cwd(), fullPath);
  return relative && !relative.startsWith('..') ? relative : fullPath;
}

type VarlockResolverState = {
  mode: 'decrypt';
  payload: string;
  itemKey?: string;
  sourceFilePath?: string;
} | {
  mode: 'prompt';
  itemKey: string;
  sourceFilePath: string | undefined;
};

function writeBackEncryptedValue(
  itemKey: string,
  ciphertext: string,
  sourceFilePath: string | undefined,
) {
  return writeBackValue(itemKey, buildVarlockReference(LOCAL_SCHEME, ciphertext), sourceFilePath);
}

/**
 * Encrypt a value the user just typed at the terminal.
 *
 * The two native daemons capture secrets differently, on purpose. macOS has
 * `prompt-secret`: the Swift daemon draws its own dialog, so the value is read
 * and encrypted without ever crossing the socket, and the branch above uses it.
 * The Rust daemon has no such op and is not going to grow one, because on
 * Windows and Linux the reading happens here in the terminal. What it offers
 * instead is `encrypt` with an `identityPublicKey`, which is what this uses, so
 * both platforms end up with the daemon minting the ciphertext.
 *
 * Do not "unify" these by pointing one platform at the other's op: neither
 * daemon implements the other's, and the difference is about which process owns
 * the input, not about the encryption. The in-process fallback is safe either
 * way, since encrypting to an identity needs nothing but its public key.
 */
async function encryptCapturedSecret(plaintext: string, keyId: string): Promise<string> {
  const backend = localEncrypt.getBackendInfo();
  const identityPublicKey = await localEncrypt.getEncryptionIdentityPublicKey(keyId);

  if (identityPublicKey && backend.type !== 'file' && localEncrypt.canUseIdentityEncryption()) {
    try {
      return await localEncrypt.getDaemonClient().encryptToIdentity(plaintext, identityPublicKey);
    } catch (err) {
      // A daemon that will not start is no reason to lose the value the user
      // just typed: the same encryption runs here from the same public key.
      localEncrypt.debugLog(
        `daemon encrypt failed, encrypting in-process: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return localEncrypt.encryptValue(plaintext, keyId);
}


export const VarlockResolver: typeof Resolver = createResolver<VarlockResolverState>({
  name: 'varlock',
  label: 'Decrypt locally encrypted value',
  icon: PLUGIN_ICON,
  impliesSensitive: true,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 0,
  },
  process(): VarlockResolverState {
    // Check for prompt mode: varlock(prompt=1) or varlock(prompt)
    const promptArg = this.objArgs?.prompt;
    const isPromptPositional = this.arrArgs?.length === 1
      && this.arrArgs[0]?.isStatic
      && this.arrArgs[0].staticValue === 'prompt';
    if (promptArg || isPromptPositional) {
      // Resolver doesn't expose parent item in its type, but it's available at runtime
      const parent = (this as any).parent;
      const itemKey = parent?.key || 'unknown';
      const dataSource = this.dataSource as any;
      const sourceFilePath = dataSource?.fullPath as string | undefined;
      return { mode: 'prompt', itemKey, sourceFilePath };
    }

    // Normal mode: varlock("encrypted-payload")
    if (!this.arrArgs || this.arrArgs.length !== 1) {
      throw new SchemaError('varlock() expects a single encrypted payload string, or prompt to enter a new value');
    }
    if (!this.arrArgs[0]?.isStatic) {
      throw new SchemaError('varlock() expects a single static encrypted payload string');
    }
    const payload = this.arrArgs[0].staticValue;
    if (typeof payload !== 'string') {
      throw new SchemaError('varlock() expects a string argument');
    }
    // Same runtime-only fields the prompt branch reads, kept so the unlock panel
    // can say which values in which files this batch is about.
    const parent = (this as any).parent;
    const dataSource = this.dataSource as any;
    return {
      mode: 'decrypt',
      payload,
      itemKey: parent?.key,
      sourceFilePath: displayFilePath(dataSource?.fullPath as string | undefined),
    };
  },
  async resolve(state: VarlockResolverState) {
    const keyId = localEncrypt.DEFAULT_KEY_ID;

    if (state.mode === 'decrypt') {
      // dispatch on the reference scheme before touching any backend, so an
      // unknown scheme reads as such instead of failing to decrypt garbage
      let reference;
      try {
        reference = parseVarlockReference(state.payload);
      } catch (err) {
        throw new ResolutionError(
          err instanceof Error ? err.message : String(err),
          { tip: 'This value may have been written by a newer version of varlock. Try upgrading.' },
        );
      }

      const ciphertext = reference.payload;
      try {
        return await enqueueDecrypt(ciphertext, keyId, {
          itemKey: state.itemKey,
          sourceFilePath: state.sourceFilePath,
        });
      } catch (err) {
        // Re-throw ResolutionErrors (e.g. batch cancellation) as-is
        if (err instanceof ResolutionError) throw err;

        // The unlock questions have their own answers. None of these mean the
        // value is corrupt, so none of them should point at a key mismatch.
        if (err instanceof localEncrypt.UnlockDeclinedError) {
          throw new ResolutionError('Unlock was declined', {
            tip: 'Run the command again and approve the unlock to decrypt these values.',
          });
        }
        if (err instanceof localEncrypt.UnlockNoUiError) {
          throw new ResolutionError(err.message, {
            tip: [
              'Unlocking needs a graphical session to show the panel on, so this cannot run over plain SSH.',
              'For a headless or CI host, create a key that needs no presence check:',
              '  varlock-local-encrypt generate-key --key-id <id> --no-auth',
            ].join('\n'),
          });
        }
        if (err instanceof localEncrypt.StaleDaemonError) {
          throw new ResolutionError(err.message, {
            tip: 'The native helper is older than this varlock. Reinstall to get a matching one.',
          });
        }
        // An identity-encrypted value somewhere that cannot open one is a
        // capability gap, not a corrupt value: say so.
        if (err instanceof localEncrypt.IdentityBackendUnsupportedError) {
          throw new ResolutionError(err.message, {
            tip: 'Run `varlock encrypt --upgrade` from native Windows, or keep these values device-encrypted.',
          });
        }
        if (err instanceof localEncrypt.IdentityWrapMissingError) {
          throw new ResolutionError(err.message, {
            tip: 'Set the value again on this machine with `varlock encrypt` or `KEY=varlock(prompt)`.',
          });
        }
        if (err instanceof localEncrypt.IdentityNotFoundError) {
          throw new ResolutionError(err.message, {
            tip: 'This value was encrypted to an identity key that is not on this machine.',
          });
        }

        const backend = localEncrypt.getBackendInfo();
        throw new ResolutionError(
          `Decryption failed: ${err instanceof Error ? err.message : err}`,
          {
            tip: [
              `Backend: ${backend.type} (${backend.hardwareBacked ? 'hardware-backed' : 'file-based'})`,
              'This usually means the value was encrypted with a different key or backend.',
              'Set a new value using `varlock encrypt` or `KEY=varlock(prompt)`.',
            ].join('\n'),
          },
        );
      }
    }

    // Prompt mode: enqueued into the unified batch so prompts run before decrypts
    // and cancellation propagates to all remaining items.
    const { itemKey, sourceFilePath } = state;
    return enqueuePrompt(keyId, async () => {
      const backend = localEncrypt.getBackendInfo();

      // Use daemon's native dialog on macOS Secure Enclave.
      //
      // Only the Swift daemon has `prompt-secret`, because only it draws the
      // dialog. The Rust daemon deliberately has no such op: on Windows and
      // Linux the value is typed into the terminal below and handed to the
      // daemon's `encrypt` op instead. That asymmetry is intentional and the two
      // daemons are not meant to converge here, so do not "fix" one to match the
      // other. Either way the recipient is the identity public key, so the
      // daemon returns a v2 payload.
      if (backend.type === 'secure-enclave' && backend.biometricAvailable) {
        const client = localEncrypt.getDaemonClient();
        const ciphertext = await client.promptSecret({
          itemKey,
          keyId,
          identityPublicKey: await localEncrypt.getEncryptionIdentityPublicKey(keyId),
          message: `Enter the secret value for ${itemKey}:`,
        });

        if (!ciphertext) {
          throw new ResolutionError('Secret input was cancelled', {
            tip: 'Run varlock again and enter a value, or replace prompt=1 with an encrypted value',
          });
        }

        const writeBackResult = writeBackEncryptedValue(itemKey, ciphertext, sourceFilePath);
        if (!writeBackResult.updated) {
          if (writeBackResult.reason === 'missing-source-file') {
            throw new ResolutionError(`Unable to persist encrypted value for ${itemKey}`, {
              tip: 'varlock(prompt=1) can only persist values from file-backed sources. Use `varlock encrypt` to generate an encrypted value manually.',
            });
          }
          if (writeBackResult.reason === 'non-regular-source-file') {
            throw new ResolutionError(`Unable to persist encrypted value for ${itemKey}`, {
              tip: `${sourceFilePath} is not a regular file (FIFO/pipe), so varlock cannot write back to it.`,
            });
          }

          throw new ResolutionError(`Unable to persist encrypted value for ${itemKey}`, {
            tip: `Could not find a writable \`${itemKey}=varlock(...)\` entry to update in ${sourceFilePath}.`,
          });
        }

        // Reading back the value the user just typed. It can cost an unlock, so
        // the panel gets the same one-value-in-one-file description the batch
        // path builds for itself.
        return localEncrypt.decryptValue(ciphertext, keyId, {
          display: {
            ...projectDisplay(),
            keys: {
              [keyId]: {
                valueCount: 1,
                sources: [
                  {
                    kind: 'file',
                    path: displayFilePath(sourceFilePath),
                    entries: [{ name: itemKey }],
                  },
                ],
              },
            },
          },
        });
      }

      // Terminal prompt for file-based backend
      if (!process.stdout.isTTY || !process.stdin.isTTY) {
        throw new ResolutionError(
          `No encrypted value found for ${itemKey}`,
          {
            tip: `Run \`varlock encrypt --file ${sourceFilePath || '<your-env-file>'}\` to encrypt this value interactively.`,
          },
        );
      }

      const rawValue = await prompts.password({ message: `Enter the secret value for ${itemKey}:`, hint: 'for multi-line values, use `varlock encrypt`' });
      const isCanceled = typeof rawValue !== 'string';
      if (isCanceled || !rawValue) {
        throw new ResolutionError('Secret input was cancelled', {
          tip: 'Run varlock again and enter a value, or replace prompt=1 with an encrypted value',
        });
      }

      const ciphertext = await encryptCapturedSecret(rawValue, keyId);
      const writeBackResult = writeBackEncryptedValue(itemKey, ciphertext, sourceFilePath);

      if (!writeBackResult.updated) {
        if (writeBackResult.reason === 'missing-source-file') {
          throw new ResolutionError(`Unable to persist encrypted value for ${itemKey}`, {
            tip: 'varlock(prompt=1) can only persist values from file-backed sources. Use `varlock encrypt` to generate an encrypted value manually.',
          });
        }
        if (writeBackResult.reason === 'non-regular-source-file') {
          throw new ResolutionError(`Unable to persist encrypted value for ${itemKey}`, {
            tip: `${sourceFilePath} is not a regular file (FIFO/pipe), so varlock cannot write back to it.`,
          });
        }

        throw new ResolutionError(`Unable to persist encrypted value for ${itemKey}`, {
          tip: `Could not find a writable \`${itemKey}=varlock(...)\` entry to update in ${sourceFilePath}.`,
        });
      }

      return rawValue;
    });
  },
});
