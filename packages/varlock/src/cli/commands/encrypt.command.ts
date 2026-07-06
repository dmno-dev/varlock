import { define } from 'gunshi';
import { isCancel } from '@clack/prompts';
import ansis from 'ansis';
import path from 'node:path';
import fs from 'node:fs';

import {
  ParsedEnvSpecStaticValue,
  ParsedEnvSpecFunctionCall,
} from '@env-spec/parser';
import { FileBasedDataSource } from '../../env-graph';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { multiselect, password } from '../helpers/prompts';
import { gracefulExit } from 'exit-hook';
import * as localEncrypt from '../../lib/local-encrypt';
import { writeBackValue } from '../../lib/local-encrypt/write-back';

export const commandSpec = define({
  name: 'encrypt',
  description: 'Encrypt a value using device-local encryption',
  args: {
    'key-id': {
      type: 'string',
      description: 'Encryption key ID',
      default: 'varlock-default',
      // Hidden until multi-key round-trips: the varlock("local:...") reference does not
      // encode a keyId, and the load-time resolver always decrypts with the default key,
      // so encrypting with a non-default key produces values that cannot be loaded back.
      hidden: true,
    },
    file: {
      type: 'string',
      description: 'Path to a .env file — encrypts all sensitive plaintext values in-place',
    },
  },
  examples: `
Encrypts a value using device-local encryption (Secure Enclave / TPM / file-based),
producing a varlock("local:...") reference that is safe to commit.

Single-value mode reads from stdin (or prompts interactively) so secrets stay out of
shell history. --file mode encrypts all @sensitive plaintext values in a .env file in place.

Examples:
  echo "$MY_SECRET" | varlock encrypt    # Encrypt a value from stdin (non-interactive, agent-friendly)
  varlock encrypt                        # Prompt interactively for a value
  varlock encrypt --file .env.local      # Encrypt @sensitive plaintext values in a file in-place
`.trim(),
});

async function encryptFile(keyId: string, filePath: string) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new CliExitError(`File not found: ${resolvedPath}`);
  }

  // Load the full env graph and resolve to get sensitivity info from the schema
  const envGraph = await loadVarlockEnvGraph();
  await envGraph.resolveEnvValues();

  // Find the data source matching the target file
  const targetSource = envGraph.sortedDataSources.find(
    (s) => s instanceof FileBasedDataSource && s.fullPath === resolvedPath,
  ) as FileBasedDataSource | undefined;

  if (!targetSource) {
    throw new CliExitError(
      `File "${filePath}" is not part of the loaded env graph`,
      { suggestion: 'Make sure the file is in the project directory or imported by your schema.' },
    );
  }

  // Find sensitive items that have plaintext static values in this file
  const itemsToEncrypt: Array<{ key: string; value: string }> = [];

  for (const [key, itemDef] of Object.entries(targetSource.configItemDefs)) {
    const graphItem = envGraph.configSchema[key];
    if (!graphItem?.isSensitive) continue;

    // Skip items already using varlock() or another function call
    if (itemDef.parsedValue instanceof ParsedEnvSpecFunctionCall) continue;

    // Only encrypt items with actual static string values
    if (!(itemDef.parsedValue instanceof ParsedEnvSpecStaticValue)) continue;
    const val = itemDef.parsedValue.unescapedValue;
    if (val === undefined || val === '' || typeof val !== 'string') continue;

    itemsToEncrypt.push({ key, value: val });
  }

  if (itemsToEncrypt.length === 0) {
    console.log('No sensitive plaintext values found to encrypt.');
    return;
  }

  console.log('Only items marked as @sensitive in the schema are shown.');
  console.log('If a key is missing, add @sensitive to it in your schema file.\n');

  const selected = await multiselect({
    message: `Confirm values to encrypt in ${filePath} ${ansis.gray('(use arrows, space to toggle, enter to confirm)')}`,
    options: itemsToEncrypt.map((item) => ({
      value: item.key,
      label: item.key,
    })),
    initialValues: itemsToEncrypt.map((item) => item.key),
  });

  if (isCancel(selected)) return gracefulExit();

  const selectedKeys = new Set(selected as Array<string>);
  const filteredItems = itemsToEncrypt.filter((item) => selectedKeys.has(item.key));

  if (filteredItems.length === 0) {
    console.log('No items selected.');
    return;
  }

  console.log('');

  let encryptedCount = 0;
  for (const item of filteredItems) {
    const ciphertext = await localEncrypt.encryptValue(item.value, keyId);
    const result = writeBackValue(item.key, `varlock("local:${ciphertext}")`, resolvedPath);

    if (result.updated) {
      encryptedCount++;
      console.log(`  Encrypted: ${item.key}`);
    }
  }

  console.log(`\nEncrypted ${encryptedCount} value${encryptedCount !== 1 ? 's' : ''} in ${filePath}`);
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const keyId = String(ctx.values['key-id'] || 'varlock-default');
  const backend = localEncrypt.getBackendInfo();

  try {
    await localEncrypt.ensureKey(keyId);
  } catch (err) {
    if (err instanceof CliExitError) throw err;
    throw new CliExitError(
      `Failed to check/create encryption key: ${err instanceof Error ? err.message : err}`,
    );
  }

  console.log(`Using ${backend.type} backend (${backend.hardwareBacked ? 'hardware-backed' : 'file-based'})`);

  // Hardware-backed but no presence gate → decryption is unattended (headless/CI hosts).
  if (backend.hardwareBacked && !backend.biometricAvailable) {
    let platformHint = '';
    if (process.platform === 'linux') {
      platformHint = '\nTo require presence on decrypt, run: sudo varlock-local-encrypt setup --linux-biometrics';
    } else if (process.platform === 'win32' || process.env.WSL_DISTRO_NAME) {
      platformHint = '\nConfigure Windows Hello to require fingerprint/PIN on interactive decrypts.';
    }
    console.log(
      '\nNote: no presence gate is configured, so values decrypt unattended (suitable for headless/CI hosts).'
      + `\nThis protects secrets at rest, but not against a process already running as your user.${platformHint}`,
    );
  }

  const filePath = ctx.values.file;

  // --file mode: encrypt all sensitive plaintext values in a .env file
  if (filePath) {
    await encryptFile(keyId, filePath);
    return;
  }

  // Single-value mode — read from stdin if piped, otherwise prompt interactively.
  // Avoids putting secrets in shell history (e.g. `echo $SECRET | varlock encrypt`).
  console.log('');

  let ciphertext: string;

  if (!process.stdin.isTTY) {
    const chunks: Array<Buffer> = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const rawValue = Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/, '');
    if (!rawValue) {
      throw new CliExitError('No value received on stdin');
    }
    try {
      ciphertext = await localEncrypt.encryptValue(rawValue, keyId);
    } catch (err) {
      if (err instanceof CliExitError) throw err;
      throw new CliExitError(
        `Encryption failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  } else if (backend.biometricAvailable && backend.type === 'secure-enclave') {
    // Use native secure input dialog (supports multi-line paste) — macOS Secure Enclave only.
    // Windows Hello (windows-tpm) and WSL2 do not support the prompt-secret daemon action;
    // those backends fall through to the terminal prompt below.
    const client = localEncrypt.getDaemonClient();
    const result = await client.promptSecret({ keyId });
    if (!result) {
      return gracefulExit();
    }
    ciphertext = result;
  } else {
    const prompted = await password({ message: 'Enter the value you want to encrypt', hint: 'for multi-line values, pipe via stdin' });
    if (isCancel(prompted)) return gracefulExit();
    try {
      ciphertext = await localEncrypt.encryptValue(prompted, keyId);
    } catch (err) {
      if (err instanceof CliExitError) throw err;
      throw new CliExitError(
        `Encryption failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  console.log('\nCopy this into your .env.local file and rename the key appropriately:\n');
  console.log(`SOME_SENSITIVE_KEY=varlock("local:${ciphertext}")`);
};
