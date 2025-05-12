import {
  ParsedEnvSpecFunctionArgs, ParsedEnvSpecFunctionCall, ParsedEnvSpecKeyValuePair, ParsedEnvSpecStaticValue,
} from './classes';

// const EXPAND_VAR_REGEX_WITH_SIMPLE = /\$({([a-zA-Z_][a-zA-Z0-9_.]*)}|([a-zA-Z_][a-zA-Z0-9_]*))/g;
const EXPAND_VAR_BRACKETED_REGEX = /(?<!\\)\${([a-zA-Z_][a-zA-Z0-9_.]*)((:?-)([^}]+))?}/g;
const EXPAND_VAR_SIMPLE_REGEX = /(?<!\\)\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
const EXPAND_EVAL_REGEX = /\$\(([^)]+)\)/g;


type ParsedEnvSpecValueNode = ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecKeyValuePair;

function expandEvals(staticVal: ParsedEnvSpecStaticValue, _opts?: {}) {
  if (typeof staticVal.value !== 'string') return staticVal;
  const quote = staticVal.data.quote;
  const quoteStr = quote ?? '';
  // single quoted strings are not expanded!
  if (quote === "'") return staticVal;

  const evalMatches = Array.from(staticVal.value.matchAll(EXPAND_EVAL_REGEX));

  // if no matches - we just return the original value
  if (evalMatches.length === 0) return staticVal;

  // otherwise, we expand the transform each match into `eval` fn calls
  // and return a concat with everything together
  let lastIndex = 0;
  const parts = [] as Array<ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall>;
  for (const match of evalMatches) {
    // extract text before eval -- ex: `pretext-$(eval command)`
    if (lastIndex < match.index) {
      const preText = staticVal.value.slice(lastIndex, match.index);
      parts.push(new ParsedEnvSpecStaticValue({ rawValue: `${quoteStr}${preText}${quoteStr}`, quote }));
    }

    // extract eval command
    const shellCmd = match[1];
    parts.push(new ParsedEnvSpecFunctionCall({
      name: 'eval',
      args: new ParsedEnvSpecFunctionArgs({
        values: [new ParsedEnvSpecStaticValue({ rawValue: `${quoteStr}${shellCmd}${quoteStr}`, quote })],
      }),
    }));
    lastIndex = match.index + match[0].length;
  }
  // extract any remaining text after the last eval
  if (lastIndex < staticVal.value.length) {
    const postText = staticVal.value.slice(lastIndex);
    parts.push(new ParsedEnvSpecStaticValue({ rawValue: `${quoteStr}${postText}${quoteStr}`, quote }));
  }

  // if there's only one part, we can just return it (ex: `VAR=$(whoami)`)
  if (parts.length === 1) return parts[0];
  // otherwise we concat all the parts together
  return new ParsedEnvSpecFunctionCall({
    name: 'concat',
    args: new ParsedEnvSpecFunctionArgs({
      values: parts,
    }),
  });
}

function expandRefs(staticVal: ParsedEnvSpecStaticValue, mode: 'simple' | 'bracketed') {
  if (typeof staticVal.value !== 'string') return staticVal;
  const quote = staticVal.data.quote;
  const quoteStr = quote ?? '';
  if (quote === "'") return staticVal;

  const varMatches = Array.from(staticVal.value.matchAll(mode === 'simple' ? EXPAND_VAR_SIMPLE_REGEX : EXPAND_VAR_BRACKETED_REGEX));
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
    const varName = match[1];
    let defaultOperator: string | undefined; // ex: ":-" or "-"
    let defaultVal: string | undefined; // currently not doing any fancy parsing on this, will just be a string
    if (mode === 'bracketed') {
      // TODO: do we want to support different behaviour based on the operator?
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      defaultOperator = match[3];
      defaultVal = match[4];
    }
    const refFnCall = new ParsedEnvSpecFunctionCall({
      name: 'ref',
      args: new ParsedEnvSpecFunctionArgs({
        values: [new ParsedEnvSpecStaticValue({ rawValue: varName })],
      }),
    });
    if (defaultVal) {
      parts.push(new ParsedEnvSpecFunctionCall({
        name: 'fallback',
        args: new ParsedEnvSpecFunctionArgs({
          values: [refFnCall, new ParsedEnvSpecStaticValue({ rawValue: `${quoteStr}${defaultVal}${quoteStr}`, quote })],
        }),
      }));
    } else {
      parts.push(refFnCall);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < staticVal.value.length) {
    const postText = staticVal.value.slice(lastIndex);
    parts.push(new ParsedEnvSpecStaticValue({ rawValue: `${quoteStr}${postText}${quoteStr}`, quote }));
  }

  // if only a single part, just return it (ex: `VAR=${OTHERVAR}`)
  if (parts.length === 1) return parts[0];
  // otherwise, concat all the parts together
  return new ParsedEnvSpecFunctionCall({
    name: 'concat',
    args: new ParsedEnvSpecFunctionArgs({
      values: parts,
    }),
  });
}

/**
 * helper used by expansion to recursively expand values
 * */
function expandHelper(
  val: ParsedEnvSpecValueNode,
  expandStaticFn: (staticVal: ParsedEnvSpecStaticValue) => ParsedEnvSpecValueNode,
): ParsedEnvSpecValueNode {
  // if function call, expand each arg
  if (val instanceof ParsedEnvSpecFunctionCall) {
    const fnName = val.name;
    // expand each arg, and then flatten unnecessery nested concat fns
    const newConcatArgs = [] as Array<ParsedEnvSpecValueNode>;
    val.data.args.values.forEach((v) => {
      const expandedArg = expandHelper(v, expandStaticFn);
      // special case for concat so we flatten unnecessery nested concat fns
      if (
        fnName === 'concat'
        && expandedArg instanceof ParsedEnvSpecFunctionCall
        && expandedArg.name === 'concat'
      ) {
        newConcatArgs.push(...expandedArg.data.args.values);
      } else {
        newConcatArgs.push(expandedArg);
      }
    });

    return new ParsedEnvSpecFunctionCall({
      name: fnName,
      args: new ParsedEnvSpecFunctionArgs({
        values: newConcatArgs,
      }),
    });
  // if key-value pair, expand value
  } else if (val instanceof ParsedEnvSpecKeyValuePair) {
    const expandedVal = expandHelper(val.value, expandStaticFn);
    if (expandedVal instanceof ParsedEnvSpecKeyValuePair) throw new Error('Nested key-value pair found in concat');
    return new ParsedEnvSpecKeyValuePair({
      key: val.key,
      val: expandedVal,
    });
  } else if (val instanceof ParsedEnvSpecStaticValue) {
    // here we actually do the expansion on string values

    // skip expansion if value is number/boolean/etc
    if (typeof val.value !== 'string') return val;
    // skip expansion on single-quoted strings
    if (val.data.quote === "'") return val;

    return expandStaticFn(val);
  }
  throw new Error('Unknown value type');
}

/**
 * takes in a value node and runs expansion (evals, refs) according to options
 * returns a new value node with all expansions applied
 * */
export function expand(
  val: ParsedEnvSpecValueNode,
  // TODO: add options to enable/disable specific expansion types and handling
  _opts?: {},
): ParsedEnvSpecValueNode {
  // TODO: add options
  let expandedVal = val;
  expandedVal = expandHelper(expandedVal, (v) => expandEvals(v));
  expandedVal = expandHelper(expandedVal, (v) => expandRefs(v, 'simple'));
  expandedVal = expandHelper(expandedVal, (v) => expandRefs(v, 'bracketed'));
  return expandedVal;
}
