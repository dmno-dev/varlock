import { execSync } from 'node:child_process';
import {
  ParsedEnvSpecFile, ParsedEnvSpecFunctionCall, ParsedEnvSpecKeyValuePair, ParsedEnvSpecStaticValue,
} from './classes.js';

/**
 * very simple resolver meant to be used for testing
 * not currently exposed as part of public API
 * */
export function simpleResolver(
  parsedEnvFile: ParsedEnvSpecFile,
  opts?: {
    env: Record<string, string>;
    stringify?: boolean;
  },
) {
  const resolved = {} as Record<string, any>;

  function valueResolver(valOrFn: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall): string | undefined {
    if (valOrFn instanceof ParsedEnvSpecStaticValue) return valOrFn.unescapedValue;
    if (valOrFn instanceof ParsedEnvSpecFunctionCall) {
      if (valOrFn.name === 'ref') {
        const args = valOrFn.simplifiedArgs;
        if (Array.isArray(args)) {
          const refKeyName = args[0];
          // passed in env takes precedence over resolved env
          return opts?.env?.[refKeyName] ?? resolved[refKeyName] ?? '';
        } else {
          throw new Error('Invalid `ref` args');
        }
      } else if (valOrFn.name === 'replace') {
        const args = valOrFn.simplifiedArgs;
        if (Array.isArray(args)) {
          const str = args[0];
          const search = args[1];
          const replace = args[2];
          return str.replace(search, replace);
        } else {
          throw new Error('Invalid `replace` args');
        }
      } else if (valOrFn.name === 'concat') {
        const args = valOrFn.data.args.values;
        const resolvedArgs = args.map((i) => {
          if (i instanceof ParsedEnvSpecStaticValue) {
            return valueResolver(i);
          } else if (i instanceof ParsedEnvSpecFunctionCall) {
            return valueResolver(i);
          } else {
            throw new Error('Invalid concat args');
          }
        });
        return resolvedArgs.join('');
      } else if (valOrFn.name === 'exec') {
        const args = valOrFn.simplifiedArgs;
        if (Array.isArray(args)) {
          const cmdStr = args[0];
          return execSync(
            cmdStr,
            {
              env: { ...resolved, ...opts?.env },
            },
          ).toString().trim();
        } else {
          throw new Error('Invalid `exec` args');
        }
      } else if (valOrFn.name === 'fallback') {
        const args = valOrFn.data.args.values;
        for (const arg of args) {
          if (arg instanceof ParsedEnvSpecKeyValuePair) {
            throw new Error('Invalid `fallback` arg - should not be key-value pair');
          }
          const resolvedArg = valueResolver(arg);
          if (resolvedArg !== undefined && resolvedArg !== '') return resolvedArg;
        }
        return undefined;
      } else if (valOrFn.name === 'remap') {
        const args = valOrFn.data.args.data.values;
        if (
          !(args[0] instanceof ParsedEnvSpecStaticValue)
          && !(args[0] instanceof ParsedEnvSpecFunctionCall)
        ) throw new Error('Expected first arg to be a static value or function call');
        const val = valueResolver(args[0]);
        for (const remapArg of args.slice(1)) {
          if (!(remapArg instanceof ParsedEnvSpecKeyValuePair)) {
            throw new Error('`remap` args after first should all be key-value pairs');
          }
          const remapVal = valueResolver(remapArg.value);
          if (val === remapVal) return remapArg.key;
        }
        return val;
      } else {
        throw new Error(`Unknown function: ${valOrFn.name}`);
      }
    }
  }

  for (const item of parsedEnvFile.configItems) {
    // passed in env takes precedence, but is only set if the the key is present
    if (opts?.env[item.key]) {
      resolved[item.key] = opts.env[item.key];
    } else {
      item.processExpansion();
      const resolvedValue = valueResolver(item.expandedValue!);
      if (opts?.stringify) {
        resolved[item.key] = resolvedValue === undefined ? '' : String(resolvedValue);
      } else {
        resolved[item.key] = resolvedValue;
      }
    }
  }
  return resolved;
}
