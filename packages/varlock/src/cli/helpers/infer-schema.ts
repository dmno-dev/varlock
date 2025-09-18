import fs from 'node:fs/promises';
import { DotEnvFileDataSource, EnvGraph, StaticValueResolver } from '../../../env-graph';
import {
  envSpecUpdater, ParsedEnvSpecFile, ParsedEnvSpecStaticValue,
} from '@env-spec/parser';


export type DetectedEnvFile = {
  fileName: string,
  fullPath: string,
  parsedFile: ParsedEnvSpecFile
};

const PUBLIC_PREFIXES = [
  'PUBLIC',
  'VITE',
  'NEXT_PUBLIC',
  'NUXT_PUBLIC',
];
const PUBLIC_KEYWORDS = ['PUBLIC'];
const SENSITIVE_KEYWORDS = [
  'SECRET',
  'API_KEY',
  'PASSWORD',
  'TOKEN',
  'PRIVATE',
  'CREDENTIALS',
];

function isValidUrl(val: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const u = new URL(val);
    return true;
  } catch (err) {
    return false;
  }
}

const EMAIL_REGEX = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
const VALID_NUMBER_REGEX = /^(0|([1-9][0-9]*))?(\.[0-9]+)?$/;


function inferItemDecorators(file: ParsedEnvSpecFile, itemKey: string, valueStr: string) {
  // infer @sensitive
  let itemIsPublic = false;
  if (PUBLIC_PREFIXES.some((prefix) => itemKey.startsWith(prefix))) itemIsPublic = true;
  if (PUBLIC_KEYWORDS.some((keyword) => itemKey.includes(keyword))) itemIsPublic = true;

  let itemIsSensitive = false;
  if (SENSITIVE_KEYWORDS.some((keyword) => itemKey.includes(keyword))) itemIsSensitive = true;

  if (itemIsPublic) {
    // not marking these for now, since we've already made the default not sensitive
    // envSpecUpdater.setItemDecorator(file, itemKey, 'sensitive', 'false');
  } else if (itemIsSensitive) {
    envSpecUpdater.setItemDecorator(file, itemKey, 'sensitive', 'true');
  }

  // infer @type
  // > from key
  if (itemKey === 'PORT' || itemKey.endsWith('_PORT')) {
    envSpecUpdater.setItemDecorator(file, itemKey, 'type', 'port');
  } else if (itemKey.endsWith('_EMAIL')) {
    envSpecUpdater.setItemDecorator(file, itemKey, 'type', 'email');
  } else if (itemKey.endsWith('_URL') || itemKey.endsWith('_URI')) {
    envSpecUpdater.setItemDecorator(file, itemKey, 'type', 'url');


  // > from value
  } else if (valueStr) {
    // move obvious examples to @example
    if (valueStr.startsWith('<') && valueStr.endsWith('>')) {
      envSpecUpdater.setItemDecorator(file, itemKey, 'example', valueStr);
      // remove example from value
    }

    if (valueStr === 'true' || valueStr === 'false') {
      envSpecUpdater.setItemDecorator(file, itemKey, 'type', 'boolean');
    } else if (EMAIL_REGEX.test(valueStr)) {
      envSpecUpdater.setItemDecorator(file, itemKey, 'type', 'email');
    } else if (valueStr !== '0' && valueStr !== '1' && VALID_NUMBER_REGEX.test(valueStr)) {
      envSpecUpdater.setItemDecorator(file, itemKey, 'type', 'number');
    } else if (isValidUrl(valueStr)) {
      envSpecUpdater.setItemDecorator(file, itemKey, 'type', 'url');
    }
    // TODO: more...
  }
}

export function inferSchemaUpdates(file: ParsedEnvSpecFile) {
  for (const item of file.configItems) {
    const valueStr = (
      item.value instanceof ParsedEnvSpecStaticValue && item.value.value?.toString()
    ) || '';
    // console.log(item.key, '-', valueStr);
    inferItemDecorators(file, item.key, valueStr);
  }
}


export function ensureAllItemsExist(schemaFile: ParsedEnvSpecFile, otherFiles: Array<DetectedEnvFile>) {
  const addedItemKeys: Array<string> = [];
  for (const otherFile of otherFiles) {
    for (const item of otherFile.parsedFile.configItems) {
      const itemInSchema = schemaFile.configItems.find((i) => i.key === item.key);
      if (itemInSchema) continue;

      if (addedItemKeys.length === 0) {
        envSpecUpdater.injectFromStr(schemaFile, [
          '',
          '# items added to schema by `varlock init`',
          '# that were missing in example, but detected in other .env files',
          '# PLEASE REVIEW THESE!',
          '# ---',
          '',
        ].join('\n'), { location: 'end' });
      }
      addedItemKeys.push(item.key);
      envSpecUpdater.injectFromStr(schemaFile, `${item.key}=`);
      const itemValue = (
        item.value instanceof ParsedEnvSpecStaticValue && item.value.value?.toString()
      ) || '';
      inferItemDecorators(schemaFile, item.key, String(itemValue));
    }
  }
}

export async function detectRedundantValues(
  schemaFile: ParsedEnvSpecFile,
  otherFiles: Record<string, DetectedEnvFile>,
  opts: { delete?: boolean } = {},
) {
  const redundantItemsBySourcePath: Record<string, Array<string>> = {};
  const schemaValues = schemaFile.toSimpleObj();
  for (const otherFile of Object.values(otherFiles)) {
    if (
      otherFile.fileName.startsWith('.env.schema')
      || otherFile.fileName.startsWith('.env.example')
      || otherFile.fileName.startsWith('.env.sample')
      || otherFile.fileName.startsWith('.env.default')
    ) continue;

    const otherFileValues = otherFile.parsedFile.toSimpleObj();
    for (const itemKey in otherFileValues) {
      if (!(itemKey in schemaValues)) continue;
      if (otherFileValues[itemKey] !== schemaValues[itemKey]) continue;

      redundantItemsBySourcePath[otherFile.fullPath] ||= [];
      redundantItemsBySourcePath[otherFile.fullPath].push(itemKey);
      if (opts.delete) {
        envSpecUpdater.deleteItem(otherFile.parsedFile, itemKey);
      }
    }

    if (opts.delete) {
      await fs.writeFile(otherFile.fullPath, otherFile.parsedFile.toString(), 'utf8');
    }
  }

  return redundantItemsBySourcePath;
}
