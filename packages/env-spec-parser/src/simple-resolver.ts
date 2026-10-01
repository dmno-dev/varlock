import { execFileSync, execSync } from 'node:child_process';
import {
  ParsedEnvSpecFile, ParsedEnvSpecFunctionCall, ParsedEnvSpecKeyValuePair,
  ParsedEnvSpecStaticValue, ParsedEnvSpecObjectLiteral, ParsedEnvSpecArrayLiteral,
  type ParsedEnvSpecConfigItemValue,
} from './classes.js';

/** Quote a value as exactly one shell word (POSIX single quotes; cmd.exe double quotes on Windows). */
function shellQuoteWord(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '""')}"`;
  if (value === '') return "''";
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

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

  function valueResolver(
    valOrFn: ParsedEnvSpecConfigItemValue,
  ): string | Array<unknown> | Record<string, unknown> | undefined {
    if (valOrFn instanceof ParsedEnvSpecStaticValue) return valOrFn.unescapedValue;
    if (valOrFn instanceof ParsedEnvSpecArrayLiteral) {
      return valOrFn.values.map((v) => {
        if (v instanceof ParsedEnvSpecKeyValuePair) throw new Error('Unexpected key-value pair in array literal');
        return valueResolver(v);
      });
    }
    if (valOrFn instanceof ParsedEnvSpecObjectLiteral) {
      const obj: Record<string, unknown> = {};
      for (const kv of valOrFn.values) {
        obj[kv.key] = valueResolver(kv.value);
      }
      return obj;
    }
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
        const args = valOrFn.data.args.values;
        const execEnv = { ...resolved, ...opts?.env };
        if (args.length > 1) {
          // argv form: exec("cmd", "arg", $REF) runs the program directly, no shell
          const argv = args.map((a) => {
            if (a instanceof ParsedEnvSpecKeyValuePair) throw new Error('Invalid `exec` args - key/value pairs not allowed');
            return String(valueResolver(a) ?? '');
          });
          const [file, ...fileArgs] = argv;
          if (!file) throw new Error('Invalid `exec` args - needs a command');
          return execFileSync(file, fileArgs, { env: execEnv }).toString().trim();
        }
        if (
          args.length === 1
          && (args[0] instanceof ParsedEnvSpecStaticValue || args[0] instanceof ParsedEnvSpecFunctionCall)
        ) {
          // string form: static text is the command as written, anything interpolated
          // into it (`${REF}`, a nested call) is quoted to one shell word so a value can
          // never be read as more shell syntax. Mirrors varlock's resolver.
          const cmdArg = args[0];
          let cmdStr: unknown;
          if (cmdArg instanceof ParsedEnvSpecFunctionCall && cmdArg.name === 'concat') {
            cmdStr = cmdArg.data.args.values.map((part) => {
              if (part instanceof ParsedEnvSpecKeyValuePair) throw new Error('Invalid concat args');
              const text = String(valueResolver(part) ?? '');
              return part instanceof ParsedEnvSpecStaticValue ? text : shellQuoteWord(text);
            }).join('');
          } else {
            cmdStr = valueResolver(cmdArg);
          }
          if (typeof cmdStr !== 'string') throw new Error('Invalid `exec` command');
          return execSync(cmdStr, { env: execEnv }).toString().trim();
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
        const remainingArgs = args.slice(1);
        // iterate in pairs of (match, result); `i + 1 < length` ensures we
        // process only complete pairs, leaving a potential trailing default unprocessed
        for (let i = 0; i + 1 < remainingArgs.length; i += 2) {
          const matchArg = remainingArgs[i];
          const resultArg = remainingArgs[i + 1];
          if (matchArg instanceof ParsedEnvSpecKeyValuePair || resultArg instanceof ParsedEnvSpecKeyValuePair) {
            throw new Error('`remap` args should not be key-value pairs');
          }
          const matchVal = valueResolver(matchArg);
          if (val === matchVal) return valueResolver(resultArg);
        }
        // if odd number of remaining args, last is the default
        if (remainingArgs.length % 2 === 1) {
          const defaultArg = remainingArgs[remainingArgs.length - 1];
          if (defaultArg instanceof ParsedEnvSpecKeyValuePair) {
            throw new Error('`remap` args should not be key-value pairs');
          }
          return valueResolver(defaultArg);
        }
        return val; // return original value if no match
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
      const resolvedValue = item.value ? valueResolver(item.value) : undefined;
      if (opts?.stringify) {
        resolved[item.key] = resolvedValue === undefined ? '' : String(resolvedValue);
      } else {
        resolved[item.key] = resolvedValue;
      }
    }
  }
  return resolved;
}
