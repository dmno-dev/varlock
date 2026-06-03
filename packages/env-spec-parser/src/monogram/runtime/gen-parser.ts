import type { CstGrammar, RuleExpr, RuleDecl } from './types';
import { isKeywordLiteral } from './grammar-utils';
import { createLexer, type Token } from './gen-lexer';

// ── CST output ──

export interface CstNode {
  kind: 'node';
  rule: string;
  children: Array<CstChild>;
  offset: number;
  end: number;
}

export interface CstLeaf {
  kind: 'leaf';
  tokenType: string;
  text: string;
  offset: number;
  end: number;
}

export type CstChild = CstNode | CstLeaf;

// ── Precedence info ──

interface OpInfo {
  lbp: number;
  rbp: number;
  assoc: 'left' | 'right' | 'none';
  position: 'infix' | 'prefix' | 'postfix';
}

// ── Parser ──

export function createParser(grammar: CstGrammar) {
  const tokenNames = new Set(grammar.tokens.map((t) => t.name));

  // The lexer is a separate stage, built from the same grammar (token defs + lexer hints).
  const { tokenize } = createLexer(grammar);

  // Build precedence table
  const opTable = new Map<string, OpInfo>();
  const prefixOps = new Map<string, OpInfo>();
  // Infix ops whose LEFT operand may not be a bare unary-prefix expression (e.g. `**`).
  // A prefix op that is NOT also a postfix op is a "pure unary" prefix (`-`/`!`/`typeof`…)
  // as opposed to an update (`++`/`--`, which are both prefix and postfix); only the
  // pure-unary ones are forbidden before a noUnaryLhs operator.
  const noUnaryLhsOps = new Set<string>();
  const postfixOpValues = new Set<string>();

  for (let i = 0; i < grammar.precs.length; i++) {
    const level = grammar.precs[i];
    const bp = (i + 1) * 2;
    for (const op of level.operators) {
      if (op.position === 'prefix') {
        prefixOps.set(op.value, {
          lbp: 0,
          rbp: level.assoc === 'right' ? bp - 1 : bp,
          assoc: level.assoc,
          position: 'prefix',
        });
      } else if (op.position === 'postfix') {
        postfixOpValues.add(op.value);
        opTable.set(op.value, {
          lbp: bp,
          rbp: 0,
          assoc: level.assoc,
          position: 'postfix',
        });
      } else {
        const lbp = bp;
        const rbp = level.assoc === 'right' ? bp - 1 : bp;
        opTable.set(op.value, {
          lbp, rbp, assoc: level.assoc, position: 'infix',
        });
        if (op.noUnaryLhs) noUnaryLhsOps.add(op.value);
      }
    }
  }

  // Classify rules: which use Pratt parsing
  const prattRules = new Set<string>();
  for (const rule of grammar.rules) {
    if (hasMarker(rule.body)) prattRules.add(rule.name);
  }

  // For Pratt rules, split alternatives into NUD (atoms/prefix) and LED (left-recursive)
  function classifyAlts(rule: RuleDecl) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const nuds: Array<RuleExpr> = [];
    const leds: Array<{ expr: RuleExpr; items: Array<RuleExpr> }> = [];

    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      if (items[0]?.type === 'ref' && items[0].name === rule.name) {
        // Left-recursive: LED
        leds.push({ expr: alt, items: items.slice(1) });
      } else if (items.length >= 2 && items[0]?.type === 'prefix') {
        // prefix $ → NUD with prefix handling
        nuds.push(alt);
      } else {
        nuds.push(alt);
      }
    }
    return { nuds, leds };
  }

  // For non-Pratt left-recursive rules, split into atoms and continuations
  function classifyLeftRec(rule: RuleDecl) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const atoms: Array<RuleExpr> = [];
    const continuations: Array<Array<RuleExpr>> = [];

    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      if (items[0]?.type === 'ref' && items[0].name === rule.name) {
        continuations.push(items.slice(1));
      } else {
        atoms.push(alt);
      }
    }
    return { atoms, continuations };
  }

  function isLeftRecursive(rule: RuleDecl): boolean {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    return alts.some((alt) => {
      const items = alt.type === 'seq' ? alt.items : [alt];
      return items[0]?.type === 'ref' && items[0].name === rule.name;
    });
  }

  // Maximum binding power for non-operator LED patterns (member access, call, etc.)
  const maxBp = (grammar.precs.length + 1) * 2;
  const PROF = !!process.env.PROF; // per-rule call profiling (diagnostic)

  // ── Precomputed per-rule analysis ──
  // Rule lookup, left-recursion, and the NUD/LED (Pratt) / atom-continuation
  // (left-rec) classification are functions of the static grammar only, so we
  // compute them ONCE here instead of re-deriving them on every parse call.
  const ruleByName = new Map<string, RuleDecl>(grammar.rules.map((r) => [r.name, r]));
  const leftRecSet = new Set<string>(grammar.rules.filter(isLeftRecursive).map((r) => r.name));
  const prattClassified = new Map<string, ReturnType<typeof classifyAlts>>();
  const leftRecClassified = new Map<string, ReturnType<typeof classifyLeftRec>>();
  for (const rule of grammar.rules) {
    if (prattRules.has(rule.name)) prattClassified.set(rule.name, classifyAlts(rule));
    else if (leftRecSet.has(rule.name)) leftRecClassified.set(rule.name, classifyLeftRec(rule));
  }
  // The template token(s): the parser routes their tokens to the interpolation-aware
  // parseTemplateExpr path (the lexer owns producing them — see gen-lexer.ts).
  const templateTokenName = grammar.tokens.find((t) => t.template)?.name;
  const templateTokenNames = new Set<string>(grammar.tokens.filter((t) => t.template).map((t) => t.name));

  // ── First-token dispatch ──
  // For each alternative, the token it MUST begin with, if that is statically
  // knowable (a leading literal or token ref). When known, the alternative can
  // be skipped outright if the current token can't be its first token — so the
  // alternative loops branch on the lookahead instead of trying every arm.
  // `null` = not statically knowable (rule ref / prefix / optional first) → always try.
  type FirstTok = { lit: string } | { tok: string } | null;
  function firstTokenOf(alt: RuleExpr): FirstTok {
    const items = alt.type === 'seq' ? alt.items : [alt];
    const first = items[0];
    if (!first) return null;
    if (first.type === 'literal') return { lit: first.value };
    if (first.type === 'ref' && tokenNames.has(first.name)) return { tok: first.name };
    return null;
  }
  const firstOf = new Map<RuleExpr, FirstTok>();
  for (const rule of grammar.rules) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    for (const alt of alts) firstOf.set(alt, firstTokenOf(alt));
  }
  // Does a FIRST-set key (a token name, or a literal keyword/punctuation) match a token?
  function keyMatchesTok(key: string, tok: Token): boolean {
    if (tokenNames.has(key)) {
      if (tok.type === key) return true;
      return templateTokenNames.has(key) && tok.type === '$templateHead'; // interpolated template
    }
    if (isKeywordLiteral(key)) {
      return tok.type !== '' && tok.text === key; // keyword → ident token
    }
    return tok.type === '' && (tok.text === key || tok.text.startsWith(key)); // punctuation (startsWith covers split `>>`)
  }
  // Conservative: return true unless the alternative provably cannot start here.
  function canStart(first: FirstTok | undefined, tok: Token | null): boolean {
    if (!first || !tok) return true;
    return keyMatchesTok('tok' in first ? first.tok : first.lit, tok);
  }
  // First token of each Pratt LED continuation (the element right after `$`), so
  // the LED loop can skip leds whose continuation can't begin with the lookahead
  // — that loop was otherwise ~97% wasted matchSeq attempts that fail on token 1.
  const ledFirst = new Map<object, FirstTok>();
  for (const { leds } of prattClassified.values()) {
    for (const led of leds) ledFirst.set(led, firstTokenOf({ type: 'seq', items: led.items } as RuleExpr));
  }

  // ── Mixfix operand re-bound info ──
  // A LED of the shape `<lit L1> $self <lit L2> …` (e.g. a ternary `? $ : $`) has
  // an *inner* operand (`$self`, the bit between L1 and L2) that the greedy
  // non-backtracking engine may over-consume — swallowing the L2 the operator
  // itself needs (the classic conditional-`?:` vs arrow-return-type-`:` clash:
  // `b ? (c) : d => e`, where `(c): d => e` parses as one arrow, leaving no `:`).
  // When the normal match of such a LED fails, the LED loop retries the inner
  // operand with a position cap so it stops before an L2 at the operator's own
  // bracket-nesting depth, freeing that L2 for the operator. Language-agnostic:
  // keyed purely on the structural shape, no knowledge of `?`/`:`/arrows.
  function selfRefName(e: RuleExpr | undefined, ruleName: string): boolean {
    return !!e && e.type === 'ref' && e.name === ruleName;
  }
  type MixfixInfo = { openLit: string; sepLit: string };
  // A continuation `<lit L1> $self <lit L2> …` whose inner `$self` operand can
  // over-consume the `L2` the operator needs (e.g. ternary `? $ : $`, conditional
  // type `extends $ ? $ : $`). The re-bind retries that operand capped.
  function mixfixOf(items: Array<RuleExpr>, ruleName: string): MixfixInfo | null {
    if (items.length >= 4
      && items[0]?.type === 'literal'
      && selfRefName(items[1], ruleName)
      && items[2]?.type === 'literal') {
      return { openLit: items[0].value, sepLit: items[2].value };
    }
    return null;
  }
  const ledMixfix = new Map<object, MixfixInfo>();
  for (const [ruleName, { leds }] of prattClassified.entries()) {
    for (const led of leds) {
      const info = mixfixOf(led.items, ruleName);
      if (info) ledMixfix.set(led, info);
    }
  }
  // Same re-bind for left-recursive (non-Pratt) rules like `Type`, whose
  // continuations carry the implicit leading `$`, so they are already stripped.
  const contMixfix = new Map<object, MixfixInfo>();
  for (const [ruleName, { continuations }] of leftRecClassified.entries()) {
    for (const cont of continuations) {
      const info = mixfixOf(cont, ruleName);
      if (info) contMixfix.set(cont, info);
    }
  }

  // ── Access-tail LEDs (closed under a postfix operator) ──
  // A postfix operator (`a++`) turns its operand into an "update expression" that
  // member-access tails can no longer attach to: `a++[b]`, `a++.c`, `a++()`,
  // `a++<T>()`, `` a++`x` `` are all ill-formed (member access needs a primary, not
  // a postfix result). So once a postfix binds, such tails must NOT continue — the
  // bracketed term belongs to whatever follows (e.g. the next class field after an
  // ASI). Detected structurally, language-agnostically: an access tail is a non-op
  // LED that is "closed" (its last item is not a fresh same-rule operand, unlike a
  // binary/ternary `… in $` / `? $ : $`) AND whose connector is a punctuator, not a
  // word-operator — so `as`/`satisfies`/`in`/`instanceof`/`?:` still bind after `a++`.
  const accessTailLeds = new Set<object>();
  // ── Tail-closing LEDs (a LED that itself closes the access tail) ──
  // A LED ending in a zero-width *negative lookahead* (`… not($)`) asserts that
  // nothing may follow it, so its result cannot be the base of any further
  // member/element/call access — once it binds, the access tail is closed (no `.x`,
  // `[i]`, `(…)`, `<T>`, tagged template). Language-agnostic / structural: keyed on
  // the LED ending in a `not` assertion, with no knowledge of what it guards. (E.g.
  // a bare type-argument instantiation `Foo<T>` — written `… '>' not($)` — which TS
  // forbids from being followed by property access, TS1477.)
  const tailClosingLeds = new Set<object>();
  for (const [ruleName, { leds }] of prattClassified.entries()) {
    for (const led of leds) {
      const it = led.items;
      if (it.length === 0) continue;
      if (it[0].type === 'op' || it[0].type === 'postfix') continue; // operator LEDs, not tails
      const last = it[it.length - 1];
      const lastIsOperand = selfRefName(last, ruleName); // open binary/ternary operand
      const wordConnector = it[0].type === 'literal' && /^[A-Za-z]/.test(it[0].value);
      if (!lastIsOperand && !wordConnector) accessTailLeds.add(led);
      if (last.type === 'not') tailClosingLeds.add(led);
    }
  }

  // ── FIRST sets ──
  // The set of tokens each rule can begin with (null = "anything" — left-recursive
  // / prefix-operator rules, which can't be characterized). Used to skip parsing a
  // non-nullable rule reference outright when the lookahead can't start it — this
  // is what stops e.g. DecoratorExpr/TypeParams being speculatively parsed (and
  // failing) at every member/parameter position.
  const nullableRules = new Set<string>();
  function exprNullable(e: RuleExpr): boolean {
    switch (e.type) {
      case 'literal': return false;
      case 'ref': return tokenNames.has(e.name) ? false : nullableRules.has(e.name);
      case 'seq': return e.items.every(exprNullable);
      case 'alt': return e.items.some(exprNullable);
      case 'quantifier': return e.kind === '+' ? exprNullable(e.body) : true;
      case 'group': return exprNullable(e.body);
      case 'not': return true; // zero-width assertion: consumes nothing
      case 'sep': return true; // sep matches zero elements
      default: return true; // op/prefix/postfix markers don't consume
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const rule of grammar.rules) {
      if (!nullableRules.has(rule.name) && exprNullable(rule.body)) { nullableRules.add(rule.name); changed = true; }
    }
  }
  const firstSets = new Map<string, Set<string> | null>(); // null = top (anything)
  function exprFirst(e: RuleExpr): Set<string> | null {
    switch (e.type) {
      case 'literal': return new Set([e.value]);
      case 'ref': {
        if (tokenNames.has(e.name)) return new Set([e.name]);
        return firstSets.has(e.name) ? firstSets.get(e.name)! : new Set(); // unresolved → empty this round
      }
      case 'seq': {
        const acc = new Set<string>();
        for (const item of e.items) {
          if (item.type === 'prefix') return null; // prefix op → any operator token: give up
          if (item.type === 'op' || item.type === 'postfix' || item.type === 'not' || item.type === 'sameLine') continue; // non-consuming here
          const f = exprFirst(item);
          if (f === null) return null;
          for (const k of f) acc.add(k);
          if (!exprNullable(item)) return acc; // stop at first non-nullable element
        }
        return acc;
      }
      case 'alt': {
        const acc = new Set<string>();
        for (const item of e.items) {
          const f = exprFirst(item);
          if (f === null) return null;
          for (const k of f) acc.add(k);
        }
        return acc;
      }
      case 'quantifier': case 'group': return exprFirst(e.body);
      case 'not': case 'sameLine': return new Set(); // zero-width: contributes no FIRST tokens
      case 'sep': return exprFirst(e.element);
      default: return null;
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const rule of grammar.rules) {
      const prev = firstSets.get(rule.name);
      if (prev === null) continue; // null is terminal
      const next = exprFirst(rule.body);
      if (next === null) { firstSets.set(rule.name, null); changed = true; continue; }
      const merged = prev ? new Set(prev) : new Set<string>();
      let grew = false;
      for (const k of next) if (!merged.has(k)) { merged.add(k); grew = true; }
      if (grew || prev === undefined) { firstSets.set(rule.name, merged); changed = true; }
    }
  }
  // Can a (non-nullable) rule possibly begin with this token? Used to skip dead parseRule calls.
  function ruleMightStart(name: string, tok: Token | null): boolean {
    if (!tok || nullableRules.has(name)) return true;
    const fs = firstSets.get(name);
    if (!fs) return true; // null/unknown → don't filter
    for (const k of fs) if (keyMatchesTok(k, tok)) return true;
    return false;
  }

  // ── Parser core ──

  const profCounts = new Map<string, number>();
  function parse(source: string, entryRule?: string): CstNode {
    const tokens = tokenize(source);
    let pos = 0;
    let maxPos = 0; // farthest token index the parser ever attempted to read (diagnostic)
    // Packrat memo for pratt/left-recursive rules (Expr, Type, …): cache the
    // parse result + end position by start position, so backtracking doesn't
    // re-parse the same rule at the same spot. Sound because those rules reset
    // currentPrattContext (result is context-independent). Cleared on a `>>`
    // token splice (matchLiteral), which shifts later positions.
    const memo = new Map<string, Map<number, { node: CstNode | null; end: number }>>();

    // Bounded-parse cap (token index). When >= 0, no token at index >= parseLimit
    // may be consumed — i.e. a sub-parse is forced to stop before that token. Used
    // for the mixfix-operand re-parse (see matchMixfixLed): re-running an over-greedy
    // operand so it leaves a required separator for the enclosing mixfix operator.
    // `null`-equivalent is -1 (no cap). A capped parse is position+cap dependent,
    // so it bypasses the packrat memo (which is keyed by start position only).
    let parseLimit = -1;

    function peek(): Token | null {
      if (pos > maxPos) maxPos = pos;
      if (parseLimit >= 0 && pos >= parseLimit) return null;
      return tokens[pos] ?? null;
    }

    function offset(): number {
      return peek()?.offset ?? (tokens.length > 0 ? tokens[tokens.length - 1].offset + tokens[tokens.length - 1].text.length : 0);
    }

    // Match a literal string against current token
    function matchLiteral(value: string): CstLeaf | null {
      const tok = peek();
      if (!tok) return null;

      if (isKeywordLiteral(value)) {
        // Keyword literal: match against Ident token with same text
        if (tok.type !== '' && tokenNames.has(tok.type) && tok.text === value) {
          pos++;
          return {
            kind: 'leaf', tokenType: '$keyword', text: value, offset: tok.offset, end: tok.offset + tok.text.length,
          };
        }
        return null;
      }
      // Punctuation literal
      if (tok.type === '' && tok.text === value) {
        pos++;
        return {
          kind: 'leaf', tokenType: '$punct', text: value, offset: tok.offset, end: tok.offset + tok.text.length,
        };
      }
      // Split multi-`>` tokens: `>>`, `>>>`, `>>=`, `>>>=` can yield a single `>`
      if (value === '>' && tok.type === '' && tok.text.length > 1 && tok.text[0] === '>') {
        const rest = tok.text.slice(1);
        tokens.splice(
          pos,
          1,
          { type: '', text: '>', offset: tok.offset },
          { type: '', text: rest, offset: tok.offset + 1 },
        );
        memo.clear(); // splice shifts later token indices → memo entries are stale
        pos++;
        return {
          kind: 'leaf', tokenType: '$punct', text: '>', offset: tok.offset, end: tok.offset + 1,
        };
      }
      return null;
    }

    // Match a token ref
    function matchToken(name: string): CstLeaf | null {
      const tok = peek();
      if (!tok) return null;
      if (tok.type === name) {
        pos++;
        return {
          kind: 'leaf', tokenType: name, text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length,
        };
      }
      return null;
    }

    let currentPrattContext: string | null = null;
    // LED-connector exclusion (no-`in`-style contexts). `suppressNext` is set by a
    // `group` node carrying `suppress`, then consumed by the NEXT pratt/left-rec
    // rule it wraps; `suppressCur` is that rule's active exclusion. Recursive
    // parsePratt (operator RHS) inherit it; a nested parseRule (bracketed group,
    // operand of a non-op LED) resets it — matching the spec's [~In] propagation.
    let suppressNext: Set<string> | null = null;
    let suppressCur: Set<string> | null = null;

    function parseTemplateExpr(): CstChild | null {
      const tok = peek();
      if (!tok) return null;
      if (tok.type === templateTokenName) {
        pos++;
        return {
          kind: 'leaf', tokenType: templateTokenName, text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length,
        };
      }
      if (tok.type === '$templateHead') {
        const children: Array<CstChild> = [];
        pos++;
        children.push({
          kind: 'leaf', tokenType: '$templateHead', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length,
        });
        const interpRule = currentPrattContext ?? findExprRule();
        while (true) {
          const exprNode = parseRule(interpRule);
          if (exprNode) children.push(exprNode);
          const next = peek();
          if (!next) break;
          if (next.type === '$templateMiddle') {
            pos++;
            children.push({
              kind: 'leaf', tokenType: '$templateMiddle', text: next.text, offset: next.offset, end: next.offset + next.text.length,
            });
            continue;
          }
          if (next.type === '$templateTail') {
            pos++;
            children.push({
              kind: 'leaf', tokenType: '$templateTail', text: next.text, offset: next.offset, end: next.offset + next.text.length,
            });
            break;
          }
          break;
        }
        const startOff = children.length > 0 ? childOffset(children[0]) : offset();
        const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();
        return {
          kind: 'node', rule: '$template', children, offset: startOff, end: endOff,
        };
      }
      return null;
    }

    function findExprRule(): string {
      for (const r of grammar.rules) {
        if (prattRules.has(r.name) && r.name !== 'Type') return r.name;
      }
      return grammar.rules[0].name;
    }

    // Parse a rule by name
    function parseRule(name: string): CstNode | null {
      if (PROF) profCounts.set(name, (profCounts.get(name) ?? 0) + 1);
      const rule = ruleByName.get(name);
      if (!rule) throw new Error(`Unknown rule: ${name}`);

      const isPratt = prattRules.has(name);
      const isLeftRec = leftRecSet.has(name);
      // Non-recursive rules don't reset context and aren't memoized.
      if (!isPratt && !isLeftRec) return parseNonRec(rule);

      // Consume any pending LED exclusion: it applies to THIS rule only, so clear
      // the pending slot first (nested parseRule calls reset to allow-in).
      const mySup = suppressNext;
      suppressNext = null;

      // Memoizable (pratt / left-recursive): look up by start position. A
      // suppressed parse (no-`in` context) or a capped parse (parseLimit active,
      // from the mixfix re-bind retry) is context/position+cap dependent, so it
      // bypasses the position-keyed packrat memo entirely.
      const capped = parseLimit >= 0;
      const start = pos;
      let m = memo.get(name);
      if (!mySup && !capped) {
        const hit = m && m.get(start);
        if (hit !== undefined) { pos = hit.end; return hit.node; }
      }

      const prevContext = currentPrattContext;
      currentPrattContext = name;
      const prevSup = suppressCur;
      suppressCur = mySup;
      let result: CstNode | null;
      try {
        result = isPratt ? parsePratt(rule, 0) : parseLeftRec(rule);
      } finally {
        currentPrattContext = prevContext;
        suppressCur = prevSup;
      }
      if (!mySup && !capped) {
        if (!m) { m = new Map(); memo.set(name, m); }
        m.set(start, { node: result, end: pos });
      }
      return result;
    }

    // Non-recursive rule: try alternatives, pick longest match
    function parseNonRec(rule: RuleDecl): CstNode | null {
      const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
      const saved = pos;

      let bestNode: CstNode | null = null;
      let bestPos = saved;
      const startTok = tokens[saved] ?? null;

      for (const alt of alts) {
        if (!canStart(firstOf.get(alt), startTok)) continue;
        pos = saved;
        const children = matchExpr(alt);
        if (children !== null && pos > bestPos) {
          const startOff = children.length > 0 ? childOffset(children[0]) : offset();
          const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();
          bestNode = {
            kind: 'node', rule: rule.name, children, offset: startOff, end: endOff,
          };
          bestPos = pos;
        }
      }

      if (bestNode) { pos = bestPos; return bestNode; }
      pos = saved;
      return null;
    }

    // Left-recursive rule without Pratt: parse atom then try continuations
    function parseLeftRec(rule: RuleDecl): CstNode | null {
      const { atoms, continuations } = leftRecClassified.get(rule.name)!;
      const saved = pos;

      // Parse atom (longest match)
      let node: CstNode | null = null;
      let bestAtomPos = saved;
      const startTok = tokens[saved] ?? null;
      for (const atom of atoms) {
        if (!canStart(firstOf.get(atom), startTok)) continue;
        pos = saved;
        const children = matchExpr(atom);
        if (children !== null && pos > bestAtomPos) {
          const startOff = children.length > 0 ? childOffset(children[0]) : offset();
          const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();
          node = {
            kind: 'node', rule: rule.name, children, offset: startOff, end: endOff,
          };
          bestAtomPos = pos;
        }
      }
      if (!node) { pos = saved; return null; }
      pos = bestAtomPos;

      // Try continuations repeatedly
      outer: while (true) {
        const contSaved = pos;
        for (const cont of continuations) {
          pos = contSaved;
          let children = matchSeq(cont);
          // Mixfix operand re-bind (same fix parsePratt uses): a continuation of the
          // shape `<lit> $self <lit> …` (e.g. the conditional type `extends $ ? $ : $`)
          // can have its inner operand over-consume the separator the operator needs
          // (an `infer U extends T ? …` swallowing the conditional's `?`). Retry it
          // capped so the operand stops before that separator.
          if (children === null) {
            const mix = contMixfix.get(cont);
            if (mix) { pos = contSaved; children = matchMixfixLed({ items: cont }, rule.name, mix); }
          }
          if (children !== null) {
            node = {
              kind: 'node',
              rule: rule.name,
              children: [node, ...children],
              offset: node.offset,
              end: children.length > 0 ? childEnd(children[children.length - 1]) : node.end,
            };
            continue outer;
          }
        }
        pos = contSaved;
        break;
      }

      return node;
    }

    // Pratt parser for rules with op/prefix/postfix
    function parsePratt(rule: RuleDecl, minBp: number): CstNode | null {
      const { nuds, leds } = prattClassified.get(rule.name)!;
      const saved = pos;

      // NUD: parse atom or prefix (longest match)
      let lhs: CstNode | null = null;
      let bestNudPos = saved;
      const startTok = tokens[saved] ?? null;
      for (const nud of nuds) {
        if (!canStart(firstOf.get(nud), startTok)) continue;
        pos = saved;
        const items = nud.type === 'seq' ? nud.items : [nud];

        // prefix $ pattern
        if (items[0]?.type === 'prefix') {
          const tok = peek();
          if (tok) {
            const key = tok.text;
            const info = prefixOps.get(key);
            if (info) {
              pos++;
              const opLeaf: CstLeaf = {
                kind: 'leaf', tokenType: '$operator', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length,
              };
              const rhs = parsePratt(rule, info.rbp);
              if (rhs && pos > bestNudPos) {
                lhs = {
                  kind: 'node', rule: rule.name, children: [opLeaf, rhs], offset: opLeaf.offset, end: rhs.end,
                };
                bestNudPos = pos;
              }
            }
          }
          continue;
        }

        const children = matchExpr(nud);
        if (children !== null && pos > bestNudPos) {
          const startOff = children.length > 0 ? childOffset(children[0]) : offset();
          const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();
          lhs = {
            kind: 'node', rule: rule.name, children, offset: startOff, end: endOff,
          };
          bestNudPos = pos;
        }
      }
      if (lhs) pos = bestNudPos;

      if (!lhs) { pos = saved; return null; }

      // Once a postfix operator binds (`a++`), the operand is an update expression
      // that access tails (`[…]`, `.x`, `(…)`, `<T>`, tagged template) can't extend.
      let tailClosed = false;

      // LED loop
      while (true) {
        const tok = peek();
        if (!tok) break;

        const ledSaved = pos;
        let matched = false;

        // Check non-op LED patterns first ($ '.' Ident, $ '<' ... '>' '(', etc.)
        for (const led of leds) {
          if (led.items[0]?.type === 'op' || led.items[0]?.type === 'postfix') continue;
          if (maxBp <= minBp) continue;
          if (tailClosed && accessTailLeds.has(led)) continue; // no access tail after a postfix
          // Skip a LED whose connector is excluded in this context (e.g. `in` under
          // a no-`in` for-head) — it rebinds to the enclosing rule instead.
          if (suppressCur && led.items[0]?.type === 'literal' && suppressCur.has(led.items[0].value)) continue;
          if (!canStart(ledFirst.get(led), tok)) continue; // first-token dispatch for LED continuations

          pos = ledSaved;
          let children = matchSeq(led.items);
          // Mixfix operand re-bound: if a `<L1> $ <L2> …` LED failed, the inner
          // operand may have over-consumed the L2 it needs — retry it capped.
          if (children === null && ledMixfix.has(led)) {
            pos = ledSaved;
            children = matchMixfixLed(led, rule.name, ledMixfix.get(led)!);
          }
          if (children !== null) {
            lhs = {
              kind: 'node',
              rule: rule.name,
              children: [lhs, ...children],
              offset: lhs.offset,
              end: children.length > 0 ? childEnd(children[children.length - 1]) : lhs.end,
            };
            // A LED ending in a negative lookahead (e.g. a bare instantiation
            // `Foo<T>`) closes the access tail: nothing may chain off it.
            if (tailClosingLeds.has(led)) tailClosed = true;
            matched = true;
            break;
          }
        }

        if (matched) continue;

        // Then check $ op $ pattern
        const tokKey = tok.text;
        const info = opTable.get(tokKey);
        if (info && info.lbp > minBp) {
          if (info.position === 'postfix') {
            if (!tailClosed) { // can't postfix an update expr (`a++ --`)
              pos++;
              const opLeaf: CstLeaf = {
                kind: 'leaf', tokenType: '$operator', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length,
              };
              lhs = {
                kind: 'node', rule: rule.name, children: [lhs, opLeaf], offset: lhs.offset, end: opLeaf.end,
              };
              tailClosed = true;
              matched = true;
            }
          } else {
            // A `noUnaryLhs` op (e.g. `**`) may not take a bare unary-prefix expression
            // (`-x`, `typeof x` — a prefix-op node whose op is NOT also a postfix, i.e.
            // not an update `++`/`--`) as its LEFT operand. Fail the whole expression
            // hard (return null) rather than just declining to bind — otherwise it could
            // reparse another way (left-assoc `(x ** -y) ** z`, or `typeof` as a bare
            // identifier splitting the statement). `(-x) ** y` is unaffected: lhs is then
            // a parenthesized node, not a prefix node.
            if (noUnaryLhsOps.has(tokKey) && lhs.kind === 'node') {
              const head = lhs.children[0];
              if (head?.kind === 'leaf' && head.tokenType === '$operator'
                  && prefixOps.has(head.text) && !postfixOpValues.has(head.text)) {
                return null;
              }
            }
            pos++;
            const opLeaf: CstLeaf = {
              kind: 'leaf', tokenType: '$operator', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length,
            };
            const rhs = parsePratt(rule, info.rbp);
            if (rhs) {
              lhs = {
                kind: 'node', rule: rule.name, children: [lhs, opLeaf, rhs], offset: lhs.offset, end: rhs.end,
              };
              matched = true;
            } else {
              pos = ledSaved;
            }
          }
          if (matched) continue;
        }

        if (!matched) { pos = ledSaved; break; }
      }

      return lhs;
    }

    // Match a RuleExpr, return children or null
    function matchExpr(expr: RuleExpr): Array<CstChild> | null {
      switch (expr.type) {
        case 'literal': {
          const leaf = matchLiteral(expr.value);
          return leaf ? [leaf] : null;
        }
        case 'ref': {
          if (tokenNames.has(expr.name)) {
            // Template tokens: also handle interpolated templates
            if (templateTokenNames.has(expr.name)) {
              const tmpl = parseTemplateExpr();
              if (tmpl) return [tmpl];
            }
            const leaf = matchToken(expr.name);
            return leaf ? [leaf] : null;
          }
          // Skip the rule entirely if the lookahead can't begin it (and it can't
          // match empty) — avoids speculatively parsing+failing rules like
          // DecoratorExpr/TypeParams at every position.
          if (!ruleMightStart(expr.name, peek())) return null;
          const node = parseRule(expr.name);
          return node ? [node] : null;
        }
        case 'seq':
          return matchSeq(expr.items);
        case 'alt': {
          const saved = pos;
          for (const item of expr.items) {
            pos = saved;
            const result = matchExpr(item);
            if (result !== null) return result;
          }
          pos = saved;
          return null;
        }
        case 'quantifier':
          return matchQuantifier(expr.body, expr.kind);
        case 'group':
          // A `suppress`-carrying group disables the listed LED connectors for the
          // rule it wraps: stage them for the next parseRule to pick up.
          if (expr.suppress && expr.suppress.length) suppressNext = new Set(expr.suppress);
          return matchExpr(expr.body);
        case 'not': {
          // Zero-width negative lookahead: succeed (no children) iff the body
          // does NOT match here; never consume input either way.
          const saved = pos;
          const m = matchExpr(expr.body);
          pos = saved;
          return m === null ? [] : null;
        }
        case 'sameLine': {
          // Zero-width "no LineTerminator here": succeed (no children) iff the
          // next token isn't preceded by a newline. At EOF there's no token to
          // continue onto, so the assertion fails (nothing same-line follows).
          const tok = peek();
          return tok && !tok.newlineBefore ? [] : null;
        }
        case 'sep':
          return matchSep(expr.element, expr.delimiter);
        default:
          // op / prefix / postfix markers are handled by the Pratt parser.
          return null;
      }
    }

    function matchSeq(items: Array<RuleExpr>): Array<CstChild> | null {
      const saved = pos;
      const children: Array<CstChild> = [];
      for (const item of items) {
        // Skip op/prefix/postfix markers in sequence (handled by Pratt)
        if (item.type === 'op' || item.type === 'prefix' || item.type === 'postfix') continue;
        const result = matchExpr(item);
        if (result === null) { pos = saved; return null; }
        children.push(...result);
      }
      return children;
    }

    // Mixfix operand re-bound (see ledMixfix). The LED shape is
    // `<openLit> $self <sepLit> …rest`; the normal match already failed. Re-parse
    // the inner `$self` operand with a position cap so it stops before a `sepLit`
    // token at the *same* bracket depth as `openLit`, freeing that token for the
    // operator's own separator, then match `sepLit` and the rest uncapped.
    // `pos` is at `openLit` on entry. Returns the LED children or null (restored).
    function matchMixfixLed(led: { items: Array<RuleExpr> }, ruleName: string, info: { openLit: string; sepLit: string }): Array<CstChild> | null {
      const saved = pos;
      const openLeaf = matchLiteral(info.openLit);
      if (!openLeaf) { pos = saved; return null; }
      const afterOpen = pos;

      // Greedy parse of the operand, to (a) confirm the separator is missing right
      // after it (otherwise the failure is elsewhere → don't apply) and (b) bound
      // the scan window.
      const operand = parseRule(ruleName);
      if (!operand) { pos = saved; return null; }
      const greedyEnd = pos;
      // If the separator DOES match here, the LED's failure was later in `rest`,
      // not operand over-consumption — re-bounding wouldn't help.
      if (matchLiteral(info.sepLit)) { pos = saved; return null; }

      // Candidate separator positions: `sepLit` tokens at bracket depth 0 within
      // (afterOpen, greedyEnd). A nested same-shape operator (e.g. a nested
      // ternary) contributes its own depth-0 `sepLit`, so we try candidates in
      // order and accept the first where the capped operand lands exactly on it.
      let depth = 0;
      const candidates: Array<number> = [];
      for (let i = afterOpen; i < greedyEnd; i++) {
        const t = tokens[i];
        if (t.type !== '') continue; // only punctuation carries brackets/sep
        if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
        else if (t.text === ')' || t.text === ']' || t.text === '}') depth--;
        else if (depth === 0 && t.text === info.sepLit) candidates.push(i);
      }

      for (const sepIdx of candidates) {
        // Re-parse the operand capped so it cannot consume the token at sepIdx;
        // accept only if the operand consumes everything up to exactly there.
        pos = afterOpen;
        const prevLimit = parseLimit;
        parseLimit = sepIdx;
        const reOperand = parseRule(ruleName);
        parseLimit = prevLimit;
        if (!reOperand || pos !== sepIdx) continue;

        const sepLeaf = matchLiteral(info.sepLit);
        if (!sepLeaf) continue;
        const rest = matchSeq(led.items.slice(3));
        if (rest === null) continue;
        return [openLeaf, reOperand, sepLeaf, ...rest];
      }

      pos = saved;
      return null;
    }

    function matchQuantifier(body: RuleExpr, kind: '*' | '+' | '?'): Array<CstChild> | null {
      if (kind === '?') {
        const result = matchExpr(body);
        return result ?? [];
      }
      if (kind === '*') {
        const children: Array<CstChild> = [];
        while (true) {
          const saved = pos;
          const result = matchExpr(body);
          if (result === null) { pos = saved; break; }
          if (result.length === 0 && pos === saved) break;
          children.push(...result);
        }
        return children;
      }
      // kind === '+'
      const first = matchExpr(body);
      if (first === null) return null;
      const children: Array<CstChild> = [...first];
      while (true) {
        const saved = pos;
        const result = matchExpr(body);
        if (result === null) { pos = saved; break; }
        if (result.length === 0 && pos === saved) break;
        children.push(...result);
      }
      return children;
    }

    function matchSep(element: RuleExpr, delimiter: string): Array<CstChild> | null {
      // sep = (element (delimiter element)*)?
      const saved = pos;
      const first = matchExpr(element);
      if (first === null) { pos = saved; return []; }
      const children: Array<CstChild> = [...first];
      while (true) {
        const delimSaved = pos;
        const delimLeaf = matchLiteral(delimiter);
        if (!delimLeaf) { pos = delimSaved; break; }
        const next = matchExpr(element);
        if (next === null) { children.push(delimLeaf); break; } // trailing delimiter OK
        children.push(delimLeaf, ...next);
      }
      return children;
    }

    // Entry
    const entry = entryRule ?? findEntryRule(grammar);
    if (tokens.length === 0) {
      return {
        kind: 'node', rule: entry, children: [], offset: 0, end: 0,
      };
    }
    const result = parseRule(entry);
    if (!result) {
      const tok = peek();
      throw new Error(`Parse error at offset ${tok?.offset ?? 0}: unexpected ${tok ? `'${tok.text}'` : 'end of input'}${farthest(pos)}`);
    }
    // Check all input consumed
    if (pos < tokens.length) {
      const tok = tokens[pos];
      throw new Error(`Parse error at offset ${tok.offset}: unexpected '${tok.text}' after successful parse${farthest(pos)}`);
    }
    return result;

    // Diagnostic: when backtracking reached further than the reported error
    // position, point at that deepest spot — it's usually nearer the real cause.
    function farthest(errPos: number): string {
      if (maxPos <= errPos || maxPos >= tokens.length) return '';
      const tok = tokens[maxPos];
      return ` [farthest: offset ${tok.offset} near '${tok.text.slice(0, 20)}']`;
    }
  }

  return { parse, tokenize, profCounts };
}

// ── Helpers ──

function hasMarker(expr: RuleExpr): boolean {
  if (expr.type === 'op' || expr.type === 'prefix' || expr.type === 'postfix') return true;
  if (expr.type === 'seq' || expr.type === 'alt') return expr.items.some(hasMarker);
  if (expr.type === 'quantifier' || expr.type === 'group') return hasMarker(expr.body);
  if (expr.type === 'sep') return hasMarker(expr.element);
  return false;
}

function findEntryRule(grammar: CstGrammar): string {
  return grammar.rules[grammar.rules.length - 1].name;
}

function childOffset(child: CstChild): number {
  return child.offset;
}

function childEnd(child: CstChild): number {
  return child.end;
}
