import { redactString } from './lib/redaction';

import type { SerializedEnvGraph } from '../env-graph';
import { isBrowser } from '../lib/detect-runtime';
import { envValueMatchesBlobItem } from '../lib/injected-env-provenance';
import { debug } from './lib/debug';

// TODO: would like to move all of the redaction utils out of this file
// but its complicated since it is imported by code that may be run in the backend and frontend
// but the patching code (which only runs in the backend) use these helper functions

// this does not cover all cases, but serves our needs so far for Next.js
function isString(s: any) {
  return Object.prototype.toString.call(s) === '[object String]';
}

const UNMASK_STR = '👁';


// Store redaction state on globalThis so all module instances (e.g., multiple CJS bundles
// in Turbopack's middleware context) share the same redaction map.
// Without this, the module instance that patches console.log may have an empty map
// while a different instance has the populated one.
type RedactionState = {
  // `preventLeaks: false` means the value is still redacted in logs but skipped by the leak scanner
  sensitiveSecretsMap: Record<string, { key: string, redacted: string, preventLeaks: boolean }>,
  redactorFindReplace: undefined | { find: RegExp, replace: ReplaceFn },
};
type ReplaceFn = (match: string, pre: string, val: string, post: string) => string;

const REDACTION_STATE_KEY = '__varlockRedactionState';
function getRedactionState(): RedactionState {
  if (!(globalThis as any)[REDACTION_STATE_KEY]) {
    (globalThis as any)[REDACTION_STATE_KEY] = {
      sensitiveSecretsMap: {},
      redactorFindReplace: undefined,
    };
  }
  return (globalThis as any)[REDACTION_STATE_KEY];
}

/** collect every redactable string within a (possibly composite) sensitive value -
 * for arrays/objects each string element registers individually, so leaking a single
 * element (not just the whole serialized value) is still caught */
function collectSensitiveStrings(value: any, collected: Array<string> = []): Array<string> {
  if (isString(value) && value) {
    collected.push(value as string);
  } else if (Array.isArray(value)) {
    for (const el of value) collectSensitiveStrings(el, collected);
  } else if (value && typeof value === 'object') {
    for (const key in value) collectSensitiveStrings(value[key], collected);
  }
  return collected;
}

export function resetRedactionMap(graph: SerializedEnvGraph) {
  const state = getRedactionState();
  // reset map of { [sensitive] => redacted }
  state.sensitiveSecretsMap = {};
  for (const itemKey in graph.config) {
    const item = graph.config[itemKey];
    if (!item.isSensitive || !item.value) continue;
    const sensitiveStrings = collectSensitiveStrings(item.value);
    // the flat serialized form also registers (e.g. a JSON-encoded element may not
    // match its raw form once escaped)
    if (item.envStr) sensitiveStrings.push(item.envStr);
    for (const sensitiveStr of sensitiveStrings) {
      // TODO: we want to respect masking settings from the schema (once added)
      const redacted = redactString(sensitiveStr);
      // preventLeaks defaults to true; `@sensitive={preventLeaks=false}` opts the item
      // out of leak scanning while still keeping it redacted in logs
      if (redacted) {
        state.sensitiveSecretsMap[sensitiveStr] = {
          key: itemKey, redacted, preventLeaks: item.preventLeaks !== false,
        };
      }
    }
  }
  // if no sensitive items exist, we dont need to do any redaction, but the redact fn is checking for undefined
  if (!Object.keys(state.sensitiveSecretsMap).length) {
    state.redactorFindReplace = undefined;
    return;
  }

  // reset find/replace regex+fn used for redacting secrets in strings
  const findRegex = new RegExp(
    [
      `(${UNMASK_STR} )?`,
      '(',
      Object.keys(state.sensitiveSecretsMap)
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
    return state.sensitiveSecretsMap[val].redacted;
  };
  state.redactorFindReplace = { find: findRegex, replace: replaceFn };
}

/**
 * Returns the length of the longest suffix of `str` that is a partial match (proper prefix)
 * of a sensitive value. Used by streaming redaction to hold back trailing characters that
 * may be the beginning of a secret split across chunk boundaries.
 */
export function getRedactionHoldbackLength(str: string): number {
  const { sensitiveSecretsMap } = getRedactionState();
  const sensitiveValues = Object.keys(sensitiveSecretsMap);
  if (!sensitiveValues.length || !str.length) return 0;
  let longestValueLength = 0;
  for (const v of sensitiveValues) {
    if (v.length > longestValueLength) longestValueLength = v.length;
  }
  // longest suffix worth checking is one char short of a full secret
  // (a full secret at the end of `str` will be caught by normal redaction)
  const maxCheckLength = Math.min(str.length, longestValueLength - 1);
  for (let len = maxCheckLength; len > 0; len--) {
    const suffix = str.slice(str.length - len);
    for (const v of sensitiveValues) {
      if (v.length > len && v.startsWith(suffix)) return len;
    }
  }
  return 0;
}

/** Returns diagnostic info about the current redaction state (safe to expose — no secrets) */
export function getRedactionMapInfo() {
  const state = getRedactionState();
  return {
    sensitiveItemCount: Object.keys(state.sensitiveSecretsMap).length,
    hasRedactorRegex: !!state.redactorFindReplace,
  };
}


// While the module itself acts as a singleton to hold the current map of redacted values
// we expose only the below const to end users


function isErrorLike(o: any) {
  if (o instanceof Error) return true;

  // Cross-realm errors fail instanceof. Find the realm's Error.prototype without relying on
  // Object.prototype.toString, which can be masked by an own Symbol.toStringTag.
  let prototype = Object.getPrototypeOf(o);
  while (prototype) {
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    if (
      typeof constructor === 'function'
      && constructor.name === 'Error'
      && Object.prototype.hasOwnProperty.call(prototype, 'message')
      && Object.getOwnPropertyDescriptor(prototype, 'name')?.value === 'Error'
    ) return true;
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}

function redactPropertyKey(key: string | symbol, seen: Map<any, any>): string | symbol {
  if (typeof key === 'string') return redactValue(key, seen); // eslint-disable-line no-use-before-define
  if (key.description === undefined) return key;
  const redactedDescription = redactValue(key.description, seen); // eslint-disable-line no-use-before-define
  return redactedDescription === key.description ? key : Symbol(redactedDescription);
}

/** copies own props from source to target, redacting keys and values - returns whether anything changed */
function redactAssignProps(source: any, target: any, keys: Array<string | symbol>, seen: Map<any, any>): boolean {
  let changed = false;
  for (const key of keys) {
    const redactedKey = redactPropertyKey(key, seen);
    if (redactedKey !== key) changed = true;
    let value: any;
    try {
      value = source[key];
    } catch (getterError) {
      continue; // a getter that throws - nothing we can safely read or copy
    }
    const redactedValue = redactValue(value, seen); // eslint-disable-line no-use-before-define
    if (redactedValue !== value) changed = true;
    target[redactedKey] = redactedValue;
  }
  return changed;
}

const ARRAY_INDEX_KEY_REGEX = /^(?:0|[1-9]\d*)$/;

/** enumerable own string/symbol keys that a console inspector would print (excluding array indices) */
function inspectableOwnKeys(o: any, skipIndices: boolean): Array<string | symbol> {
  return [
    ...Object.keys(o).filter((key) => !(
      skipIndices && ARRAY_INDEX_KEY_REGEX.test(key) && Number(key) < o.length
    )),
    ...Object.getOwnPropertySymbols(o).filter((s) => Object.prototype.propertyIsEnumerable.call(o, s)),
  ];
}

/**
 * Errors need special handling - their `message`/`stack` are non-enumerable so they do not
 * survive a JSON round-trip, and their prototype is not `Object.prototype` so they used to
 * fall through redaction untouched. That leaks secrets anywhere the console output is
 * serialized from the object itself rather than from a pre-formatted string - edge runtimes
 * (Cloudflare Workers, Vercel Edge), or any platform that has already patched console.log.
 *
 * We build a redacted copy instead of mutating the error, since the caller may still be
 * using it. The copy is a real Error carrying the original prototype, so `instanceof` checks
 * and console formatting keep working.
 * */
function redactError(err: any, seen: Map<any, any>): any {
  // registered up front so circular `cause` chains (and repeat references) resolve
  // to the copy rather than recursing forever or falling back to the raw error
  if (seen.has(err)) return seen.get(err);
  const copy = new Error();
  Object.setPrototypeOf(copy, Object.getPrototypeOf(err));
  seen.set(err, copy);

  const keys: Array<string | symbol> = [
    ...Object.getOwnPropertyNames(err),
    ...Object.getOwnPropertySymbols(err),
  ];
  // `message`/`stack` are not own properties in every runtime, but always need redacting
  for (const inheritedKey of ['message', 'stack']) {
    if (!keys.includes(inheritedKey)) keys.push(inheritedKey);
  }

  let changed = false;
  for (const key of keys) {
    const redactedKey = redactPropertyKey(key, seen);
    if (redactedKey !== key) changed = true;
    let value: any;
    try {
      value = err[key];
    } catch (getterError) {
      continue; // a getter that throws - nothing we can safely read or copy
    }
    const redactedValue = redactValue(value, seen); // eslint-disable-line no-use-before-define
    if (redactedValue !== value) changed = true;
    try {
      Object.defineProperty(copy, redactedKey, {
        value: redactedValue,
        enumerable: Object.prototype.propertyIsEnumerable.call(err, key),
        writable: true,
        configurable: true,
      });
    } catch (defineError) {
      // skip anything we cannot redefine on the copy
    }
  }

  // nothing sensitive in here - hand back the original untouched
  if (!changed) {
    seen.set(err, err);
    return err;
  }
  return copy;
}

function redactValue(o: any, seen: Map<any, any>): any {
  const { redactorFindReplace } = getRedactionState();
  if (!redactorFindReplace) return o;
  if (!o) return o;

  // TODO: handle more cases?
  // we can probably redact safely from a few other datatypes - like set,map,etc?
  if (Array.isArray(o)) {
    if (seen.has(o)) return seen.get(o);
    const copy = new Array(o.length);
    // registered before recursing so circular references resolve to the copy
    // instead of recursing forever
    seen.set(o, copy);
    let changed = false;
    for (let i = 0; i < o.length; i++) {
      copy[i] = redactValue(o[i], seen);
      if (copy[i] !== o[i]) changed = true;
    }
    // custom props hung off the array are printed by console inspectors too
    if (redactAssignProps(o, copy, inspectableOwnKeys(o, true), seen)) changed = true;
    if (!changed) {
      seen.set(o, o);
      return o;
    }
    return copy;
  }
  if (isErrorLike(o)) {
    return redactError(o, seen);
  }
  // walk plain objects structurally rather than JSON round-tripping - JSON.stringify
  // drops non-enumerable props (hollowing out nested errors), mangles dates/undefined,
  // and throws on bigints and circular references
  // (null-prototype objects included - e.g. querystring.parse results)
  const objectPrototype = typeof (o) === 'object' ? Object.getPrototypeOf(o) : undefined;
  if (objectPrototype === Object.prototype || objectPrototype === null) {
    if (seen.has(o)) return seen.get(o);
    const copy: Record<string | symbol, any> = objectPrototype === null ? Object.create(null) : {};
    seen.set(o, copy);
    const changed = redactAssignProps(o, copy, inspectableOwnKeys(o, false), seen);
    // nothing sensitive in here - hand back the original untouched
    if (!changed) {
      seen.set(o, o);
      return o;
    }
    return copy;
  }

  const type = typeof o;
  if (type === 'string' || (type === 'object' && Object.prototype.toString.call(o) === '[object String]')) {
    return (o as string).replaceAll(redactorFindReplace.find, redactorFindReplace.replace);
  }

  return o;
}

/**
 * Redacts senstive config values from any string/array/object/error/etc
 *
 * NOTE - must be used only after varlock has loaded config
 * */
export function redactSensitiveConfig(o: any): any {
  const { redactorFindReplace } = getRedactionState();
  if (!redactorFindReplace) return o;
  if (!o) return o;
  return redactValue(o, new Map());
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
    const { sensitiveSecretsMap } = getRedactionState();

    // TODO: probably should use a single regex
    for (const sensitiveValue in sensitiveSecretsMap) {
      // items opted out via `@sensitive={preventLeaks=false}` are skipped by the scanner
      if (!sensitiveSecretsMap[sensitiveValue].preventLeaks) continue;
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
  // typeof guard needed: in edge runtime, this code runs as raw injected JS outside webpack's
  // module resolution, so bare `Buffer` is a ReferenceError even though edge supports it via
  // the sandbox's node:buffer module. This branch is unreachable in edge anyway (only strings/streams).
  } else if (typeof Buffer !== 'undefined' && toScan instanceof Buffer) {
    scanStrForLeaks(toScan.toString());
    return toScan;
  // scan a Uint8Array / ArrayBufferView / ArrayBuffer (common in Cloudflare Workers)
  } else if (ArrayBuffer.isView(toScan) || toScan instanceof ArrayBuffer) {
    const decoder = new TextDecoder();
    scanStrForLeaks(decoder.decode(toScan as any));
    return toScan;
  // scan a ReadableStream by piping it through a scanner
  } else if (toScan instanceof ReadableStream) {
    if (toScan.locked) {
      return toScan;
    }
    const chunkDecoder = new TextDecoder();
    // a sensitive value can be split across stream chunks, and the scan matches complete
    // values only - so each chunk is scanned with the tail of the previous one prepended
    let carry = '';
    return toScan.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          // stream mode holds an incomplete multi-byte char until the rest of it arrives
          const chunkStr = typeof chunk === 'string'
            ? chunk
            : chunkDecoder.decode(chunk, { stream: true });
          const toScanStr = carry + chunkStr;
          scanStrForLeaks(toScanStr);
          const carryLength = getRedactionHoldbackLength(toScanStr);
          carry = carryLength ? toScanStr.slice(-carryLength) : '';
          controller.enqueue(chunk);
        },
        flush() {
          const tail = chunkDecoder.decode();
          if (tail) scanStrForLeaks(carry + tail);
        },
      }),
    );
  }
  // other things may be passed in like Buffer... but we'll ignore for now
  return toScan;
}

// -----------




// --------------

// Like the redaction state above, env state lives on globalThis so all module instances
// share it. Bundlers can create multiple copies of this module in one process (e.g. Next.js
// bundles it into the app-router server code AND the pages-router code, while @next/env
// uses the node_modules copy) — env loads/reloads happen via one instance and ENV reads
// via another, so instance-local state would go stale or appear uninitialized.
type EnvState = {
  initialized: boolean,
  configHasErrors: boolean,
  // NOTE: these objects are mutated in place, never replaced — module instances
  // capture references to them at load time
  values: Record<string, any>,
  settings: Record<string, any>,
  /** snapshot of process.env before any varlock injection (captured by the first instance to load) */
  originalProcessEnv: Record<string, string | undefined>,
  /** keys injected into process.env by the last init/reload (undefined = never injected) */
  injectedProcessEnvKeys: Array<string> | undefined,
};

const processExists = !!globalThis.process;

const ENV_STATE_KEY = '__varlockEnvState';
function getEnvState(): EnvState {
  if (!(globalThis as any)[ENV_STATE_KEY]) {
    (globalThis as any)[ENV_STATE_KEY] = {
      initialized: false,
      configHasErrors: false,
      values: {},
      settings: {},
      originalProcessEnv: { ...processExists && process.env },
      injectedProcessEnvKeys: undefined,
    } satisfies EnvState;
  }
  const state: EnvState = (globalThis as any)[ENV_STATE_KEY];
  // the state object may have been created by an older copy of this module that
  // didn't track process.env injection — fill in what we can
  state.originalProcessEnv ||= { ...processExists && process.env };
  return state;
}

const envState = getEnvState();
const envValues = envState.values;
export const varlockSettings = envState.settings;

/**
 * Snapshot of process.env as it was before varlock injected any resolved values
 * into it (captured on first load, before the module-level auto-init below).
 *
 * Callers that need the caller's *real* env, distinct from values varlock itself
 * re-injected, must read this rather than the live `process.env`. In particular,
 * a nested `varlock` running under a parent `varlock run` sees the parent blob's
 * values re-injected into `process.env`, which would otherwise mask a
 * command-local override (`FOO=bar varlock ...`).
 */
export function getPreInjectionProcessEnv(): Record<string, string | undefined> {
  return getEnvState().originalProcessEnv;
}

export function initVarlockEnv(opts?: {
  allowFail?: boolean,
}) {
  debug('⚡️ INIT VARLOCK ENV!', envState.initialized, !!(globalThis as any).__varlockLoadedEnv, !!globalThis.process?.env.__VARLOCK_ENV);

  // normally we can just bail if we detect we are in the browser
  // however when front-end related tests, it may appear that we are in the browser but it is not
  // also some frameworks inject a process polyfill, others do not
  if (isBrowser && !globalThis.process?.env.__VARLOCK_ENV) {
    envState.initialized = true;
    // boot-time injected public+dynamic values: a server/entrypoint may write a
    // `<script>globalThis.__varlockPublicDynamicEnv = {...}</script>` tag into the
    // served HTML (e.g. a docker entrypoint using `varlock load --filter
    // '@dynamic,!@sensitive' --format json`), avoiding any endpoint fetch. Script
    // tags run before module scripts, so the global is set by the time we init.
    // Any later loadPublicDynamicEnv() call short-circuits once hydrated.
    const bootInjected = (globalThis as any).__varlockPublicDynamicEnv;
    if (bootInjected && typeof bootInjected === 'object' && !Array.isArray(bootInjected)) {
      // defined later in the module - safe because the module-level auto-init that
      // reaches this code runs at the very bottom of the file
      // eslint-disable-next-line no-use-before-define
      setPublicDynamicEnv(bootInjected);
    }
    return;
  }


  let serializedEnvData: SerializedEnvGraph;
  // when we inject resolved config at build time, we store it here
  // (decryption is handled by server-only init code before initVarlockEnv is called)
  if ((globalThis as any).__varlockLoadedEnv) {
    serializedEnvData = (globalThis as any).__varlockLoadedEnv;

  // otherwise if we inject via `varlock run` or have already loaded, it will be in process.env
  } else if (processExists && process.env.__VARLOCK_ENV) {
    // may still be an encrypted blob if edge init is decrypting asynchronously
    // (runtimes without node:crypto) — treat as not-yet-available rather than
    // exploding in JSON.parse
    if (process.env.__VARLOCK_ENV.startsWith('varlock:v1:')) {
      if (opts?.allowFail) return;
      throw new Error('[varlock] env blob is still encrypted — decryption has not completed yet');
    }
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
  // A payload baked into the build output carries `injectedAtBuild` INSIDE the
  // serialized blob (set by the injection preludes). It was resolved at BUILD time:
  // values in the actual runtime environment never had a chance to act as overrides
  // during that resolution, and they cannot be validated or coerced here (the blob
  // carries no schema/type info), so a runtime value that CONFLICTS with the blob would
  // be silently ignored. How that surfaces depends on the mode (i.e. user intent):
  // - 'fallback' (e.g. Next.js standalone booted where the varlock CLI is unreachable):
  //   nobody chose baking, so a conflict is a misconfiguration (`docker run -e
  //   REDIS_URL=...` supplying config this boot cannot honor). Fail closed with the
  //   remedy.
  // - 'explicit' (e.g. vite `ssrInjectMode: 'resolved-env'`): bake-into-build is the
  //   user's declared contract, so a stray runtime value must not kill a deploy working
  //   as configured. Surface it as a loud warning and boot on the baked values.
  // Absent values are fine either way: blob-only deployments (e.g. serverless)
  // intentionally deliver every value via the blob, so nothing is present in the
  // runtime env to check.
  // Because the flag lives inside the payload, it travels with the blob to child/worker
  // processes and can never outlive it: any fresh resolution produces an unflagged blob.
  const envInjectedAtBuild = !!serializedEnvData.injectedAtBuild;
  if (envInjectedAtBuild && processExists) {
    const conflictingKeys: Array<string> = [];
    for (const itemKey in serializedEnvData.config) {
      const ambientValue = envState.originalProcessEnv[itemKey];
      if (ambientValue === undefined) continue;
      const item = serializedEnvData.config[itemKey];
      if (envValueMatchesBlobItem(ambientValue, item, serializedEnvData.settings)) continue;
      // A coerced value (e.g. `FLAG=YES` -> boolean true) whose raw pre-coercion string
      // was not recorded (`overrideStr` is omitted for sensitive items on purpose, and
      // never recorded for values that came from files rather than overrides) cannot be
      // compared against the ambient raw form. Skip it rather than report a false
      // conflict (e.g. the same YES present at both build and runtime).
      if (item.overrideStr === undefined && item.value !== undefined && typeof item.value !== 'string') continue;
      conflictingKeys.push(itemKey);
    }
    if (conflictingKeys.length) {
      const explicitBake = serializedEnvData.injectedAtBuild === 'explicit';
      const conflictMessage = [
        '[varlock] ❌ Runtime environment conflicts with the build-time env snapshot',
        explicitBake
          ? `This build bakes its resolved env into the output, but the runtime environment provides different values for: ${conflictingKeys.join(', ')}`
          : `This server booted from env values baked into the build (the varlock CLI was not available to re-resolve), but the runtime environment provides different values for: ${conflictingKeys.join(', ')}`,
        'These runtime values cannot be validated or applied from a baked snapshot, so they are ignored by ENV.',
        ...explicitBake ? ['If these values should apply at runtime, re-resolve at boot instead of baking (e.g. `varlock run`, or a non-baking inject mode).'] : [
          'Fix: boot via `varlock run` (or make the varlock CLI available) so env is re-resolved and validated at boot.',
          'Already booting via `varlock run`? Then its injected __VARLOCK_ENV blob did not reach this process: make sure nothing in between strips env vars (wrapper scripts, process managers) and that you are not using `--inject vars`.',
          'To boot anyway using the baked values, set _VARLOCK_ALLOW_ENV_SNAPSHOT_CONFLICTS=1 (the runtime values for these keys will be ignored by ENV).',
        ],
      ].join('\n');
      const allowConflicts = ['1', 'true'].includes(process.env._VARLOCK_ALLOW_ENV_SNAPSHOT_CONFLICTS || '');
      if (explicitBake || allowConflicts) {
        // eslint-disable-next-line no-console
        console.error(conflictMessage.replace('❌', '⚠️'));
      } else {
        throw new Error(conflictMessage);
      }
    }
  }

  Object.assign(varlockSettings, serializedEnvData.settings);
  envState.configHasErrors = !!(serializedEnvData as any).errors;
  resetRedactionMap(serializedEnvData);

  // on reload, drop values for keys no longer in the config (deleted in place —
  // module instances hold references to the values object)
  for (const staleKey of Object.keys(envValues)) {
    if (!(staleKey in serializedEnvData.config)) delete envValues[staleKey];
  }

  const setProcessEnv = processExists && !serializedEnvData.settings?.disableProcessEnvInjection;
  const dynamicKeys: Array<string> = [];
  const publicDynamicKeys: Array<string> = [];

  // if we've already injected process.env vars in the past, we'll reset those now
  // (injection bookkeeping lives on the shared state so a reload flowing through a
  // different module instance than the one that injected still cleans up removed keys)
  if (setProcessEnv) {
    if (envState.injectedProcessEnvKeys) {
      for (const key of envState.injectedProcessEnvKeys) delete process.env[key];
      for (const key of Object.keys(envState.originalProcessEnv)) process.env[key] = envState.originalProcessEnv[key];
    }
    envState.injectedProcessEnvKeys = [];
  }

  for (const itemKey in serializedEnvData.config) {
    const item = serializedEnvData.config[itemKey];
    // isDynamic is omitted from the blob when it matches the sensitivity linkage
    if (item.isDynamic ?? item.isSensitive) {
      dynamicKeys.push(itemKey);
      if (!item.isSensitive) publicDynamicKeys.push(itemKey);
    }
    envValues[itemKey] = item.value;
    if (setProcessEnv) {
      // composite values (arrays/objects) carry their flat string form in `envStr`
      // (their serialization depends on type settings that don't travel in the blob)
      const envStrValue = item.envStr ?? (item.value === undefined ? undefined : String(item.value));
      if (envStrValue === undefined && !serializedEnvData.settings?.injectUndefinedAsEmpty) {
        // items that resolved to undefined are NOT injected (matching `varlock run` and the
        // documented `VAR=` semantics), so `process.env.X === undefined` and `?? 'fallback'`
        // work as expected. Any value already present can only be a stale parent-injected
        // echo (a genuine ambient value would have acted as an override and resolved to it),
        // so clear it rather than leave it shadowing the fresh resolution.
        // `@injectUndefinedAsEmpty` opts back into dotenv-style empty-string injection.
        // EXCEPT for build-baked blobs: no resolution happened in this process, so the
        // echo reasoning cannot hold and a present value is genuine runtime env. Deleting
        // it would destroy runtime-provided config (conflicts either threw above or were
        // explicitly allowed via _VARLOCK_ALLOW_ENV_SNAPSHOT_CONFLICTS), so leave it alone.
        if (!envInjectedAtBuild) delete process.env[itemKey];
      } else {
        envState.injectedProcessEnvKeys?.push(itemKey);
        process.env[itemKey] = envStrValue ?? '';
      }
    }
  }
  (globalThis as any).__varlockDynamicKeys = dynamicKeys;
  (globalThis as any).__varlockPublicDynamicKeys = publicDynamicKeys;
  envState.initialized = true;
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
export interface PublicTypedEnvSchema {}
type DynamicConfigAccessMeta = {
  key: string,
  isPublic: boolean,
};

/**
 * Dynamic key lists live on globalThis (like the rest of the shared env state):
 * `__varlockDynamicKeys` is written by initVarlockEnv (server-side only), while
 * `__varlockPublicDynamicKeys` is also injected into browser bundles by the
 * framework integrations. A missing global means "unknown" (e.g. hydration
 * before any init), which callers treat differently from known-and-empty.
 *
 * Sets are cached per underlying array reference since the ENV proxy checks
 * membership on every property access.
 */
const keySetCache: Record<string, { arr: unknown, set: Set<string> }> = {};
function getKeySetGlobal(name: string): Set<string> | undefined {
  const arr = (globalThis as any)[name];
  if (!Array.isArray(arr)) return undefined;
  const cached = keySetCache[name];
  if (cached && cached.arr === arr) return cached.set;
  const set = new Set<string>(arr.filter((k) => typeof k === 'string'));
  keySetCache[name] = { arr, set };
  return set;
}

export function getDynamicConfigKeys(): Array<string> {
  return [...getKeySetGlobal('__varlockDynamicKeys') ?? []];
}

export function getPublicDynamicConfigKeys(): Array<string> {
  return [...getKeySetGlobal('__varlockPublicDynamicKeys') ?? []];
}

function resolvePublicDynamicKeys(keys?: Array<string>): Array<string> {
  const allowed = getKeySetGlobal('__varlockPublicDynamicKeys');
  if (!keys?.length) return allowed ? [...allowed] : [];
  // when the declared key list is unknown we have nothing to check against,
  // so trust the caller's explicit list
  if (!allowed) return keys;
  return keys.filter((k) => allowed.has(k));
}

// set by varlock itself (e.g. the vite integration during `vite build`) so the
// ENV proxy can tell app code is executing during build/prerender rather than at
// runtime - an env var (not a global) because prerendering may happen in a
// child process (e.g. SvelteKit)
function getVarlockExecutionPhase() {
  return globalThis.process?.env?.__VARLOCK_EXECUTION_PHASE;
}

// user-set toggle to downgrade the build-time dynamic access guard to a warning
function getDynamicBuildAccessMode() {
  const mode = globalThis.process?.env?._VARLOCK_DYNAMIC_BUILD_ACCESS_MODE ?? 'error';
  return mode === 'warn' ? 'warn' : 'error';
}

function shouldGuardDynamicAccessDuringBuild() {
  const phase = getVarlockExecutionPhase();
  return phase === 'build' || phase === 'prerender';
}

function notifyDynamicConfigAccess(meta: DynamicConfigAccessMeta) {
  const onDynamicConfigAccess = (globalThis as any).__varlockOnDynamicConfigAccess;
  if (typeof onDynamicConfigAccess !== 'function') {
    debug(`[dynamic-access] no hook installed for ENV.${meta.key}`);
    return;
  }
  debug(`[dynamic-access] notifying hook for ENV.${meta.key} (isPublic=${meta.isPublic})`);
  onDynamicConfigAccess(meta);
}

const dynamicBuildAccessWarnedKeys = new Set<string>();
const DEFAULT_PUBLIC_DYNAMIC_ENV_ENDPOINT = '/__varlock/public-env';
let publicDynamicEnvLoadPromise: Promise<Partial<PublicTypedEnvSchema>> | undefined;
let hasLoadedPublicDynamicEnv = false;
let lastLoadedPublicDynamicEnv = {} as Record<string, unknown>;

function hasHydratedPublicDynamicEnv() {
  const publicDynamicKeys = getKeySetGlobal('__varlockPublicDynamicKeys');
  if (!publicDynamicKeys?.size) return false;
  return [...publicDynamicKeys].every((key) => key in envValues);
}

/**
 * Hydrate public+dynamic env values at runtime (typically in the browser),
 * while keeping the same `ENV.KEY` access pattern.
 */
export function setPublicDynamicEnv(
  values: Partial<PublicTypedEnvSchema> | Record<string, unknown>,
) {
  const allowed = getKeySetGlobal('__varlockPublicDynamicKeys');
  envState.initialized = true;
  for (const [key, value] of Object.entries(values || {})) {
    // when the declared key list is known, ignore anything outside it so a bad
    // endpoint payload can't overwrite static or sensitive values in the store
    if (allowed && !allowed.has(key)) {
      debug(`[public-dynamic] ignoring undeclared key in hydration payload: ${key}`);
      continue;
    }
    envValues[key] = value;
  }
}

/**
 * Returns public+dynamic env values as an object.
 * Optionally pass a key list to limit which values are included.
 */
export function getPublicDynamicEnv(keys?: Array<string>): Partial<PublicTypedEnvSchema> {
  const out: Record<string, unknown> = {};
  for (const key of resolvePublicDynamicKeys(keys)) {
    if (key in envValues) out[key] = envValues[key];
  }
  return out as Partial<PublicTypedEnvSchema>;
}

/**
 * Clears hydrated public+dynamic values from the ENV proxy store.
 */
export function clearPublicDynamicEnv(keys?: Array<string>) {
  for (const key of resolvePublicDynamicKeys(keys)) {
    delete envValues[key];
  }
  hasLoadedPublicDynamicEnv = false;
  lastLoadedPublicDynamicEnv = {};
}

/**
 * Loads public+dynamic env values from a server endpoint and hydrates the ENV proxy.
 * The server endpoint controls which keys are returned.
 */
export async function loadPublicDynamicEnv(opts?: {
  endpoint?: string,
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>,
  force?: boolean,
  requestInit?: RequestInit,
}): Promise<Partial<PublicTypedEnvSchema>> {
  if (!opts?.force) {
    if (hasHydratedPublicDynamicEnv()) return getPublicDynamicEnv();
    if (hasLoadedPublicDynamicEnv) return lastLoadedPublicDynamicEnv as Partial<PublicTypedEnvSchema>;
    if (publicDynamicEnvLoadPromise) return publicDynamicEnvLoadPromise;
  }

  const endpoint = opts?.endpoint
    ?? (globalThis as any).__varlockPublicDynamicEnvEndpoint
    ?? DEFAULT_PUBLIC_DYNAMIC_ENV_ENDPOINT;

  const fetchImpl = opts?.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error(
      '[varlock] loadPublicDynamicEnv requires fetch. '
      + 'Pass opts.fetch or call it in an environment with global fetch.',
    );
  }

  publicDynamicEnvLoadPromise = (async () => {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      ...opts?.requestInit,
    });
    if (!response.ok) {
      throw new Error(
        `[varlock] Failed to load public dynamic env (${response.status}) from ${endpoint}`,
      );
    }

    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('[varlock] loadPublicDynamicEnv expected a JSON object payload');
    }
    const payloadObj = payload as Record<string, unknown>;

    setPublicDynamicEnv(payloadObj);
    hasLoadedPublicDynamicEnv = true;
    lastLoadedPublicDynamicEnv = payloadObj;
    return payloadObj as Partial<PublicTypedEnvSchema>;
  })();

  try {
    return await publicDynamicEnvLoadPromise;
  } finally {
    publicDynamicEnvLoadPromise = undefined;
  }
}

const EnvProxy = new Proxy<TypedEnvSchema>({}, {
  get(target, prop) {
    // ignore symbols, as it likely an external tool checking something
    if (typeof prop === 'symbol') return;
    // special cases to avoid throwing on invalid keys
    if (IGNORED_PROXY_KEYS.includes(prop)) return;

    if (!envState.initialized) {
      throw new Error(
        'varlock ENV not initialized — make sure varlock is set up correctly.\n'
        + 'See https://varlock.dev/getting-started/installation/ for setup instructions.',
      );
    }

    if (envState.configHasErrors) {
      // eslint-disable-next-line no-console
      console.error(`[varlock] ⚠️ ENV.${prop} accessed but config has errors — values may be missing or incorrect`);
      return undefined;
    }

    const dynamicKeys = getKeySetGlobal('__varlockDynamicKeys');
    const publicDynamicKeys = getKeySetGlobal('__varlockPublicDynamicKeys');
    if (prop in envValues) {
      if (dynamicKeys?.has(prop)) {
        const isPublic = !!publicDynamicKeys?.has(prop);
        debug(`[dynamic-access] detected dynamic access for ENV.${prop}`);
        notifyDynamicConfigAccess({ key: prop, isPublic });
        // Guard only public+dynamic values: baking one into prerendered output defeats
        // its runtime-freshness intent. Sensitive (dynamic-by-default) values may be
        // legitimately read server-side during static builds - actual leakage into
        // build output is caught by the leak scanner instead.
        if (isPublic && shouldGuardDynamicAccessDuringBuild()) {
          const msg = [
            `[varlock] dynamic config \`ENV.${prop}\` was accessed during ${getVarlockExecutionPhase()}.`,
            'Dynamic values cannot be safely inlined during static build/prerender.',
            'Use runtime SSR access (non-prerender) or load/hydrate public dynamic values at runtime.',
          ].join(' ');
          if (getDynamicBuildAccessMode() === 'warn') {
            if (!dynamicBuildAccessWarnedKeys.has(prop)) {
              dynamicBuildAccessWarnedKeys.add(prop);
              // eslint-disable-next-line no-console
              console.warn(msg);
            }
          } else {
            throw new Error(msg);
          }
        }
      }
      return envValues[prop];
    }
    if ((globalThis as any).__varlockThrowOnMissingKeys) {
      // check the public list first - in the browser only __varlockPublicDynamicKeys
      // is injected, so this branch must not depend on the full dynamic key list
      if (publicDynamicKeys?.has(prop)) {
        throw new Error(
          `\`ENV.${prop}\` is public+dynamic and has not been hydrated yet. `
          + 'Load public dynamic env first (e.g. via loadPublicDynamicEnv()), then access it via ENV.',
        );
      }
      if (dynamicKeys?.has(prop)) {
        throw new Error(
          `\`ENV.${prop}\` is dynamic and is not available in this environment.`,
        );
      }
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

// we will attempt to call initVarlockEnv automatically, but in most cases it should be called explicitly
// note that if this is being imported in the browser, process.env may not exist, so we do this in a try/catch.
// NOTE - this must stay at the BOTTOM of the module: init (e.g. the browser boot-injection
// hook) calls helpers whose module-level `const` state would still be in the temporal dead
// zone if this ran mid-module, and the try/catch would silently swallow the ReferenceError.
try {
  if (!envState.initialized) {
    // if we are automatically loading because __VARLOCK_ENV is already set
    // then we assume process.env vars have also already been set (although might not harm anything?)
    initVarlockEnv({ allowFail: true });
  }
} catch (err) {
  // expected that this will fail when process.env does not exist
  // but we may want to look for specific errors
}
