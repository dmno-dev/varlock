// Structural primitives over the grammar AST (RuleExpr), shared by the parser
// generator (gen-parser) and the TextMate highlighter generator (gen-tm).
//
// Only PURE, structural helpers belong here — the small things both consumers
// build on. The high-level logic stays separate: gen-parser's parse strategy
// (FIRST sets, left-recursion, Pratt classification) answers "how to parse";
// gen-tm's shape detection answers "how to emit TextMate regexes". Those change
// for different reasons and must not be coupled.
import type { RuleExpr } from './types';

/** True if `code` is an identifier-start character: a-z, A-Z, `_`, or `$`. */
export function isIdentStartCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95 || code === 36;
}

/**
 * Classify a grammar literal as a keyword/identifier-word (`new`, `readonly`, …)
 * vs punctuation (`=>`, `+`, `(`, …). Decided by the first character: every
 * literal/operator in the grammar is either identifier-shaped or starts with
 * punctuation, so the first char discriminates (verified: 0 divergence from a
 * full all-characters check across all 144 literals/operators/token names).
 *
 * charCode-based, NO regex — this runs in the parse hot path (matchLiteral,
 * keyMatchesTok), where a regex-per-call measurably regressed throughput.
 *
 * Single source of truth so the parser and the highlighter classify keywords
 * IDENTICALLY — the project's "single grammar → parser + highlighter, never
 * disagree" invariant would be violated by two private predicates.
 */
export function isKeywordLiteral(s: string): boolean {
  return isIdentStartCode(s.charCodeAt(0));
}

/** Every literal string reachable in a rule expression (incl. `sep` delimiters). */
export function collectLiterals(expr: RuleExpr): Array<string> {
  switch (expr.type) {
    case 'literal': return [expr.value];
    case 'seq': case 'alt': return expr.items.flatMap(collectLiterals);
    case 'quantifier': case 'group': return collectLiterals(expr.body);
    case 'sep': return [...collectLiterals(expr.element), expr.delimiter];
    default: return [];
  }
}

// ── regex-source primitives: pull literal delimiters out of a token's pattern ──
// Structural, language-agnostic string surgery over a regex source. Shared so the
// highlighter (gen-tm) and the editor-config (gen-vscode-config) recover a token's
// delimiters from ONE implementation — e.g. both read a `string` token's quote chars
// the same way, so a `~…~` string yields `~` in both, never a hardcoded `"`.

// The literal "runs" in a regex source, skipping char classes and metachars and
// unescaping escaped punctuation (but treating `\s`,`\d`,`\b`,… as run boundaries).
// e.g. a `/*…*/` block-comment source → ['/*', '*/']; a `//…` source → ['//'].
export function literalRuns(src: string): Array<string> {
  const runs: Array<string> = [];
  let cur = ''; let inClass = false; let
    i = 0;
  if (src[i] === '^') i++;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1] ?? ''; i++;
      if (/[a-zA-Z]/.test(n)) { if (cur) { runs.push(cur); cur = ''; } continue; } // \s \d \b … → boundary
      if (!inClass) cur += n; // \/ \* \. … → literal char
      continue;
    }
    if (c === '[') { if (cur) { runs.push(cur); cur = ''; } inClass = true; continue; }
    if (c === ']') { inClass = false; continue; }
    if (inClass) continue;
    if ('(){}.*+?|$'.includes(c)) { if (cur) { runs.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) runs.push(cur);
  return runs;
}

// Split a regex source into its TOP-LEVEL `|` alternatives (depth 0, outside
// char classes). e.g. a string token `"(?:…)*"|'(?:…)*'` → ['"(?:…)*"', "'(?:…)*'"].
export function topLevelAlternatives(src: string): Array<string> {
  const out: Array<string> = [];
  let cur = ''; let depth = 0; let
    inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { cur += c + (src[i + 1] ?? ''); i++; continue; }
    if (inClass) { cur += c; if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { depth--; cur += c; continue; }
    if (c === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Delimiter(s) of a string token: the leading literal of each top-level
// alternative (any char — `"`, `'`, `«`, `"""`, …; NOT hardcoded to JS quotes).
export function stringDelimiters(src: string): Array<string> {
  return topLevelAlternatives(src).map((b) => literalRuns(b)[0]).filter(Boolean);
}
