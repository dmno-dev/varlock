import fs from 'node:fs/promises';
import { DotEnvFileDataSource, EnvGraph } from '@env-spec/env-graph';
import {
  envSpecUpdater, ParsedEnvSpecFile, ParsedEnvSpecStaticValue,
} from '@env-spec/parser';
import { StaticValueResolver } from '../../../../env-graph/src/lib/resolver';


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


export function ensureAllItemsExist(envGraph: EnvGraph, schemaFile: ParsedEnvSpecFile) {
  const addedItemKeys: Array<string> = [];
  for (const itemKey in envGraph.configSchema) {
    const item = envGraph.configSchema[itemKey];
    const itemInSchema = schemaFile.configItems.find((i) => i.key === itemKey);

    if (!itemInSchema) {
      if (addedItemKeys.length === 0) {
        envSpecUpdater.injectFromStr(schemaFile, [
          '',
          '# items added to schema by `varlock init`',
          '# that were missing in example, but detected in other env files',
          '# PLEASE REVIEW THESE!',
          '# ---',
          '',
        ].join('\n'), { location: 'end' });
      }
      addedItemKeys.push(itemKey);
      envSpecUpdater.injectFromStr(schemaFile, [`${itemKey}=`].join('\n'));
      const itemValue = (
        item.valueResolver instanceof StaticValueResolver && item.valueResolver.staticValue
      ) || '';
      inferItemDecorators(schemaFile, itemKey, String(itemValue));
    }
  }
}

export async function detectRedundantValues(envGraph: EnvGraph, opts: { delete?: boolean } = {}) {
  const schema = envGraph.schemaDataSource;
  if (!schema) return {};
  const redundantItemsBySourcePath: Record<string, Array<string>> = {};
  const schemaValues = schema.getStaticValues();
  for (const source of envGraph.dataSources) {
    if (source === schema) continue;
    // we'll skip example files, since it is expected to be deleted and full of redundant values
    if (source.type === 'example') continue;
    if (!(source instanceof DotEnvFileDataSource) || !source.parsedFile) continue;

    const sourceValues = source.getStaticValues();
    for (const [key, value] of Object.entries(sourceValues)) {
      if (schemaValues[key] !== value) continue;

      redundantItemsBySourcePath[source.fullPath] ||= [];
      redundantItemsBySourcePath[source.fullPath].push(key);
      if (opts.delete) {
        envSpecUpdater.deleteItem(source.parsedFile, key);
      }
    }

    if (opts.delete) {
      await fs.writeFile(source.fullPath, source.parsedFile.toString(), 'utf8');
    }
  }

  return redundantItemsBySourcePath;
}
