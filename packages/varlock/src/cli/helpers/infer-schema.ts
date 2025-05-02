import { envSpecUpdater, ParsedEnvSpecFile, ParsedEnvSpecStaticValue, parseEnvSpecDotEnvFile } from '@env-spec/parser';


const PUBLIC_PREFIXES = [
  'PUBLIC',
  'VITE',
  'NEXT_PUBLIC',
  'NUXT_PUBLIC',
];
const PUBLIC_KEYWORDS = [
  'PUBLIC',
];
const SENSITIVE_KEYWORDS = [
  'SECRET',
  'API_KEY',
  'PASSWORD',
  'TOKEN',
  'AUTH_TOKEN',
  'PRIVATE',
];

function isValidUrl(val: string) {
  try {
    new URL(val)
    return true;
  } catch (err) {
    return false;
  }
}

const EMAIL_REGEX = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
const VALID_NUMBER_REGEX = /^(0|([1-9][0-9]*))?(\.[0-9]+)?$/;

export function inferSchemaUpdates(file: ParsedEnvSpecFile) {
  for (const item of file.configItems) {
    const key = item.key;
    // infer @sensitive
    let itemIsPublic = false;
    if (PUBLIC_PREFIXES.some((prefix) => item.key.startsWith(prefix))) itemIsPublic = true;
    if (PUBLIC_KEYWORDS.some((keyword) => item.key.includes(keyword))) itemIsPublic = true;
    
    let itemIsSensitive = false;
    if (SENSITIVE_KEYWORDS.some((keyword) => item.key.includes(keyword))) itemIsSensitive = true;

    if (itemIsPublic) {
      // not marking these for now, since we've already made the default not sensitive
      // envSpecUpdater.setItemDecorator(file, item.key, 'sensitive', 'false');
    } else if (itemIsSensitive) {
      envSpecUpdater.setItemDecorator(file, item.key, 'sensitive', 'true');
    }

    const valueStr = item.value instanceof ParsedEnvSpecStaticValue && item.value.value?.toString() || '';
    console.log(key, '-',  valueStr);

    // infer @type
    // > from key
    if (key === 'PORT' || key.endsWith('_PORT')) {
      envSpecUpdater.setItemDecorator(file, item.key, 'type', 'port');
    } else if (key.endsWith('_EMAIL')) {
      envSpecUpdater.setItemDecorator(file, item.key, 'type', 'email');
    } else if (key.endsWith('_URL') || key.endsWith('_URI')) {
      envSpecUpdater.setItemDecorator(file, item.key, 'type', 'url');

    
    // > from value
    } else if (valueStr){
      // move obvious examples to @example
      if (valueStr.startsWith('<') && valueStr.endsWith('>')) {
        envSpecUpdater.setItemDecorator(file, item.key, 'example', valueStr);
        // remove example from value
      }

      if (valueStr === 'true' || valueStr === 'false') {
        envSpecUpdater.setItemDecorator(file, item.key, 'type', 'boolean');
      } else if (EMAIL_REGEX.test(valueStr)) {
        envSpecUpdater.setItemDecorator(file, item.key, 'type', 'email');
      } else if (valueStr !== '0' && valueStr !== '1' && VALID_NUMBER_REGEX.test(valueStr)) {
        envSpecUpdater.setItemDecorator(file, item.key, 'type', 'number');
      } else if (isValidUrl(valueStr)) {
        envSpecUpdater.setItemDecorator(file, item.key, 'type', 'url');
      }
      // TODO: more...
    }

  }
}
