import { ParsedEnvSpecFunctionArgs, ParsedEnvSpecFunctionCall, ParsedEnvSpecStaticValue } from './classes';

const EXPAND_VAR_REGEX_WITH_SIMPLE = /\$({([a-zA-Z_][a-zA-Z0-9_.]*)}|([a-zA-Z_][a-zA-Z0-9_]*))/g;
const EXPAND_VAR_REGEX = /\$({([a-zA-Z_][a-zA-Z0-9_.]*)})/g;
const EXPAND_EVAL_REGEX = /\$\(([^)]+)\)/g;


function expandVars(
  staticVal: ParsedEnvSpecStaticValue,
  opts?: {
    disableSimple?: boolean;
  },
): ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall {
  if (typeof staticVal.value !== 'string') return staticVal;
  const quote = staticVal.data.quote;
  // single quoted strings are not expanded!
  if (quote === "'") return staticVal;
  const quoteStr = quote ?? '';

  const varMatches = Array.from(staticVal.value.matchAll(
    // swap regexes to enable/disable expansion without {} brackets
    opts?.disableSimple ? EXPAND_VAR_REGEX : EXPAND_VAR_REGEX_WITH_SIMPLE,
  ));
  if (varMatches.length === 0) return staticVal;

  let lastIndex = 0;
  const parts = [] as Array<any>;
  for (const match of varMatches) {
    // extract text before eval
    if (lastIndex < match.index) {
      const preText = staticVal.value.slice(lastIndex, match.index);
      parts.push(new ParsedEnvSpecStaticValue({ rawValue: `${quoteStr}${preText}${quoteStr}`, quote }));
    }

    // extract var
    parts.push(new ParsedEnvSpecFunctionCall({
      name: 'ref',
      args: new ParsedEnvSpecFunctionArgs({
        values: [new ParsedEnvSpecStaticValue({ rawValue: match[2] || match[3] })],
      }),
    }));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < staticVal.value.length) {
    const postText = staticVal.value.slice(lastIndex);
    parts.push(new ParsedEnvSpecStaticValue({ rawValue: `${quoteStr}${postText}${quoteStr}`, quote }));
  }

  if (parts.length === 1) {
    return parts[0];
  } else {
    return new ParsedEnvSpecFunctionCall({
      name: 'concat',
      args: new ParsedEnvSpecFunctionArgs({
        values: parts,
      }),
    });
  }
}


function expandEvals(staticVal: ParsedEnvSpecStaticValue, opts?: {}) {
  if (typeof staticVal.value !== 'string') return staticVal;
  const quote = staticVal.data.quote;
  const quoteStr = quote ?? '';
  // single quoted strings are not expanded!
  if (quote === "'") return staticVal;

  const parts = [] as Array<ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall>;

  const evalMatches = Array.from(staticVal.value.matchAll(EXPAND_EVAL_REGEX));
  if (evalMatches.length === 0) {
    parts.push(staticVal);
  } else {
    let lastIndex = 0;
    for (const match of evalMatches) {
      // extract text before eval
      if (lastIndex < match.index) {
        const preText = staticVal.value.slice(lastIndex, match.index);
        parts.push(new ParsedEnvSpecStaticValue({ rawValue: `${quoteStr}${preText}${quoteStr}`, quote }));
      }

      // extract eval / shell command
      const shellCmd = match[1];
      parts.push(new ParsedEnvSpecFunctionCall({
        name: 'eval',
        args: new ParsedEnvSpecFunctionArgs({
          values: [new ParsedEnvSpecStaticValue({ rawValue: `${quoteStr}${shellCmd}${quoteStr}`, quote })],
        }),
      }));
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < staticVal.value.length) {
      const postText = staticVal.value.slice(lastIndex);
      parts.push(new ParsedEnvSpecStaticValue({ rawValue: `${quoteStr}${postText}${quoteStr}`, quote }));
    }
  }


  const partsWithExpandedVars = [] as Array<any>;
  for (const part of parts) {
    if (part instanceof ParsedEnvSpecFunctionCall) {
      partsWithExpandedVars.push(part);
    } else if (part instanceof ParsedEnvSpecStaticValue) {
      const expanded = expandVars(part, opts);
      if (expanded instanceof ParsedEnvSpecFunctionCall && expanded.name === 'concat') {
        partsWithExpandedVars.push(...expanded.data.args.values);
      } else {
        partsWithExpandedVars.push(expanded);
      }
    }
  }
  if (partsWithExpandedVars.length === 1) {
    return partsWithExpandedVars[0];
  } else {
    return new ParsedEnvSpecFunctionCall({
      name: 'concat',
      args: new ParsedEnvSpecFunctionArgs({
        values: partsWithExpandedVars,
      }),
    });
  }
}


export function expandStaticValue(staticVal: ParsedEnvSpecStaticValue, opts?: {}) {
  // boolean/number/etc are not expanded
  if (typeof staticVal.value !== 'string') return staticVal;
  // single quoted strings are not expanded!
  if (staticVal.data.quote === "'") return staticVal;

  return expandEvals(staticVal, opts);
}
