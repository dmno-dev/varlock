import type {
  CstGrammar, TokenDecl, PrecLevel, PrecOperator, RuleDecl, RuleExpr, MarkupConfig,
} from './types';

// ── Token ──

interface TokenOptions {
  skip?: boolean;
  scope?: string;
  escape?: RegExp;
  // A regex matching exactly one well-formed escape sequence. Engine-scanned tokens
  // (templates) validate each `\`-escape against it and reject any that don't match —
  // unlike `escape` (highlight-only), this drives tokenization. Skipped in tag
  // position, where invalid escapes are legal (cooked = undefined). Optional.
  escapeValid?: RegExp;
  regex?: boolean;
  embed?: string;
  // ── Lexer hints (keep gen-parser language-agnostic; all optional) ──
  identifier?: boolean;
  template?: { open: string; interpOpen: string; interpClose: string };
  regexContext?: {
    divisionAfterTypes?: Array<string>;
    divisionAfterTexts?: Array<string>;
    regexAfterTexts?: Array<string>;
    regexAfterParenKeywords?: Array<string>;
    memberAccessTexts?: Array<string>;
    postfixAfterValueTexts?: Array<string>;
  };
  string?: boolean;
}

export class TokenRef {
  readonly __kind = 'token' as const;
  readonly pattern: RegExp;
  readonly opts: TokenOptions;
  constructor(pattern: RegExp, opts: TokenOptions) {
    this.pattern = pattern;
    this.opts = opts;
  }
}

export function token(pattern: RegExp, opts?: TokenOptions): TokenRef {
  return new TokenRef(pattern, opts ?? {});
}

// ── Rule ──

interface RuleOptions {
  type?: boolean;
}

type Element = string | TokenRef | RuleRef | Marker | Combinator;
type Sequence = Array<Element>;
type Alternative = Element | Sequence;
type RuleBody = (self: RuleRef) => Array<Alternative>;

export class RuleRef {
  readonly __kind = 'rule' as const;
  readonly def: RuleBody;
  readonly opts: RuleOptions;
  constructor(def: RuleBody, opts: RuleOptions) {
    this.def = def;
    this.opts = opts;
  }
}

export function rule(def: RuleBody, opts?: RuleOptions): RuleRef {
  return new RuleRef(def, opts ?? {});
}

// ── Special slots for rules ──

interface OpMarker { readonly __kind: 'op' }
interface SameLineMarker { readonly __kind: 'sameLine' }
interface PrefixSlot {
  readonly __kind: 'prefix';
  (...ops: Array<string>): PrefixOps;
}
interface PostfixSlot {
  readonly __kind: 'postfix';
  (...ops: Array<string>): PostfixOps;
}
interface PrefixOps { readonly __kind: 'prefix-ops'; ops: Array<string> }
interface PostfixOps { readonly __kind: 'postfix-ops'; ops: Array<string> }
interface NoUnaryLhsOps { readonly __kind: 'no-unary-lhs-ops'; ops: Array<string> }

type Marker = OpMarker | PrefixSlot | PostfixSlot | SameLineMarker;

export const op: OpMarker = { __kind: 'op' };

// Zero-width "no LineTerminator here" assertion (see RuleExpr 'sameLine').
export const sameLine: SameLineMarker = { __kind: 'sameLine' };

export const prefix: PrefixSlot = Object.assign(
  (...ops: Array<string>): PrefixOps => ({ __kind: 'prefix-ops' as const, ops }),
  { __kind: 'prefix' as const },
) as PrefixSlot;

export const postfix: PostfixSlot = Object.assign(
  (...ops: Array<string>): PostfixOps => ({ __kind: 'postfix-ops' as const, ops }),
  { __kind: 'postfix' as const },
) as PostfixSlot;

// Mark infix operators whose LEFT operand may not be a bare unary-prefix expression
// (a prefix-op result that is NOT also an update `++`/`--`). E.g. JS `**`: `-x ** y`
// is a syntax error (write `(-x) ** y` or `-(x ** y)`), but `x ** -y`, `(-x) ** y`,
// and `++x ** y` are fine. A general, declarable property — Python, by contrast,
// allows `-x ** y` and would not use this. The engine enforces it generically.
export const noUnaryLhs = (...ops: Array<string>): NoUnaryLhsOps => ({ __kind: 'no-unary-lhs-ops' as const, ops });

// ── Combinators ──

class SepNode {
  readonly __kind = 'sep' as const;
  readonly item: Element;
  readonly delimiter: string;
  constructor(item: Element, delimiter: string) {
    this.item = item;
    this.delimiter = delimiter;
  }
}
class OptNode {
  readonly __kind = 'opt' as const;
  readonly items: Array<Element>;
  constructor(items: Array<Element>) { this.items = items; }
}
class ManyNode {
  readonly __kind = 'many' as const;
  readonly items: Array<Element>;
  constructor(items: Array<Element>) { this.items = items; }
}
class Many1Node {
  readonly __kind = 'many1' as const;
  readonly items: Array<Element>;
  constructor(items: Array<Element>) { this.items = items; }
}
class AltNode {
  readonly __kind = 'alt' as const;
  // Branches may be a single element OR a sequence (array), so alt() can express
  // a left-factored rule: alt([a, b], [a, c]) etc.
  readonly items: Array<Alternative>;
  constructor(items: Array<Alternative>) { this.items = items; }
}
class ExcludeNode {
  // Parse the wrapped rule, but with the given infix/LED connectors disabled at
  // the top level (they rebind to the enclosing context). Models grammars with a
  // "no-`in`" production: a for-head's `var x = E` parses E so a following `in`
  // is the for-in keyword, not the `in` operator. The excluded tokens are grammar
  // DATA, so the engine stays language-agnostic.
  readonly __kind = 'exclude' as const;
  readonly connectors: Array<string>;
  readonly items: Array<Element>;
  constructor(connectors: Array<string>, items: Array<Element>) { this.connectors = connectors; this.items = items; }
}
class NotNode {
  readonly __kind = 'not' as const;
  // Zero-width negative lookahead over a single element (wrap a sequence in a
  // group/alt if needed). Matches nothing; succeeds only when `item` can't match.
  readonly item: Element;
  constructor(item: Element) { this.item = item; }
}

type Combinator = SepNode | OptNode | ManyNode | Many1Node | AltNode | ExcludeNode | NotNode;

export function sep(item: Element, delimiter: string): SepNode {
  return new SepNode(item, delimiter);
}

export function opt(...items: Array<Element>): OptNode {
  return new OptNode(items);
}

export function many(...items: Array<Element>): ManyNode {
  return new ManyNode(items);
}

export function many1(...items: Array<Element>): Many1Node {
  return new Many1Node(items);
}

export function alt(...items: Array<Alternative>): AltNode {
  return new AltNode(items);
}

// Parse `items` with the given LED connector(s) disabled at the top level (a
// no-`in`-style context). `exclude('in', Expr)` parses an Expr that stops before
// a top-level `in`, leaving it for the enclosing rule.
export function exclude(connectors: string | Array<string>, ...items: Array<Element>): ExcludeNode {
  return new ExcludeNode(typeof connectors === 'string' ? [connectors] : connectors, items);
}

// Zero-width negative lookahead: `not(x)` matches nothing and succeeds only when
// `x` would NOT match here.
export function not(item: Element): NotNode {
  return new NotNode(item);
}

// ── Precedence ──

interface PrecLevelDef {
  readonly __kind: 'prec-level';
  assoc: 'left' | 'right' | 'none';
  operators: Array<PrecOperator>;
}

type OpSpec = string | PrefixOps | PostfixOps | NoUnaryLhsOps;

function buildPrecOps(ops: Array<OpSpec>): Array<PrecOperator> {
  const result: Array<PrecOperator> = [];
  for (const o of ops) {
    if (typeof o === 'string') {
      result.push({ value: o, position: 'infix' });
    } else if (o.__kind === 'prefix-ops') {
      for (const v of o.ops) result.push({ value: v, position: 'prefix' });
    } else if (o.__kind === 'postfix-ops') {
      for (const v of o.ops) result.push({ value: v, position: 'postfix' });
    } else {
      for (const v of o.ops) result.push({ value: v, position: 'infix', noUnaryLhs: true });
    }
  }
  return result;
}

export function left(...ops: Array<OpSpec>): PrecLevelDef {
  return { __kind: 'prec-level', assoc: 'left', operators: buildPrecOps(ops) };
}

export function right(...ops: Array<OpSpec>): PrecLevelDef {
  return { __kind: 'prec-level', assoc: 'right', operators: buildPrecOps(ops) };
}

export function none(...ops: Array<OpSpec>): PrecLevelDef {
  return { __kind: 'prec-level', assoc: 'none', operators: buildPrecOps(ops) };
}

// ── AST conversion ──

function toRuleExpr(el: Element, names: Map<object, string>): RuleExpr {
  if (typeof el === 'string') {
    return { type: 'literal', value: el };
  }
  if (el instanceof TokenRef) {
    const name = names.get(el);
    if (!name) throw new Error('Token not registered in defineGrammar');
    return { type: 'ref', name };
  }
  if (el instanceof RuleRef) {
    const name = names.get(el);
    if (!name) throw new Error('Rule not registered in defineGrammar');
    return { type: 'ref', name };
  }
  if (el instanceof SepNode) {
    return { type: 'sep', element: toRuleExpr(el.item, names), delimiter: el.delimiter };
  }
  if (el instanceof OptNode) {
    const body = el.items.length === 1
      ? toRuleExpr(el.items[0], names)
      : { type: 'seq' as const, items: el.items.map((i) => toRuleExpr(i, names)) };
    return { type: 'quantifier', body, kind: '?' };
  }
  if (el instanceof ManyNode) {
    const body = el.items.length === 1
      ? toRuleExpr(el.items[0], names)
      : { type: 'seq' as const, items: el.items.map((i) => toRuleExpr(i, names)) };
    return { type: 'quantifier', body, kind: '*' };
  }
  if (el instanceof Many1Node) {
    const body = el.items.length === 1
      ? toRuleExpr(el.items[0], names)
      : { type: 'seq' as const, items: el.items.map((i) => toRuleExpr(i, names)) };
    return { type: 'quantifier', body, kind: '+' };
  }
  if (el instanceof ExcludeNode) {
    // Reuse the transparent `group` node (every walker recurses into `body`);
    // `suppress` is read only by the parser's expression engine.
    const body = el.items.length === 1
      ? toRuleExpr(el.items[0], names)
      : { type: 'seq' as const, items: el.items.map((i) => toRuleExpr(i, names)) };
    return { type: 'group', body, suppress: el.connectors };
  }
  if (el instanceof AltNode) {
    // A branch may be a single element or a sequence (array → seq).
    return {
      type: 'alt',
      items: el.items.map((i) => {
        if (Array.isArray(i)) {
          return i.length === 1
            ? toRuleExpr(i[0], names)
            : { type: 'seq' as const, items: i.map((x) => toRuleExpr(x, names)) };
        }
        return toRuleExpr(i, names);
      }),
    };
  }
  if (el instanceof NotNode) {
    return { type: 'not', body: toRuleExpr(el.item, names) };
  }
  const marker = el as Marker;
  if (marker.__kind === 'op') return { type: 'op' };
  if (marker.__kind === 'prefix') return { type: 'prefix' };
  if (marker.__kind === 'postfix') return { type: 'postfix' };
  if (marker.__kind === 'sameLine') return { type: 'sameLine' };
  throw new Error(`Unknown element: ${JSON.stringify(el)}`);
}

function convertAlternatives(alts: Array<Alternative>, names: Map<object, string>): RuleExpr {
  const items: Array<RuleExpr> = alts.map((a) => {
    if (Array.isArray(a)) {
      if (a.length === 1) return toRuleExpr(a[0], names);
      return { type: 'seq' as const, items: a.map((el) => toRuleExpr(el, names)) };
    }
    return toRuleExpr(a, names);
  });
  if (items.length === 1) return items[0];
  return { type: 'alt', items };
}

// ── Grammar assembly ──

interface GrammarConfig {
  name: string;
  scopeName?: string;
  tokens: Record<string, TokenRef>;
  prec?: Array<PrecLevelDef>;
  rules: Record<string, RuleRef>;
  scopes?: Record<string, Array<string>>;
  entry: RuleRef;
  markup?: MarkupConfig; // opt-in markup-mode tokenization (HTML/Vue)
  expression?: RuleRef; // the rule that produces an EXPRESSION; enables a derived `#expression` sub-grammar (expression-only embeds)
  aliasScopes?: Array<{ scope: string; file: string }>; // extra grammars re-exposing this one under another scopeName (e.g. text.html.derivative)
  canonicalRepoNames?: Record<string, string | Array<string>>; // official repo KEY NAME → structural key(s) for the SAME construct; gen-tm RENAMES the structural key (or synthesises a union wrapper) to emit the official name natively (the 限制器; see CstGrammar.canonicalRepoNames)
  manifest?: import('./types').ContributesManifest; // VS Code `contributes` packaging (emits a pasteable snippet)
}

export function defineGrammar(config: GrammarConfig): CstGrammar & { name: string; scopeName?: string } {
  const names = new Map<object, string>();
  for (const [name, tok] of Object.entries(config.tokens)) {
    names.set(tok, name);
  }
  for (const [name, r] of Object.entries(config.rules)) {
    names.set(r, name);
  }

  const tokens: Array<TokenDecl> = Object.entries(config.tokens).map(([name, tok]) => {
    const flags: Array<string> = [];
    if (tok.opts.skip) flags.push('skip');
    if (tok.opts.regex) flags.push('regex');
    return {
      name,
      pattern: tok.pattern.source,
      flags,
      scope: tok.opts.scope,
      escapePattern: tok.opts.escape?.source,
      escapeValidPattern: tok.opts.escapeValid?.source,
      embed: tok.opts.embed,
      identifier: tok.opts.identifier,
      template: tok.opts.template,
      regexContext: tok.opts.regexContext && {
        divisionAfterTypes: tok.opts.regexContext.divisionAfterTypes ?? [],
        divisionAfterTexts: tok.opts.regexContext.divisionAfterTexts ?? [],
        regexAfterTexts: tok.opts.regexContext.regexAfterTexts ?? [],
        regexAfterParenKeywords: tok.opts.regexContext.regexAfterParenKeywords ?? [],
        memberAccessTexts: tok.opts.regexContext.memberAccessTexts ?? [],
        postfixAfterValueTexts: tok.opts.regexContext.postfixAfterValueTexts ?? [],
      },
      string: tok.opts.string,
    };
  });

  const precs: Array<PrecLevel> = (config.prec ?? []).map((p) => ({
    assoc: p.assoc,
    operators: [...p.operators],
  }));

  const rules: Array<RuleDecl> = Object.entries(config.rules).map(([name, r]) => {
    const alts = r.def(r);
    return {
      name,
      body: convertAlternatives(alts, names),
      flags: r.opts.type ? ['type'] : [],
    };
  });

  const scopeOverrides = new Map<string, Array<string>>();
  if (config.scopes) {
    for (const [scope, literals] of Object.entries(config.scopes)) {
      for (const lit of literals) {
        const existing = scopeOverrides.get(lit);
        if (existing) {
          existing.push(scope);
        } else {
          scopeOverrides.set(lit, [scope]);
        }
      }
    }
  }

  return {
    name: config.name, scopeName: config.scopeName, tokens, precs, rules, scopeOverrides, markup: config.markup, expressionRule: config.expression ? names.get(config.expression) : undefined, aliasScopes: config.aliasScopes, canonicalRepoNames: config.canonicalRepoNames, manifest: config.manifest,
  };
}
