import { EnvGraph } from '@env-spec/env-graph';
import _ from '@env-spec/utils/my-dash';

const UNMASK_STR = '👁';

export type RedactMode = 'show_first_2' | 'show_last_2' | 'show_first_last';

/**
 * utility to mask/redact a string, for example transforming "hello" into "he▒▒▒"
 * this function just redacts _any_ string passed in
 *
 * To redact sensitive parts of a larger object/string, use redactSensitiveConfig
 * */
export function redactString(valStr: string | undefined, mode?: RedactMode, hideLength = true) {
  if (!valStr) return valStr;

  const hiddenLength = hideLength ? 5 : valStr.length - 2;
  const hiddenStr = '▒'.repeat(hiddenLength);

  if (mode === 'show_last_2') {
    return `${hiddenStr}${valStr.substring(valStr.length - 2, valStr.length)}`;
  } else if (mode === 'show_first_last') {
    return `${valStr.substring(0, 1)}${hiddenStr}${valStr.substring(valStr.length - 1, valStr.length)}`;
  } else { // 'show_first_2' - also default
    return `${valStr.substring(0, 2)}${hiddenStr}`;
  }
}


/** key value lookup of sensitive values to their redacted version */
let sensitiveSecretsMap: Record<string, string> = {};

type ReplaceFn = (match: string, pre: string, val: string, post: string) => string;
let redactorFindReplace: undefined | { find: RegExp, replace: ReplaceFn };

export function resetRedactionMap(graph: EnvGraph) {
  // reset map of { [sensitive] => redacted }
  sensitiveSecretsMap = {};
  for (const itemKey in graph.configSchema) {
    const item = graph.configSchema[itemKey];
    if (item.isSensitive && item.resolvedValue && _.isString(item.resolvedValue)) {
      // TODO: we want to respect masking settings from the schema (once added)
      const redacted = redactString(item.resolvedValue);
      if (redacted) sensitiveSecretsMap[item.resolvedValue] = redacted;
    }
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
    return sensitiveSecretsMap[val];
  };
  redactorFindReplace = { find: findRegex, replace: replaceFn };
}


const CONSOLE_METHODS = ['trace', 'debug', 'info', 'log', 'info', 'warn', 'error'];

// While the module itself acts as a singleton to hold the current map of redacted values
// we expose only the below const to end users

/** singleton wrapper for varlock's redaction utilities */
export const VarlockRedactor = {
  /**
   * Redacts senstive config values from any string/array/object/etc
   *
   * NOTE - must be used only after varlock has loaded config
   * */
  redactSensitiveConfig(o: any): any {
    if (!redactorFindReplace) return o;
    if (!o) return o;

    // TODO: handle more cases?
    // we can probably redact safely from a few other datatypes - like set,map,etc?
    // objects are a bit tougher
    if (Array.isArray(o)) {
      return o.map(VarlockRedactor.redactSensitiveConfig);
    }
    // try to redact if it's a plain object - not necessarily great for perf...
    if (o && typeof (o) === 'object' && Object.getPrototypeOf(o) === Object.prototype) {
      try {
        return JSON.parse(VarlockRedactor.redactSensitiveConfig(JSON.stringify(o)));
      } catch (err) {
        return o;
      }
    }

    const type = typeof o;
    if (type === 'string' || (type === 'object' && Object.prototype.toString.call(o) === '[object String]')) {
      return (o as string).replaceAll(redactorFindReplace.find, redactorFindReplace.replace);
    }

    return o;
  },

  /**
   * utility to unmask a secret/sensitive value when logging to the console
   * currently this only works on a single secret, not objects or aggregated strings
   * */
  unredact(secretStr: string) {
    // if redaction not enabled, we just return the secret itself
    if (!(globalThis as any)._varlockOrigWriteToConsoleFn) return secretStr;
    // otherwise we add some wrapper characters which will be removed by the patched console behaviour
    return `${UNMASK_STR} ${secretStr} ${UNMASK_STR}`;
  },

  /**
   * patches global console methods to redact sensitive config
   *
   * NOTE - this may not be 100% foolproof depending on the platform
   * */
  patchConsole() {
    /* eslint-disable no-console, prefer-rest-params */
    if (!redactorFindReplace) return;

    // our method of patching involves replacing an internal node method which may not be called if console.log itself has also been patched
    // for example AWS lambdas patches this to write the logs to a file which then is pushed to the rest of their system

    // so first we'll just patch the internal method do deal with normal stdout/stderr logs -------------------------------------

    // we need the internal symbol name to access the internal method
    const kWriteToConsoleSymbol = Object.getOwnPropertySymbols(globalThis.console).find((s) => s.description === 'kWriteToConsole');

    // @ts-ignore
    (globalThis as any)._varlockOrigWriteToConsoleFn ||= globalThis.console[kWriteToConsoleSymbol];
    // @ts-ignore
    globalThis.console[kWriteToConsoleSymbol] = function () {
      (globalThis as any)._varlockOrigWriteToConsoleFn.apply(this, [
        arguments[0],
        VarlockRedactor.redactSensitiveConfig(arguments[1]),
        arguments[2],
      ]);
    };

    // and now we'll wrap console.log (and the other methods) if it looks like they have been patched already ------------------
    // NOTE - this will not fully redact from everything since we can't safely reach deep into objects
    // ideally we would only turn this when the above method does not work, but it's not trivial to detect when it that is the case
    // so we'll turn it on all the time for now...
    if (
      // !console.log.toString().includes('[native code]') &&
      !(console.log as any)._varlockPatchedFn
    ) {
      for (const logMethodName of CONSOLE_METHODS) {
        // @ts-ignore
        const originalLogMethod = globalThis.console[logMethodName];

        const patchedFn = function () {
          // @ts-ignore
          originalLogMethod.apply(this, Array.from(arguments).map(VarlockRedactor.redactSensitiveConfig));
        };
        patchedFn._varlockPatchedFn = true;

        // @ts-ignore
        globalThis.console[logMethodName] = patchedFn;
      }
    }
  },

  /**
   * restore's original global console methods to stop redacting secrets
   *
   * (only needed during local development when switching settings on/off in a process that does not reload)
   * */
  unpatchConsole() {
    // we'll only care about the normal case where console.log has NOT been patched by something else... (see above)
    if (!(globalThis as any)._varlockOrigWriteToConsoleFn) return;

    const kWriteToConsoleSymbol = Object.getOwnPropertySymbols(globalThis.console).find((s) => s.description === 'kWriteToConsole');
    // @ts-ignore
    globalThis.console[kWriteToConsoleSymbol] = (globalThis as any)._varlockOrigWriteToConsoleFn;
    delete (globalThis as any)._varlockOrigWriteToConsoleFn;
  },
};
