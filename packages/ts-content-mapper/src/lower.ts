// Lowering of a .env.schema into checked TypeScript (the "supplemental" output).
// Every schema token the language service should understand becomes a Verbatim slice of the original buffer
// inside a call/access on the generated schema API:
//   # @NAME ...          -> __dec.NAME(...) / __root.NAME(...)     (bare `@` -> zero-length completion slot)
//   @type=NAME(k=v)      -> __dec.type(__types.NAME({ k: v }))
//   fn(...)              -> __fns.fn(...)
//   forEnv(a, b)         -> __fns.forEnv("a", "b")                  (string-literal slices, typed by @currentEnv)
//   ${REF} / $REF        -> ENV.REF                                 (bare `$` -> zero-length completion slot)
//   @import(p, pick=[K]) -> importMode 'keys' (default for exposeEnv=global): declare const __imp0: {<keys of p>}
//                           importMode 'module': import type { CoercedEnvSchema as __I0 } from "p" (this leaks p's
//                           global augmentation under exposeEnv=global, so it is only the default for local)
//   static value failing coerce()/validate() -> __invalid("varlock: <msg>")   (a TS2345, i.e. a semantic error)
//   other varlock schema errors, and brackets the pre-pass had to close -> __invalid(...) at their location
//   bare-word values (`=conc|`, `@required=forE|`) -> `// @ts-ignore` + `void __fns.<word>` completion probe,
//     only when the word is a prefix of a resolver name, so a static secret never lands in virtual code
// Values of @sensitive items are never copied into the virtual code: no enum completion probe for them, and their
// @example is replaced with "".
/* eslint-disable no-bitwise -- SpanMapFeature values are bit flags */
/* eslint-disable no-use-before-define -- value(), args() and kvObject() are mutually recursive */
import path from 'node:path';
import { MappedCodeBuilder, SpanMapFeature as F, type PositionEncoding } from 'ts-content-mapper';
import type { Repaired } from './repair';

export const KEY_F = F.Hover | F.Definition | F.TypeDefinition | F.References | F.DocumentHighlights | F.Rename
  | F.Completion | F.SignatureHelp;
const NAME_F = F.Hover | F.SignatureHelp | F.Completion | F.References | F.DocumentHighlights;
const VAL_F = F.Hover | F.SignatureHelp | F.Completion;
const ARG_F = F.Hover | F.Completion | F.SignatureHelp;
const IDENT = /^[A-Za-z_$][\w$]*$/;

const kind = (v: any) => v?.constructor?.name;
const isStatic = (v: any) => kind(v) === 'ParsedEnvSpecStaticValue';
const isFn = (v: any) => kind(v) === 'ParsedEnvSpecFunctionCall';
const isArgs = (v: any) => kind(v) === 'ParsedEnvSpecFunctionArgs';
const isKV = (v: any) => kind(v) === 'ParsedEnvSpecKeyValuePair';
const isArr = (v: any) => kind(v) === 'ParsedEnvSpecArrayLiteral';
const isObj = (v: any) => kind(v) === 'ParsedEnvSpecObjectLiteral';
type Span = [number, number];
const span = (v: any): Span | undefined => (v?.data?._location
  ? [v.data._location.start.offset, v.data._location.end.offset]
  : undefined);

// errors already expressed by the lowering itself (unknown names / refs become TS2339/TS2551 on the token)
const COVERED_BY_LOWERING = /unknown data type|unknown resolver|unknown decorator|invalid dependency|Unknown root decorator|Unknown item decorator|expects (at least|at most|exactly) \d+ argument/i;

type RawRef = { name: string, start: number, end: number, braced: boolean };

// `$KEY` / `${KEY` / bare `$` in [start,end) of the (repaired) text; single-quoted segments and `\$` are literal
export function rawRefs(T: string, start: number, end: number) {
  const out: Array<RawRef> = [];
  let inSingle = false;
  for (let i = start; i < end; i++) {
    const c = T[i];
    if (c === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (inSingle || c !== '$' || T[i - 1] === '\\') continue;
    if (T[i + 1] === '(') continue; // $(cmd) = exec
    const braced = T[i + 1] === '{';
    const s = i + (braced ? 2 : 1);
    const m = /^[A-Za-z_][\w.]*/.exec(T.slice(s, end));
    out.push({
      name: m?.[0] ?? '', start: s, end: s + (m?.[0].length ?? 0), braced,
    });
  }
  return out;
}

export type LowerArgs = {
  content: string,
  fileName: string,
  graph: any,
  source: any,
  repaired: Repaired,
  api: { text: string },
  positionEncoding: PositionEncoding,
  importMode?: 'keys' | 'module',
};

export function lowerSchema({
  content, fileName, graph, source, repaired, api, positionEncoding, importMode = 'keys',
}: LowerArgs) {
  const T = repaired.text;
  const toOrig = repaired.toOrig;
  const b = new MappedCodeBuilder(content, { positionEncoding });
  const base = path.basename(fileName);
  const pf = source.parsedFile;
  const stats = { verbatim: 0, completionSlots: 0, invalid: 0 };

  // emit a Verbatim slice for repaired range [s,e) when the original text there is identical
  const verb = (s: number, e: number, features: number) => {
    const os = toOrig(s);
    const oe = toOrig(e);
    if (oe - os === e - s && content.slice(os, oe) === T.slice(s, e)) {
      b.appendVerbatim(os, oe, features);
      stats.verbatim++;
      return true;
    }
    b.append(T.slice(s, e));
    return false;
  };
  const slot = (s: number, features: number = F.Completion) => {
    const o = toOrig(s);
    b.appendVerbatim(o, o, features);
    stats.completionSlots++;
  };
  const lowHalf = (c: number) => /[\udc00-\udfff]/.test(content[c] ?? '') && /[\ud800-\udbff]/.test(content[c - 1] ?? '');
  const invalid = (msg: string, s: number, e: number) => {
    let os = Math.min(content.length, toOrig(s));
    if (lowHalf(os)) os--;
    let oe = Math.min(content.length, toOrig(e));
    if (oe <= os) oe = Math.min(content.length, os + 1);
    if (lowHalf(oe)) oe++;
    b.append('__invalid(');
    b.appendAtom(JSON.stringify(`varlock: ${msg}`), os, oe, F.Hover);
    b.append(');\n');
    stats.invalid++;
  };

  b.append('export {};\n');
  b.append(`import type { CoercedEnvSchema as __S } from './${base}';\n`);
  // @internal items are left out of CoercedEnvSchema but are valid targets of $KEY / ref() inside the schema
  const internalKeys = Object.keys(graph.configSchema ?? {}).filter((k) => graph.configSchema[k]?.isInternal);
  const internalProps = internalKeys.map((k) => `readonly ${IDENT.test(k) ? k : JSON.stringify(k)}: unknown`).join('; ');
  b.append(`declare const ENV: __S${internalKeys.length ? ` & { ${internalProps} }` : ''};\n`);
  // completion probes copy the bare word into virtual TS: only emit them for words that can still become a
  // resolver name, so a static secret (`TOKEN=sk_live_abc`) never lands in virtual code, logs or hovers
  const resolverNames = Object.keys(graph.registeredResolverFunctions).filter((n) => !n.startsWith('\0'));
  const isResolverPrefix = (w: string) => /^[A-Za-z_]\w*$/.test(w) && resolverNames.some((n) => n.startsWith(w));
  b.append(api.text);
  b.append('// ---- lowering of the schema itself ----\n');

  let refQueue: Array<RawRef> = [];
  const staticMsgs = new Set<string>(); // static-value failures already reported on the value span
  let scope: Span = [0, 0];
  const emitRef = (r: RawRef) => {
    if (r.name) {
      b.append('ENV.');
      verb(r.start, r.end, KEY_F);
      return;
    }
    // bare `$` / `${`: zero-length completion slot inside an element-access string (valid syntax, no checked access)
    b.append('ENV["');
    slot(r.start);
    b.append('"]');
  };
  const flushRefs = () => {
    for (const r of refQueue) {
      if (!r.name) b.append('// @ts-ignore\n');
      b.append('void ');
      emitRef(r);
      b.append(';\n');
    }
    refQueue = [];
  };
  const literal = (v: any) => {
    const s = span(v);
    if (!s) {
      b.append(v.value === undefined ? 'undefined' : JSON.stringify(v.unescapedValue ?? v.value));
      return;
    }
    const raw = T.slice(s[0], s[1]);
    if ((v.data.quote === '"' || v.data.quote === "'") && !raw.includes('\n')) {
      verb(s[0], s[1], VAL_F);
      return;
    }
    if (!v.data.quote && (typeof v.value === 'number' || typeof v.value === 'boolean') && /^(-?\d+(\.\d+)?|true|false)$/.test(raw.trim())) {
      verb(s[0], s[1], VAL_F);
      return;
    }
    if (!v.data.quote && !/["\\\n]/.test(raw)) {
      b.append('"');
      verb(s[0], s[1], VAL_F);
      b.append('"');
      return;
    }
    b.appendAtom(JSON.stringify(v.unescapedValue ?? v.value ?? ''), toOrig(s[0]), toOrig(s[1]), F.Hover);
  };
  const kvKeyStart = (kv: any) => {
    const vs = span(kv.value);
    if (vs) {
      const ks = vs[0] - 1 - kv.key.length;
      if (ks >= 0 && T.slice(ks, vs[0]) === `${kv.key}=`) return ks;
    }
    const re = new RegExp(`(?<![\\w])${kv.key.replace(/[.$]/g, '\\$&')}\\s*=`, 'g');
    re.lastIndex = scope[0];
    const m = re.exec(T);
    return m && m.index < scope[1] ? m.index : -1;
  };
  const kvKey = (kv: any) => {
    const ks = kvKeyStart(kv);
    if (ks >= 0 && IDENT.test(kv.key)) verb(ks, ks + kv.key.length, ARG_F);
    else b.append(JSON.stringify(kv.key));
  };
  const kvObject = (kvs: Array<any>, extraKeySlots: Array<Span> = []) => {
    b.append('{ ');
    let first = true;
    for (const ks of extraKeySlots) {
      if (!first) b.append(', ');
      first = false;
      verb(ks[0], ks[1], ARG_F);
    }
    for (const kv of kvs) {
      if (!first) b.append(', ');
      first = false;
      kvKey(kv);
      b.append(': ');
      value(kv.value);
    }
    b.append(' }');
  };
  const args = (values: Array<any>) => {
    const pos = values.filter((x) => !isKV(x));
    const kvs = values.filter(isKV);
    pos.forEach((a, i) => {
      if (i) b.append(', ');
      value(a);
    });
    if (kvs.length) {
      if (pos.length) b.append(', ');
      kvObject(kvs);
    }
  };
  // `name(` as one verbatim slice so signature help right after the paren maps
  const callName = (ns: string, name: string, s: number | undefined) => {
    b.append(`${ns}.`);
    if (s === undefined || T.slice(s, s + name.length) !== name) {
      b.append(`${name}(`);
      return;
    }
    const withParen = T[s + name.length] === '(';
    verb(s, s + name.length + (withParen ? 1 : 0), NAME_F);
    if (!withParen) b.append('(');
  };

  function refCall(v: any) {
    const a = v.data.args?.values?.[0];
    const as = span(a);
    const quotedIdent = as && isStatic(a) && a.data.quote && IDENT.test(String(a.value))
      && T.slice(as[0] + 1, as[1] - 1) === String(a.value);
    if (as && quotedIdent) {
      b.append('ENV.');
      verb(as[0] + 1, as[1] - 1, KEY_F);
      return;
    }
    if (as && isStatic(a) && a.data.quote) {
      b.append('ENV[');
      literal(a);
      b.append(']');
      return;
    }
    if (as) {
      b.append('ENV.');
      verb(as[0], as[1], KEY_F);
      return;
    }
    // `$KEY` expansion: no location of its own, so use the raw reference found in the text
    const key = a?.value;
    const qi = refQueue.findIndex((r) => r.name === key);
    if (qi >= 0) {
      const [r] = refQueue.splice(qi, 1);
      emitRef(r);
    } else {
      b.append(`ENV[${JSON.stringify(String(key))}]`);
    }
  }

  function value(v: any): void {
    if (v === undefined) {
      b.append('undefined');
    } else if (isStatic(v)) {
      literal(v);
    } else if (isArr(v)) {
      b.append('[');
      v.values.forEach((x: any, i: number) => {
        if (i) b.append(', ');
        value(x);
      });
      b.append(']');
    } else if (isObj(v)) {
      kvObject(v.values.filter(isKV));
    } else if (isFn(v)) {
      const s = span(v);
      if (v.name === 'ref') {
        refCall(v);
      } else if (v.name === 'forEnv') {
        // forEnv args are env names: string-literal slices typed by the @currentEnv enum
        callName('__fns', 'forEnv', s?.[0]);
        (v.data.args?.values ?? []).forEach((a: any, i: number) => {
          if (i) b.append(', ');
          if (isStatic(a) && !span(a)) {
            b.append(JSON.stringify(String(a.value)));
          } else if (isStatic(a) && !a.data.quote) {
            const as = span(a)!;
            b.append('"');
            verb(as[0], as[1], VAL_F);
            b.append('"');
          } else {
            value(a);
          }
        });
        b.append(')');
      } else {
        callName('__fns', v.name, s?.[0]);
        args(v.data.args?.values ?? []);
        b.append(')');
      }
    } else if (isArgs(v)) {
      args(v.values);
    } else {
      b.append('undefined');
    }
  }

  function typeSpec(v: any): void {
    if (isStatic(v)) {
      const s = span(v);
      const name = String(v.value);
      if (!s) {
        b.append(`__types[${JSON.stringify(name)}]()`);
      } else if (IDENT.test(name)) {
        b.append('__types.');
        verb(s[0], s[1], NAME_F);
        b.append('()');
      } else {
        b.append('__types["');
        verb(s[0], s[1], NAME_F);
        b.append('"]()');
      }
      return;
    }
    if (!isFn(v)) {
      value(v);
      return;
    }
    const s = span(v);
    const vals: Array<any> = v.data.args?.values ?? [];
    // dynamic type (`@type=if(eq($APP_ENV, prod), url, string)`): check the resolver call itself; which branch
    // varlock picks is a runtime question, so the item is not narrowed here
    if (!graph.dataTypesRegistry?.[v.name] && graph.registeredResolverFunctions?.[v.name]) {
      b.append('(void ');
      value(v);
      b.append(', __types.string())');
      return;
    }
    // composite: the positional arg of array(...) / record(...) is an element TYPE, not a value
    if ((v.name === 'array' || v.name === 'record') && graph.dataTypesRegistry?.[v.name]) {
      callName('__types', v.name, s?.[0]);
      const pos = vals.filter((x) => !isKV(x));
      const kvs = vals.filter(isKV);
      b.append('{ ');
      if (pos[0] !== undefined) {
        b.append(v.name === 'array' ? 'element: ' : 'values: ');
        typeSpec(pos[0]);
      }
      kvs.forEach((kv, i) => {
        if (i || pos[0] !== undefined) b.append(', ');
        kvKey(kv);
        b.append(': ');
        value(kv.value);
      });
      b.append(' })');
      return;
    }
    if (!IDENT.test(v.name)) b.append(`__types[${JSON.stringify(v.name)}](`);
    else callName('__types', v.name, s?.[0]);
    if (v.name === 'enum') {
      args(vals);
    } else {
      // a bare identifier positional arg of a settings-style type is a half-typed option name
      const keySlots: Array<Span> = [];
      const rest: Array<any> = [];
      for (const a of vals) {
        const as = span(a);
        if (isStatic(a) && !a.data.quote && as && IDENT.test(T.slice(as[0], as[1]))) keySlots.push(as);
        else rest.push(a);
      }
      const kvs = rest.filter(isKV);
      const pos = rest.filter((x) => !isKV(x));
      pos.forEach((a, i) => {
        if (i) b.append(', ');
        value(a);
      });
      if (kvs.length || keySlots.length) {
        if (pos.length) b.append(', ');
        kvObject(kvs, keySlots);
      }
    }
    b.append(')');
  }

  let importCount = 0;
  function importDecorator(dec: any, at: number) {
    const [p, ...rest] = dec.bareFnArgs.values;
    const ps = span(p);
    if (!isStatic(p) || !ps || !String(p.value).endsWith('.env.schema')) return false;
    const i = importCount++;
    if (importMode === 'module') {
      // import type specifier = verbatim path slice (go-to-definition / hover on the path).
      // NOTE: with exposeEnv=global this pulls the imported schema's `declare module 'varlock/env'`
      // augmentation into the program, so un-picked keys would leak onto the global ENV
      b.append(`import type { CoercedEnvSchema as __I${i} } from `);
      if (p.data.quote) {
        verb(ps[0], ps[1], F.Definition | F.Hover);
      } else {
        b.append('"');
        verb(ps[0], ps[1], F.Definition | F.Hover);
        b.append('"');
      }
      b.append(`;\ndeclare const __imp${i}: __I${i};\n`);
    } else {
      // 'keys': the imported file's keys come from the shape graph; nothing new enters the TS program
      const abs = path.resolve(path.dirname(fileName), String(p.value));
      const ids = graph.sortedDataSources?.find((d: any) => d.fullPath === abs);
      const keys = Object.keys(ids?.configItemDefs ?? {});
      b.append(`/** keys of ${JSON.stringify(String(p.value))} (from the shape graph) */\n`);
      b.append(`declare const __imp${i}: { ${keys.map((k) => `readonly ${IDENT.test(k) ? k : JSON.stringify(k)}: unknown`).join('; ')} };\n`);
    }
    b.append('__root.');
    verb(at, at + dec.name.length, NAME_F);
    b.append('(');
    b.append(JSON.stringify(String(p.value)));
    const kvs = rest.filter(isKV);
    if (kvs.length) b.append(', { ');
    kvs.forEach((kv: any, j: number) => {
      if (j) b.append(', ');
      const ks = kvKeyStart(kv);
      if (ks >= 0) verb(ks, ks + kv.key.length, ARG_F);
      else b.append(kv.key);
      b.append(': ');
      if ((kv.key === 'pick' || kv.key === 'omit') && isArr(kv.value)) {
        b.append('[');
        kv.value.values.forEach((n: any, j2: number) => {
          if (j2) b.append(', ');
          const ns2 = span(n);
          if (isStatic(n) && ns2 && /^[A-Za-z_]\w*$/.test(String(n.value))) {
            b.append(`__imp${i}.`);
            verb(ns2[0], ns2[1], KEY_F);
          } else {
            value(n);
          }
        });
        b.append(']');
      } else {
        value(kv.value);
      }
    });
    if (kvs.length) b.append(' }');
    b.append(');\n');
    flushRefs();
    return true;
  }

  function decorator(dec: any, ns: '__root' | '__dec', itemKey?: string) {
    const ds = span(dec);
    if (!ds) return;
    scope = ds;
    refQueue = rawRefs(T, ds[0], ds[1]);
    const at = T[ds[0]] === '@' ? ds[0] + 1 : ds[0];
    if (dec.name === 'import' && dec.bareFnArgs && importDecorator(dec, at)) return;
    b.append(`${ns}.`);
    verb(at, at + dec.name.length, NAME_F);
    const dv = dec.value;
    const dvSpan = span(dv);
    if (dec.name === 'type' && ns === '__dec') {
      b.append('(');
      if (dec.data.value !== undefined) typeSpec(dec.data.value);
      b.append(')');
    } else if (dec.isBareFnCall) {
      b.append('(');
      args(dec.bareFnArgs?.values ?? []);
      b.append(')');
    } else if (dec.data.value === undefined) {
      b.append('()'); // bare `@required` (implicit true)
    } else if (dec.name === 'example' && itemKey && graph.configSchema[itemKey]?.isSensitive) {
      // varlock's own typegen never emits the example of a sensitive item either
      b.append('("") /* @example of a sensitive item: not copied into virtual code */');
    } else if (isStatic(dv) && !dv.data.quote && dvSpan && isResolverPrefix(T.slice(...dvSpan)) && typeof dv.value === 'string') {
      // bare word value (`@required=forE|`): may be a half-typed resolver call -> completion probe on __fns
      b.append(`(${JSON.stringify(dv.value)});\n// @ts-ignore\nvoid __fns.`);
      verb(dvSpan[0], dvSpan[1], F.Completion);
    } else {
      // dec.value is the value after $-expansion
      b.append('(');
      value(dv);
      b.append(')');
    }
    b.append(';\n');
    flushRefs();
  }

  // varlock's own coerce()+validate() on a static value, reported as a TS error on the value span
  function checkStaticValue(itemKey: string, v: any, cfg: any) {
    const raw = v.unescapedValue ?? v.value;
    if (raw === undefined || raw === '') return;
    let msgs: Array<string> = [];
    // warnings (e.g. url protocol notices) stay warnings
    const isErr = (e: any) => e instanceof Error && !(e as any).isWarning;
    try {
      const c = cfg.dataType.coerce(raw);
      if (isErr(c)) {
        msgs = [c.message];
      } else if (!(c instanceof Error)) {
        const r = cfg.dataType.validate(c);
        if (isErr(r)) msgs = [r.message];
        else if (Array.isArray(r)) msgs = r.filter(isErr).map((e) => e.message);
      }
    } catch (e) {
      msgs = [(e as Error).message];
    }
    const vs = span(v)!;
    for (const m of msgs) {
      invalid(`${itemKey}: ${m}`, vs[0], vs[1]);
      staticMsgs.add(m);
    }
  }

  function configItem(item: any) {
    for (const dec of item.decoratorsArray ?? []) decorator(dec, '__dec', item.key);
    const loc = item.data._location;
    if (!loc) return;
    const slice = T.slice(loc.start.offset, loc.end.offset);
    const km = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${item.key.replace(/[.]/g, '\\.')}[ \\t]*=`, 'm').exec(slice);
    if (!km) return;
    const eq = loc.start.offset + km.index + km[0].length;
    scope = [eq, loc.end.offset];
    refQueue = rawRefs(T, eq, loc.end.offset);
    const v = item.value;
    const cfg = graph.configSchema[item.key];
    if (v !== undefined) {
      const vs = span(v);
      const raw = vs ? T.slice(vs[0], vs[1]) : '';
      const isEnum = cfg?.dataType?.name === 'enum';
      // the enum probe copies the value into the virtual TS, so a sensitive item gets no enum completion
      const probe = isEnum ? !cfg.isSensitive && /^[A-Za-z_]\w*$/.test(raw) : isResolverPrefix(raw);
      if (isStatic(v) && vs && !v.data.quote && probe && typeof v.value === 'string') {
        // completion probe: a bare word value may be a half-typed resolver call (`=conc|`) or an enum member
        b.append('// @ts-ignore\n');
        if (isEnum) {
          b.append(`void ((v: NonNullable<__S[${JSON.stringify(item.key)}]>) => v)("`);
          verb(vs[0], vs[1], VAL_F);
          b.append('");\n');
        } else {
          b.append('void __fns.');
          verb(vs[0], vs[1], F.Completion);
          b.append(';\n');
        }
      } else if (!isStatic(v)) {
        b.append('void ');
        value(v);
        b.append(';\n');
      }
    }
    flushRefs();
    // skipped for a dynamic @type=if(...): which type applies is varlock's runtime call, and its own item errors
    // are reported below
    if (v !== undefined && isStatic(v) && cfg?.dataType && !cfg.hasComputedType && span(v)) {
      checkStaticValue(item.key, v, cfg);
    }
  }

  if (pf) {
    for (const dec of pf.decoratorsArray ?? []) decorator(dec, '__root');
    for (const item of pf.configItems ?? []) configItem(item);
  }

  // bare `@` in decorator comment lines: zero-length completion slot on __dec / __root
  // scanned in the ORIGINAL buffer (the pre-pass blanks bare `@` so the file still parses)
  let off = 0;
  const itemRanges = (pf?.configItems ?? [])
    .map((it: any) => span(it))
    .filter(Boolean)
    .map(([s, e]: Span) => [toOrig(s), toOrig(e)]);
  for (const line of content.split('\n')) {
    if (/^\s*#\s*@/.test(line)) {
      for (let i = line.indexOf('@'); i >= 0; i = line.indexOf('@', i + 1)) {
        if (/[A-Za-z_]/.test(line[i + 1] ?? '')) continue;
        if (/[\w"'/.:]/.test(line[i - 1] ?? ' ')) continue; // inside a value (emails, scoped packages)
        const o = off + i;
        const ns = itemRanges.some(([s, e]: Span) => o >= s && o < e) ? '__dec' : '__root';
        b.append(`// @ts-ignore\n${ns}["`);
        b.appendVerbatim(o + 1, o + 1, F.Completion);
        stats.completionSlots++;
        b.append('"];\n');
      }
    }
    off += line.length + 1;
  }

  // brackets/quotes the pre-pass had to close: the buffer as typed is not valid env-spec
  for (const ins of repaired.inserts) {
    invalid(`unterminated expression on line ${ins.line} (mapper closed it with \`${ins.closer}\` for the shape load)`, ins.at - 1, ins.at);
  }

  // remaining varlock schema errors -> TS errors at their location (never mapper diagnostics)
  const lineStarts = [0];
  for (let i = 0; i < T.length; i++) if (T[i] === '\n') lineStarts.push(i + 1);
  const seen = new Set<string>();
  const report = (err: any, fallback: number) => {
    if (!err || err.isWarning || COVERED_BY_LOWERING.test(err.message)) return;
    if (staticMsgs.has(err.message) || seen.has(err.message)) return;
    seen.add(err.message); // the same error is often attached to both the data source and the decorator
    const loc = err.location ?? err.more?.location;
    let s = fallback;
    if (loc?.lineNumber && (!loc.id || loc.id === fileName || loc.path === fileName)) {
      s = (lineStarts[loc.lineNumber - 1] ?? 0) + Math.max(0, (loc.colNumber ?? 1) - 1);
    }
    invalid(err.message, s, s + 1);
  };
  for (const ds of graph.sortedDataSources ?? []) {
    if (ds === source) for (const e of ds.errors ?? []) report(e, 0);
  }
  for (const d of source.rootDecorators ?? []) {
    for (const e of d.schemaErrors ?? []) report(e, span(d.parsedDecorator)?.[0] ?? 0);
  }
  for (const item of pf?.configItems ?? []) {
    for (const e of graph.configSchema[item.key]?.errors ?? []) report(e, span(item)?.[0] ?? 0);
  }

  return { out: b.build('.ts'), stats };
}
