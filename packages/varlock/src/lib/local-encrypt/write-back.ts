/**
 * Shared utilities for writing back encrypted/resolved values to .env files.
 *
 * Uses the env-spec AST parser to safely update values.
 */

import fs from 'node:fs';
import { parseEnvSpecDotEnvFile } from '@env-spec/parser';

type WriteBackResult = { updated: boolean; reason?: 'missing-source-file' | 'item-not-found' };

/**
 * Update a config item's value in a .env file using AST-based replacement.
 */
export function writeBackValue(
  itemKey: string,
  newValueStr: string,
  sourceFilePath: string | undefined,
): WriteBackResult {
  if (!sourceFilePath) {
    return { updated: false, reason: 'missing-source-file' };
  }

  const currentContents = fs.readFileSync(sourceFilePath, 'utf-8');
  const file = parseEnvSpecDotEnvFile(currentContents);

  const item = file.configItems.find((i) => i.key === itemKey);
  if (!item) {
    return { updated: false, reason: 'item-not-found' };
  }

  // Parse a dummy line to get the correct AST value node
  const dummyFile = parseEnvSpecDotEnvFile(`_=${newValueStr}`);
  const dummyItem = dummyFile.configItems[0];
  if (!dummyItem?.value) {
    return { updated: false, reason: 'item-not-found' };
  }

  // Replace the value
  item.data.value = dummyItem.value;
  item.value = dummyItem.value;

  fs.writeFileSync(sourceFilePath, file.toString());
  return { updated: true };
}

