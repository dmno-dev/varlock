/**
 * Built-in varlock() resolver function.
 *
 * Replaces the plugin-based resolver from @varlock/secure-enclave-plugin.
 * Works cross-platform using the local-encrypt abstraction layer.
 */

import fs from 'node:fs';
import { createResolver, Resolver } from '../../env-graph/lib/resolver';
import { ResolutionError, SchemaError } from '../../env-graph/lib/errors';
import * as localEncrypt from './index';

const LOCAL_PREFIX = 'local:';
const PLUGIN_ICON = 'mdi:fingerprint';

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type VarlockResolverState = {
  mode: 'decrypt';
  payload: string;
} | {
  mode: 'prompt';
  itemKey: string;
  sourceFilePath: string | undefined;
};

function writeBackEncryptedValue(itemKey: string, ciphertext: string, sourceFilePath: string | undefined) {
  if (!sourceFilePath) return;
  const currentContents = fs.readFileSync(sourceFilePath, 'utf-8');
  const pattern = new RegExp(`^(${escapeRegExp(itemKey)}\\s*=\\s*)varlock\\(prompt(?:=\\S*)?\\)`, 'm');
  const prefixedCiphertext = `${LOCAL_PREFIX}${ciphertext}`;
  const updatedContents = currentContents.replace(pattern, `$1varlock("${prefixedCiphertext}")`);
  if (updatedContents !== currentContents) {
    fs.writeFileSync(sourceFilePath, updatedContents);
  }
}

export const VarlockResolver: typeof Resolver = createResolver<VarlockResolverState>({
  name: 'varlock',
  label: 'Decrypt locally encrypted value',
  icon: PLUGIN_ICON,
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
    return { mode: 'decrypt', payload };
  },
  async resolve(state: VarlockResolverState) {
    // Ensure a key exists (first-time setup)
    await localEncrypt.ensureKey();

    if (state.mode === 'decrypt') {
      let ciphertext = state.payload;
      if (ciphertext.startsWith(LOCAL_PREFIX)) {
        ciphertext = ciphertext.slice(LOCAL_PREFIX.length);
      }
      try {
        return await localEncrypt.decryptValue(ciphertext);
      } catch (err) {
        const backend = localEncrypt.getBackendInfo();
        throw new ResolutionError(
          `Decryption failed: ${err instanceof Error ? err.message : err}`,
          {
            tip: [
              `Backend: ${backend.type} (${backend.hardwareBacked ? 'hardware-backed' : 'file-based'})`,
              'Make sure the encryption key has not been deleted.',
              'Run `varlock encrypt --help` for more info.',
            ].join('\n'),
          },
        );
      }
    }

    // Prompt mode: prompt user for secret, encrypt it, write back to file
    const { itemKey, sourceFilePath } = state;
    const backend = localEncrypt.getBackendInfo();

    // Use daemon's native dialog on macOS Secure Enclave
    if (backend.type === 'secure-enclave' && backend.biometricAvailable) {
      const { DaemonClient } = await import('./daemon-client');
      const client = new DaemonClient();
      const ciphertext = await client.promptSecret({
        itemKey,
        message: `Enter the secret value for ${itemKey}:`,
      });

      if (!ciphertext) {
        throw new ResolutionError('Secret input was cancelled', {
          tip: 'Run varlock again and enter a value, or replace prompt=1 with an encrypted value',
        });
      }

      writeBackEncryptedValue(itemKey, ciphertext, sourceFilePath);
      return localEncrypt.decryptValue(ciphertext);
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

    const { password, isCancel } = await import('@clack/prompts');
    const rawValue = await password({ message: `Enter the secret value for ${itemKey}:` });
    if (isCancel(rawValue) || !rawValue) {
      throw new ResolutionError('Secret input was cancelled', {
        tip: 'Run varlock again and enter a value, or replace prompt=1 with an encrypted value',
      });
    }

    const ciphertext = await localEncrypt.encryptValue(rawValue);
    writeBackEncryptedValue(itemKey, ciphertext, sourceFilePath);
    return rawValue;
  },
});
