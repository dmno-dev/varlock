import { redactString } from './lib/redaction';

import type { SerializedEnvGraph } from '../../env-graph';
import { isBrowser } from '../lib/detect-runtime';
import { debug } from './lib/debug';

// TODO: would like to move all of the redaction utils out of this file
// but its complicated since it is imported by code that may be run in the backend and frontend
// but the patching code (which only runs in the backend) use these helper functions

// this does not cover all cases, but serves our needs so far for Next.js
function isString(s: any) {
  return Object.prototype.toString.call(s) === '[object String]';
}

const UNMASK_STR = '👁';


/** key value lookup of sensitive values to their redacted version */
let sensitiveSecretsMap: Record<string, { key: string, redacted: string }> = {};

type ReplaceFn = (match: string, pre: string, val: string, post: string) => string;
let redactorFindReplace: undefined | { find: RegExp, replace: ReplaceFn };

export function resetRedactionMap(graph: SerializedEnvGraph) {
  // reset map of { [sensitive] => redacted }
  sensitiveSecretsMap = {};
  for (const itemKey in graph.config) {
    const item = graph.config[itemKey];
    if (item.isSensitive && item.value && isString(item.value)) {
      // TODO: we want to respect masking settings from the schema (once added)
      const redacted = redactString(item.value);
      if (redacted) sensitiveSecretsMap[item.value] = { key: itemKey, redacted };
    }
  }
  // if no sensitive items exist, we dont need to do any redaction, but the redact fn is checking for undefined
  if (!Object.keys(sensitiveSecretsMap).length) {
    redactorFindReplace = undefined;
    return;
  }

  // reset find/replace regex+fn used for redacting secrets in strings
  const findRegex = new RegExp(
    [
      `(${UNMASK_STR} )?`,
      '(',
      Object.keys(sensitiveSecretsMap)
        // Escape special characters
        .map((s) => s.replace(/[()[\]{}*+?^$|#.,/\\\s-]/g, '\\$&'))
        // Sort for maximal munch
        .sort((a, b) => b.length - a.length)
        .join('|'),
      ')',
      `( ${UNMASK_STR})?`,
    ].join(''),
    'g',
  );

  const replaceFn: ReplaceFn = (match, pre, val, post) => {
    // the pre and post matches only will be populated if they were present
    // and they are used to unmask the secret - so we do not want to replace in this case
    if (pre && post) return match;
    return sensitiveSecretsMap[val].redacted;
  };
  redactorFindReplace = { find: findRegex, replace: replaceFn };
}


// While the module itself acts as a singleton to hold the current map of redacted values
// we expose only the below const to end users


/**
 * Redacts senstive config values from any string/array/object/etc
 *
 * NOTE - must be used only after varlock has loaded config
 * */
export function redactSensitiveConfig(o: any): any {
  if (!redactorFindReplace) return o;
  if (!o) return o;

  // TODO: handle more cases?
  // we can probably redact safely from a few other datatypes - like set,map,etc?
  // objects are a bit tougher
  if (Array.isArray(o)) {
    return o.map(redactSensitiveConfig);
  }
  // try to redact if it's a plain object - not necessarily great for perf...
  if (o && typeof (o) === 'object' && Object.getPrototypeOf(o) === Object.prototype) {
    try {
      return JSON.parse(redactSensitiveConfig(JSON.stringify(o)));
    } catch (err) {
      return o;
    }
  }

  const type = typeof o;
  if (type === 'string' || (type === 'object' && Object.prototype.toString.call(o) === '[object String]')) {
    return (o as string).replaceAll(redactorFindReplace.find, redactorFindReplace.replace);
  }

  return o;
}

/**
 * utility to unmask a secret/sensitive value when logging to the console
 * currently this only works on a single secret, not objects or aggregated strings
 * */
export function revealSensitiveConfig(secretStr: string) {
  // if redaction not enabled, we just return the secret itself
  if (!(globalThis as any)._varlockOrigWriteToConsoleFn) return secretStr;
  // otherwise we add some wrapper characters which will be removed by the patched console behaviour
  return `${UNMASK_STR} ${secretStr} ${UNMASK_STR}`;
}





// reusable leak scanning helper function, used by various integrations
export function scanForLeaks(
  toScan: string | ReadableStream | null,
  // optional additional information about what is being scanned to be used in error messages
  meta?: {
    method?: string,
    file?: string,
  },
) {
  debug('⚡️ varlock scanning for leaks');
  if (!toScan) return toScan;

  function scanStrForLeaks(strToScan: string) {
    // console.log('[varlock leak scanner] ', strToScan.substr(0, 100));

    // TODO: probably should use a single regex
    for (const sensitiveValue in sensitiveSecretsMap) {
      if (strToScan.includes(sensitiveValue)) {
        const itemKey = sensitiveSecretsMap[sensitiveValue].key;

        // error stack can gets awkwardly buried since we're so deep in the internals
        // so we'll write a nicer error message to help the user debug
        // eslint-disable-next-line no-console
        console.error([
          '',
          `🚨 ${'DETECTED LEAKED SENSITIVE CONFIG'} 🚨`,
          `> Config item key: ${itemKey}`,
          ...meta?.method ? [`> Scan method: ${meta.method}`] : [],
          ...meta?.file ? [`> File: ${meta.file}`] : [],
          '',
        ].join('\n'));

        throw new Error(`🚨 DETECTED LEAKED SENSITIVE CONFIG - ${itemKey}`);
      }
    }
  }

  // scan a string
  if (isString(toScan)) {
    scanStrForLeaks(toScan as string);
    return toScan;
  } else if (toScan instanceof Buffer) {
    scanStrForLeaks(toScan.toString());
    return toScan;
  // scan a ReadableStream by piping it through a scanner
  } else if (toScan instanceof ReadableStream) {
    if (toScan.locked) {
      // console.log('> stream already locked');
      return toScan;
    } else {
      // console.log('> stream will be scanned!');
    }
    const chunkDecoder = new TextDecoder();
    return toScan.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          const chunkStr = chunkDecoder.decode(chunk);
          scanStrForLeaks(chunkStr);
          controller.enqueue(chunk);
        },
      }),
    );
  }
  // other things may be passed in like Buffer... but we'll ignore for now
  return toScan;
}

// -----------




// --------------

let initializedEnv = false;
const envValues = {} as Record<string, any>;
export const varlockSettings = {} as Record<string, any>;

export function initVarlockEnv(opts?: {
  allowFail?: boolean,
}) {
  debug('⚡️ INIT VARLOCK ENV!', initializedEnv, !!(globalThis as any).__varlockLoadedEnv, !!process.env.__VARLOCK_ENV);

  if (isBrowser) {
    return;
  }


  let serializedEnvData: SerializedEnvGraph;
  // when we inject resolved config at build time, we store it here
  if ((globalThis as any).__varlockLoadedEnv) {
    serializedEnvData = (globalThis as any).__varlockLoadedEnv;

  // otherwise if we inject via `varlock run` or have already loaded, it will be in process.env
  } else if (process.env.__VARLOCK_ENV) {
    serializedEnvData = JSON.parse(process.env.__VARLOCK_ENV);
  } else {
    if (opts?.allowFail) return;
    // eslint-disable-next-line no-console
    console.error([
      '',
      '🚨 initVarlockEnv failed  🚨',
      'try rerunning your command via `varlock run`',
      '',
    ].join('\n'));
    throw new Error('initVarlockEnv failed');
  }
  Object.assign(varlockSettings, serializedEnvData.settings);
  resetRedactionMap(serializedEnvData);

  const setProcessEnv = true;

  for (const itemKey in serializedEnvData.config) {
    const itemValue = serializedEnvData.config[itemKey].value;
    envValues[itemKey] = itemValue;
    if (setProcessEnv && itemValue !== undefined) process.env[itemKey] = String(itemValue);
  }
  initializedEnv = true;
}

// we will attempt to call initVarlockEnv automatically, but in most cases it should be called explicitly
// note that if this is being imported in the browser, process.env may not exist, so we do this in a try/catch
try {
  if (!initializedEnv) {
    // if we are automatically loading because __VARLOCK_ENV is already set
    // then we assume process.env vars have also already been set (although might not harm anything?)
    initVarlockEnv({ allowFail: true });
  }
} catch (err) {
  // expected that this will fail when process.env does not exist
  // but we may want to look for specific errors
}



// some object keys are checked by various tools when handling arbitrary data, especially in templates
// because our proxy objects throw errors when unknown keys are accessed, this causes problems
// for now we can just filter out a these keys and it should be fairly harmless
// TODO: ideally this could be customized by the user, and not specific to vue
const IGNORED_PROXY_KEYS = [
  // vue - see https://github.com/vuejs/core/blob/70773d00985135a50556c61fb9855ed6b930cb82/packages/reactivity/src/ref.ts#L101
  '__v_isRef',
];


// this gets exported and then augmented by our type generation
// ideally we'd start with a loose type `Record<string,any>` and then override it with the actual schema
// so that if type generation was disabled, a user could still use `ENV`
// but TS wont let us, so instead we start with it being empty, which will cause type errors
// unless type generation is enabled
export interface TypedEnvSchema {}

const EnvProxy = new Proxy<TypedEnvSchema>({}, {
  get(target, prop) {
    // ignore symbols, as it likely an external tool checking something
    if (typeof prop === 'symbol') return;
    // special cases to avoid throwing on invalid keys
    if (IGNORED_PROXY_KEYS.includes(prop)) return;

    if (!isBrowser && !initializedEnv) {
      throw new Error('varlock ENV not initialized');
    }

    if (prop in envValues) return envValues[prop];
    if ((globalThis as any).__varlockThrowOnMissingKeys) {
      // during development, we can feed in extra metadata and show more helpful errors
      if ((globalThis as any).__varlockValidKeys && (globalThis as any).__varlockValidKeys.includes(prop)) {
        throw new Error(`\`ENV.${prop}\` exists, but is not available in this environment`);
      } else {
        throw new Error(`\`ENV.${prop}\` does not exist`);
      }
    }
    return undefined;
  },
});

export const ENV = EnvProxy;
