import type { CstGrammar } from './types';
import { collectLiterals, isKeywordLiteral } from './grammar-utils';

// A lexer token: a declared token (type = its name) or a punctuation literal (type = '').
// `$templateHead/$templateMiddle/$templateTail` are synthetic types the lexer emits for
// the pieces of an interpolated template — role names, not language-specific.
export interface Token {
  type: string; // token decl name (e.g. 'Ident'), or '' for punctuation literals
  text: string;
  offset: number;
  newlineBefore?: boolean; // a line terminator preceded this token (drives ASI / "no LineTerminator here" rules)
}

// Build a standalone lexer from the grammar's token definitions + lexer hints.
// It depends ONLY on tokens/precs — never on the parse rules — so it is the first
// derived stage: grammar → lexer → parser (and grammar → highlighter), all from one
// definition. The parser composes this (see gen-parser.ts).
export function createLexer(grammar: CstGrammar) {
  // Punctuation literals from rules + operators (everything that isn't a keyword word).
  const allLiterals = new Set<string>();
  for (const rule of grammar.rules) for (const l of collectLiterals(rule.body)) allLiterals.add(l);
  for (const level of grammar.precs) for (const op of level.operators) allLiterals.add(op.value);
  const punctLiterals = [...allLiterals]
    .filter((l) => !isKeywordLiteral(l))
    .sort((a, b) => b.length - a.length);

  // Token matchers (order matters: earlier declarations win)
  const tokenMatchers = grammar.tokens.map((t) => ({
    name: t.name,
    regex: new RegExp(`^(?:${t.pattern})`),
    skip: t.flags.includes('skip'),
    isRegex: t.flags.includes('regex'),
  }));

  // ── Lexer hints (declared per-token in the grammar; nothing here hardcodes a
  // specific language's tokens — see the `identifier`/`template`/`regexContext` opts) ──
  const identTokenName = grammar.tokens.find((t) => t.identifier)?.name;
  const templateToken = grammar.tokens.find((t) => t.template);
  const templateTokenName = templateToken?.name;
  const tplOpen = templateToken?.template?.open ?? '';
  const tplInterpOpen = templateToken?.template?.interpOpen ?? '';
  const tplInterpClose = templateToken?.template?.interpClose ?? '';
  const tplBraceOpen = tplInterpOpen.slice(-1); // brace that deepens interp nesting ('{' of '${')
  const tplOpenCode = tplOpen.length === 1 ? tplOpen.charCodeAt(0) : -1; // fast path when the open delimiter is one char
  // A valid single escape sequence inside a template; when declared, an escape that
  // does not match it is a scan error — but only outside tag position (a tagged
  // template legally carries invalid escapes). Sticky `y` so it matches at `pos`.
  const templateEscapeValidRe = templateToken?.escapeValidPattern
    ? new RegExp(templateToken.escapeValidPattern, 'y')
    : null;

  // Regex-vs-division context: declared by the grammar's `regex` token. ($templateTail
  // is the lexer's own synthetic template-end token — always a completed value, so `/`
  // after it is division in any language; added here rather than asked of the grammar.)
  const regexCtx = grammar.tokens.find((t) => t.regexContext)?.regexContext;
  const divisionPrevTypes = new Set([...(regexCtx?.divisionAfterTypes ?? []), '$templateTail']);
  const divisionPrevTexts = new Set(regexCtx?.divisionAfterTexts ?? []);
  const expressionStartKeywords = new Set(regexCtx?.regexAfterTexts ?? []);
  // Keywords that head a `kw ( … )` control group; the matching `)` is a statement
  // head (not a value), so a following `/` is a regex, not division.
  const parenHeadKeywords = new Set(regexCtx?.regexAfterParenKeywords ?? []);
  // Member-access texts (`.`/`?.`): a keyword right after one is a property name, so
  // the control-head rule above does not apply (`obj.for(x) / y` is a call/division).
  const memberAccessTexts = new Set(regexCtx?.memberAccessTexts ?? []);
  // Postfix ops ambiguous with a prefix op of the same spelling (TS `!`): value-producing
  // only in postfix position (after a value), so a following `/` is division then but a
  // regex when it's the prefix form (`!/re/`). Resolved per-occurrence (see lastBangWasPostfix).
  const postfixAfterValueTexts = new Set(regexCtx?.postfixAfterValueTexts ?? []);

  // ── Markup mode (opt-in; entirely dormant unless the grammar declares `markup`) ──
  // Drives a text/tag/raw-text state machine in tokenize(); all delimiters are grammar
  // DATA (nothing here hardcodes `<`/`>`/HTML), and transitions are keyed only on the
  // tokens the lexer itself emits, so it needs no parser feedback.
  const markup = grammar.markup;
  const rawTextTagSet = new Set((markup?.rawText?.tags ?? []).map((t) => t.toLowerCase()));
  const voidTagSet = new Set((markup?.voidTags ?? []).map((t) => t.toLowerCase()));
  // Markup content tokens are emitted by the state machine, not matched by a regex in
  // the normal loop (like the template token) — else a greedy text pattern would hijack
  // tag-mode tokenizing. The void-name token is a RETAG target (never matched fresh),
  // skipped here too so its placeholder pattern can't shadow the identifier token.
  const markupTokenNames = new Set<string>(
    [markup?.textToken, markup?.rawText?.token, markup?.comment?.token, markup?.voidNameToken].filter(Boolean) as Array<string>,
  );

  // Scan from inside a template span to its next boundary: an interpolation hole
  // (`interpOpen`) or the closing delimiter (`open`). Delimiters come from the
  // grammar's template token; only called when such a token is declared.
  function scanTemplateSpan(source: string, pos: number, validateEscapes: boolean): { endsWithInterp: boolean; end: number } {
    while (pos < source.length) {
      if (source[pos] === '\\') {
        // In tag position invalid escapes are legal (validateEscapes=false): just skip
        // `\` + next char. Otherwise the escape must match the token's declared
        // escapeValid pattern, else it's a scan error (e.g. `\u{110000}`, `\u{r}`).
        if (validateEscapes && templateEscapeValidRe) {
          templateEscapeValidRe.lastIndex = pos;
          const m = templateEscapeValidRe.exec(source);
          if (!m) throw new Error(`Invalid escape sequence in template at offset ${pos}`);
          pos += m[0].length;
        } else {
          pos += 2;
        }
      } else if (source.startsWith(tplInterpOpen, pos)) {
        return { endsWithInterp: true, end: pos + tplInterpOpen.length };
      } else if (source.startsWith(tplOpen, pos)) {
        return { endsWithInterp: false, end: pos + tplOpen.length };
      } else {
        pos++;
      }
    }
    throw new Error(`Unterminated template literal at offset ${pos}`);
  }

  function tokenize(source: string): Array<Token> {
    const tokens: Array<Token> = [];
    let pos = 0;
    const templateStack: Array<number> = [];
    // For each open `(`, whether it heads a control group (`if`/`while`/…) so the
    // matching `)` is a statement head, not a value. `lastCloseWasParenHead` carries
    // that to the regex-vs-division check (consulted only when prev is `)`).
    const parenHeadStack: Array<boolean> = [];
    let lastCloseWasParenHead = false;
    // Whether the most-recently-emitted ambiguous postfix/prefix op (e.g. `!`) was in
    // POSTFIX position — i.e. followed a value, so it is itself value-producing (non-null
    // `x!`) and a following `/` is division. False ⇒ it was the prefix form (`!x`, `!/re/`),
    // so a `/` right after it is a regex. Read by prevIsValue when prev is such a token.
    let lastBangWasPostfix = false;
    // A line terminator was seen since the last emitted token (skipped whitespace
    // or comments). Stamped onto the next real token as `newlineBefore`, then
    // cleared — so the parser can honor "no LineTerminator here" restrictions
    // (e.g. an array/indexed-access type's `[` must be on the same line).
    let pendingNl = false;
    // Markup state machine — active only when `markup` is declared. 'tag' is also the
    // resting mode for token-stream grammars, where the text/raw-text branches below
    // never fire (markup is undefined) → tokenization is byte-identical to before.
    type MarkupMode = 'text' | 'tag' | 'rawtext';
    let mode: MarkupMode = markup ? 'text' : 'tag';
    let curTag = ''; // tag name being read in tag mode (decides raw-text entry)
    let inTagName = false; // the next tag-mode token is (part of) the tag name
    let sawCloseMarker = false; // this tag began `</…` → a close tag, never a raw-text opener
    function push(t: Token): void {
      if (pendingNl) { t.newlineBefore = true; pendingNl = false; }
      tokens.push(t);
    }
    // Is the previous token a completed VALUE? Then `/` after it is division (not a
    // regex) and a template after it is TAGGED (not a fresh literal). Same question,
    // shared by the regex-vs-division check and template escape validation.
    function prevIsValue(prev: Token | undefined): boolean {
      if (!prev) return false;
      // An ambiguous postfix/prefix op (e.g. `!`) is a value only in postfix position
      // (it followed a value) — recorded when it was emitted (lastBangWasPostfix).
      if (postfixAfterValueTexts.has(prev.text)) return lastBangWasPostfix;
      const isExprKeyword = prev.type === identTokenName && expressionStartKeywords.has(prev.text);
      const isParenHead = prev.text === ')' && lastCloseWasParenHead;
      return !isExprKeyword && !isParenHead && (divisionPrevTypes.has(prev.type) || divisionPrevTexts.has(prev.text));
    }

    while (pos < source.length) {
      // ── Markup TEXT mode: a run of text up to the next tag — whitespace and arbitrary
      // punctuation INCLUDED (not skipped, not rejected). Comments and a tag-open are
      // dispatched here; everything else up to the next tagOpen is one text token. ──
      if (markup && mode === 'text') {
        if (markup.comment && source.startsWith(markup.comment.open, pos)) {
          const idx = source.indexOf(markup.comment.close, pos + markup.comment.open.length);
          const end = idx < 0 ? source.length : idx + markup.comment.close.length;
          push({ type: markup.comment.token, text: source.slice(pos, end), offset: pos });
          pos = end;
          continue;
        }
        if (source.startsWith(markup.tagOpen, pos)) {
          push({ type: '', text: markup.tagOpen, offset: pos });
          pos += markup.tagOpen.length;
          mode = 'tag'; inTagName = true; sawCloseMarker = false; curTag = '';
          continue;
        }
        let p = pos;
        while (p < source.length && !source.startsWith(markup.tagOpen, p)) p++;
        push({ type: markup.textToken, text: source.slice(pos, p), offset: pos });
        pos = p;
        continue;
      }

      // ── Markup RAW-TEXT mode: verbatim element content (script/style/…), scanned to
      // the matching close tag, so `<`/`>` inside it (e.g. `a < b`, `1<2`) stay text. ──
      if (markup && mode === 'rawtext') {
        const needle = (markup.tagOpen + (markup.closeMarker ?? '') + curTag).toLowerCase();
        const idx = source.toLowerCase().indexOf(needle, pos);
        const end = idx < 0 ? source.length : idx;
        if (end > pos) push({ type: markup.rawText!.token, text: source.slice(pos, end), offset: pos });
        pos = end;
        mode = 'text'; curTag = ''; // the close tag re-tokenizes via text → tag
        continue;
      }

      // Skip whitespace
      const wsMatch = source.slice(pos).match(/^\s+/);
      if (wsMatch) { if (wsMatch[0].includes('\n')) pendingNl = true; pos += wsMatch[0].length; continue; }

      // Close an interpolation hole (interpClose at baseline depth) → resume the template span.
      if (templateStack.length > 0 && source.startsWith(tplInterpClose, pos)) {
        const depth = templateStack[templateStack.length - 1];
        if (depth === 0) {
          templateStack.pop();
          const startPos = pos;
          pos += tplInterpClose.length;
          // Continuation spans (middle/tail): skip escape validation — the whole
          // template's tagged-ness was decided at its head and isn't re-derivable from
          // the prev token here (it's the interpolation's last token).
          const { endsWithInterp, end } = scanTemplateSpan(source, pos, false);
          if (endsWithInterp) {
            push({ type: '$templateMiddle', text: source.slice(startPos, end), offset: startPos });
            templateStack.push(0);
          } else {
            push({ type: '$templateTail', text: source.slice(startPos, end), offset: startPos });
          }
          pos = end;
          continue;
        } else {
          templateStack[templateStack.length - 1]--;
        }
      }

      // Track nested opening braces inside an interpolation hole
      if (templateStack.length > 0 && source.startsWith(tplBraceOpen, pos)) {
        templateStack[templateStack.length - 1]++;
      }

      // Template literal (simple or interpolated) — only if the grammar declares a template token.
      if (templateToken && (tplOpenCode >= 0 ? source.charCodeAt(pos) === tplOpenCode : source.startsWith(tplOpen, pos))) {
        const startPos = pos;
        // A template right after a value is TAGGED — invalid escapes are then legal
        // (cooked = undefined), so validate escapes only for an untagged literal.
        const tagged = prevIsValue(tokens[tokens.length - 1]);
        pos += tplOpen.length;
        const { endsWithInterp, end } = scanTemplateSpan(source, pos, !tagged);
        if (endsWithInterp) {
          push({ type: '$templateHead', text: source.slice(startPos, end), offset: startPos });
          templateStack.push(0);
        } else {
          push({ type: templateTokenName!, text: source.slice(startPos, end), offset: startPos });
        }
        pos = end;
        continue;
      }

      const remaining = source.slice(pos);
      let matched = false;

      // Try token patterns in declaration order (the template token is handled above)
      for (const tm of tokenMatchers) {
        if (tm.name === templateTokenName) continue;
        if (markupTokenNames.has(tm.name)) continue; // scanned by the markup state machine
        if (tm.isRegex) {
          // prev is a completed value → `/` is division, not a regex literal → skip.
          if (prevIsValue(tokens[tokens.length - 1])) continue;
        }
        const m = remaining.match(tm.regex);
        if (m) {
          if (!tm.skip) {
            push({ type: tm.name, text: m[0], offset: pos });
          } else if (m[0].includes('\n')) {
            pendingNl = true; // a skipped comment spanning a newline still terminates the previous line
          }
          pos += m[0].length;
          matched = true;
          break;
        }
      }

      if (!matched) {
        // Try punctuation literals (longest first)
        for (const lit of punctLiterals) {
          if (remaining.startsWith(lit)) {
            // Track control-head parens so a `/` after `if (…)`/`while (…)` is a regex.
            // The keyword must be a real keyword head, not a member name: `obj.for(x) / y`
            // is a method call + division, so skip when the keyword is itself preceded by
            // a member accessor (e.g. `.`/`?.`, from divisionAfterTexts) → property access.
            if (lit === '(') {
              const prev = tokens[tokens.length - 1];
              const beforePrev = tokens[tokens.length - 2];
              const isMemberName = !!beforePrev && memberAccessTexts.has(beforePrev.text);
              parenHeadStack.push(
                !isMemberName && !!prev && prev.type === identTokenName && parenHeadKeywords.has(prev.text),
              );
            } else if (lit === ')') {
              lastCloseWasParenHead = parenHeadStack.pop() ?? false;
            }
            // An ambiguous postfix/prefix op (`!`): it is the value-producing postfix form
            // iff it follows a value (computed BEFORE pushing it, so prev is the token
            // before it). Chains correctly (`a!!`): each `!` reads the prior one's flag.
            if (postfixAfterValueTexts.has(lit)) lastBangWasPostfix = prevIsValue(tokens[tokens.length - 1]);
            push({ type: '', text: lit, offset: pos });
            pos += lit.length;
            matched = true;
            break;
          }
        }
      }

      if (!matched && identTokenName) {
        // Fallback: a Unicode identifier the declared identifier token's pattern may have
        // missed (e.g. accented or non-Latin names). Tagged with that token's name.
        const identMatch = remaining.match(/^[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}_$]*/u);
        if (identMatch) {
          push({ type: identTokenName, text: identMatch[0], offset: pos });
          pos += identMatch[0].length;
          matched = true;
        }
      }

      if (!matched) {
        throw new Error(`Unexpected character at offset ${pos}: '${source[pos]}'`);
      }

      // ── Markup TAG mode: track the tag being read so the closing `tagClose` knows
      // whether to enter raw-text mode. Runs only for tokens emitted in tag mode (the
      // text/raw-text branches `continue` above, never reaching here). ──
      if (markup && mode === 'tag') {
        const last = tokens[tokens.length - 1];
        if (last) {
          if (last.text === markup.tagClose) {
            mode = (!sawCloseMarker && rawTextTagSet.has(curTag.toLowerCase())) ? 'rawtext' : 'text';
            inTagName = false; sawCloseMarker = false;
          } else if (inTagName) {
            if (markup.closeMarker && last.text === markup.closeMarker) sawCloseMarker = true;
            else {
              curTag = last.text; inTagName = false;
              // An OPEN void-element name → retag so the parser's void branch matches it.
              if (markup.voidNameToken && !sawCloseMarker && voidTagSet.has(curTag.toLowerCase())) {
                last.type = markup.voidNameToken;
              }
            }
          }
        }
      }
    }

    return tokens;
  }

  return { tokenize };
}
