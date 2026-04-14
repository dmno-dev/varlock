import { define } from 'gunshi';
import { isCancel, password } from '@clack/prompts';
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
import { multiselect } from '../helpers/prompts';
import { gracefulExit } from 'exit-hook';
import * as localEncrypt from '../../lib/local-encrypt';

export const commandSpec = define({
  name: 'encrypt',
  description: 'Encrypt a value using device-local encryption',
  args: {
    'key-id': {
      type: 'string',
      description: 'Encryption key ID (default: varlock-default)',
      default: 'varlock-default',
    },
    file: {
      type: 'string',
      description: 'Path to a .env file — encrypts all sensitive plaintext values in-place',
    },
  },
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

  // Encrypt each value and write back using string replacement on the raw file.
  // We re-read each time since prior replacements modify the file.
  let encryptedCount = 0;
  for (const item of filteredItems) {
    const ciphertext = await localEncrypt.encryptValue(item.value, keyId);
    const prefixed = `local:${ciphertext}`;

    const currentContents = fs.readFileSync(resolvedPath, 'utf-8');
    // Match the line for this key and replace the static value with varlock("local:...")
    const escaped = item.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^(${escaped}\\s*=\\s*).*$`, 'm');
    const updatedContents = currentContents.replace(pattern, `$1varlock("${prefixed}")`);

    if (updatedContents !== currentContents) {
      fs.writeFileSync(resolvedPath, updatedContents);
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

  const filePath = ctx.values.file;

  // --file mode: encrypt all sensitive plaintext values in a .env file
  if (filePath) {
    await encryptFile(keyId, filePath);
    return;
  }

  // Single-value mode — read from stdin if piped, otherwise prompt interactively.
  // Avoids putting secrets in shell history (e.g. `echo $SECRET | varlock encrypt`).
  console.log('');

  let rawValue: string;
  if (!process.stdin.isTTY) {
    const chunks: Array<Buffer> = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    rawValue = Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/, '');
    if (!rawValue) {
      throw new CliExitError('No value received on stdin');
    }
  } else {
    const prompted = await password({ message: 'Enter the value you want to encrypt' });
    if (isCancel(prompted)) return gracefulExit();
    rawValue = prompted;
  }

  try {
    const ciphertext = await localEncrypt.encryptValue(rawValue, keyId);

    console.log('\nCopy this into your .env.local file and rename the key appropriately:\n');
    console.log(`SOME_SENSITIVE_KEY=varlock("local:${ciphertext}")`);
  } catch (err) {
    if (err instanceof CliExitError) throw err;
    throw new CliExitError(
      `Encryption failed: ${err instanceof Error ? err.message : err}`,
    );
  }
};
