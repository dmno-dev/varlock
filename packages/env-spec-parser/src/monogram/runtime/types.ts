export interface TokenDecl {
  name: string;
  pattern: string;
  flags: Array<string>;
  scope?: string; // @scope(...) override
  escapePattern?: string; // @escape /pattern/ — escape sequence regex (highlight only)
  escapeValidPattern?: string; // one well-formed escape; engine-scanned tokens reject non-matching `\`-escapes (skipped in tag position)
  embed?: string; // @embed(lang) — embedded language scope name
  // ── Lexer hints (keep the engine language-agnostic; all optional) ──
  identifier?: boolean; // THE identifier token: engine uses its name for the
  // Unicode-identifier fallback and regex division-after context.
  template?: TemplateDelimiters; // a template-literal token: engine tokenizes interpolation holes.
  regexContext?: RegexContext; // a `regex`-flagged token: when `/` is a regex vs division.
  string?: boolean; // a string-literal token: its delimiters drive editor auto-close/surround.
}

/** Delimiters an interpolated template literal is made of (e.g. JS: `` ` ``, `${`, `}`). */
export interface TemplateDelimiters {
  open: string; // starts AND ends a template literal (e.g. '`')
  interpOpen: string; // starts an interpolation hole (e.g. '${')
  interpClose: string; // ends an interpolation hole, also the brace used for nesting depth (e.g. '}')
}

/** When the regex token's `/` is a division operator instead of a regex literal. */
export interface RegexContext {
  divisionAfterTypes: Array<string>; // token TYPE names after which `/` is division (value-producing tokens)
  divisionAfterTexts: Array<string>; // token TEXTs after which `/` is division (e.g. ')', 'this', 'true')
  regexAfterTexts: Array<string>; // keyword TEXTs that (re)enter expression position → `/` is a regex
  // keyword TEXTs that, when they head a parenthesized group `kw ( … )`, make the
  // matching `)` a control-head (not a value) so a following `/` is a regex, not
  // division (e.g. `if (a) /re/.test(x)`). Overrides `)` being in divisionAfterTexts.
  regexAfterParenKeywords?: Array<string>;
  // member-access TEXTs (e.g. '.', '?.'): after one of these, an identifier is a
  // property NAME, not a keyword, so `obj.for(x) / y` is a call + division (the
  // `regexAfterParenKeywords` control-head rule does not apply).
  memberAccessTexts?: Array<string>;
  // postfix-unary operator TEXTs that are AMBIGUOUS with a prefix operator of the
  // same spelling (TS non-null `!`, also logical-not `!`). Such a token is
  // value-producing — so a following `/` is DIVISION and a following template is
  // TAGGED — ONLY when it follows a value (postfix `x!`); when it follows a
  // non-value/expression-start it is the prefix operator (`!x`, `!/re/`), so a `/`
  // right after it is a REGEX. (Unconditional postfix ops like `++`/`--` go in
  // `divisionAfterTexts` instead — a `/` can never directly follow their prefix
  // form, so they need no value-context check.)
  postfixAfterValueTexts?: Array<string>;
}

/** A raw-text element's embed, selected by a `lang="…"` attribute on the start tag. */
export interface RawEmbed {
  default: string; // embed scope when no (or an unlisted) lang= attribute
  lang?: Record<string, string>; // lang attribute value → embed scope (e.g. { ts: 'source.ts' })
}

/**
 * Declarative markup-mode tokenization (opt-in, e.g. HTML/Vue). When a grammar
 * declares `markup`, the lexer runs a text / tag / raw-text STATE MACHINE instead
 * of the pure token stream: text between tags is one TEXT token (whitespace and
 * arbitrary punctuation included, not skipped), `<…>` is tokenized as a tag, and
 * raw-text elements (`<script>`/`<style>`/…) scan verbatim to their close tag.
 *
 * Every delimiter is grammar DATA — nothing in the lexer hardcodes `<`/`>`/HTML —
 * so the engine stays language-agnostic. Mode transitions are LEXER-LOCAL (keyed
 * on the tokens the lexer itself emits: tagOpen/tagClose and the tag name), so the
 * lexer never needs parser feedback and the "lexer depends only on tokens, not
 * rules" architecture is preserved. ABSENT for token-stream languages (JS/TS),
 * where the machine is dormant and tokenization is byte-identical to before.
 */
export interface MarkupConfig {
  textToken: string; // token TYPE emitted for a run of text between tags
  tagOpen: string; // opens a tag and ends a text run (e.g. '<')
  tagClose: string; // closes a tag → return to text/raw-text (e.g. '>')
  closeMarker?: string; // marks a close tag when it directly follows tagOpen (e.g. '/' in '</'); such a tag never opens raw text
  // Attribute syntax (the host markup's `name="value"`): the name/value separator and the
  // quote characters. Kept as DATA so the markup + injection emitters bake in no HTML-specific
  // assumption (the same reason tagOpen/tagClose are data). Default to the near-universal `=`
  // and `" '`; a grammar declares them (see html.ts) and the injection layer reads them too.
  attributeAssign?: string; // e.g. '='
  attributeQuotes?: Array<string>; // e.g. ['"', "'"]
  // Attributes whose VALUE is embedded source, selected by a name pattern (HTML event handlers:
  // `on*`→source.js, like the official). The value is CAPTURE-embedded (bounded to the quoted
  // span) via the SAME helper Vue directive values use — so the embedded grammar can't run past
  // the closing quote (the #5012 fix), and a derived JS grammar reads `//` inside a string as
  // string content, not a comment (the official hand-rolls a `//` splitter here and mis-fires:
  // textmate/html.tmbundle#113). Highlight-only; the parser never sees attribute values as code.
  // `include` (optional) overrides what the value is tokenized BY when it differs from the embed
  // SCOPE — e.g. an inline `style="…"` carries a CSS *declaration list* (no selector/braces), so it
  // embeds scope `source.css` but is tokenized by `source.css#rule-list-innards` (property:value),
  // not the stylesheet root (which would mis-read `color:red` as a selector). Defaults to `embed`.
  // `valuePatterns` (optional) overrides the single `include` with an EXPLICIT list of TextMate
  // patterns to tokenize the value by — for a value that is not one homogeneous embed but a small
  // grammar of its own (Vue `generic="…"` is a TS type-PARAMETER list: comments + a variance
  // keyword + types + commas + `=` defaults). Each entry is a plain fragment ({include} or
  // {name,match}); when present it REPLACES `include` inside the value span (the quote bounding is
  // unchanged). Lets an embed mirror a hand-written grammar's value rule verbatim (e.g. Volar's
  // `vue-directives-generic-attr`) using the host's PUBLIC repository keys.
  attributeEmbed?: Array<{ namePattern: string; embed: string; include?: string; valuePatterns?: Array<RepoAlias> }>;
  // Elements whose content is raw (CDATA-like): after the start tag's `tagClose`,
  // everything up to the matching `tagOpen+closeMarker+name` is one `token`. `embed`
  // optionally maps a tag → the grammar scope to embed in its body (e.g. Vue SFC blocks:
  // template→text.html.basic, script→source.js, style→source.css); without it the body
  // is scoped by `token` (HTML's script/style convention → source.js/css). A tag may
  // instead map to `{ default, lang }` to pick the embed by a `lang="…"` attribute on the
  // start tag (Vue: `<script lang="ts">`→source.ts, `<style lang="scss">`→source.css.scss).
  rawText?: { tags: Array<string>; token: string; embed?: Record<string, string | RawEmbed> };
  // Custom-block embeds: ANY top-level block tag (not just the named rawText ones) whose start
  // tag carries `lang="<lang>"` embeds the mapped scope in its body — the Vue SFC custom-block
  // convention (`<i18n lang="yaml">`→source.yaml, `<docs lang="md">`→text.html.markdown, also
  // `<script lang="coffee">`, `<style lang="sass">`). Keyed by lang → embed scope; matches a
  // generic tag name and closes on its backreferenced `</tag>`. Tried BEFORE the named rawText
  // blocks, so an exotic lang wins over a named block's default (a `<script lang="coffee">`
  // embeds source.coffee, not the script default). The common langs stay on the named blocks.
  customBlockEmbed?: Record<string, string>;
  comment?: { open: string; close: string; token: string }; // e.g. `<!--` … `-->`
  // Void elements (`<br>`, `<img>`, `<meta>`, …) — no children, no close tag. The
  // lexer RETAGS an OPEN void-tag name from the identifier token to `voidNameToken`,
  // so the parser's void-element branch matches it by token type and never tries to
  // parse children / a close tag (which would otherwise swallow following siblings).
  // Keeps the generic parser name-blind: the void set is pure data, applied in the lexer.
  voidTags?: Array<string>;
  voidNameToken?: string;
  // Character entities in text (HTML: `&amp;`, `&#169;`, `&#xAB;`). When declared, a run
  // of text is no longer one opaque blob in the highlighter: an entity is lifted out and
  // scoped on its own (the official HTML grammar does the same — see textmate/html.tmbundle#81).
  // Pure DATA (the prefix char, the `;` terminator, and the scope names), so the emitter bakes
  // in no HTML-specific assumption — a different markup language declares its own. ABSENT →
  // text stays one blob (current behaviour). Highlight-only: the parser still emits one text
  // token (an entity is ordinary text to the grammar), so conformance is unchanged.
  entity?: MarkupEntity;
  // Markup-injection layer (Vue: directives + `{{ }}` interpolation). Because the
  // `<template>` body reuses the HTML grammar WHOLESALE (it `embed`s text.html.basic),
  // Vue syntax can't be baked into HTML — it must be INJECTED onto HTML's scopes, the
  // same reason the official Vue grammar uses an injection grammar. gen-tm derives a
  // separate injection grammar (injectionSelector over `into`) from this declaration.
  inject?: MarkupInject;
}

/** Character entities in markup text (HTML `&amp;` / `&#169;` / `&#xAB;`). All DATA, so the
 *  emitter hardcodes nothing HTML-specific. `prefix`+`terminator` delimit an entity; `numericMarker`
 *  introduces a numeric reference, `hexMarker` (after it) a hex one. The scope names follow the
 *  official HTML grammar's: named/numeric entity bodies and the prefix/terminator punctuation. */
export interface MarkupEntity {
  prefix: string; // starts an entity reference (e.g. '&')
  terminator: string; // ends it (e.g. ';')
  numericMarker: string; // marks a numeric reference after the prefix (e.g. '#' → `&#169;`)
  hexMarker: string; // marks a hex numeric reference after numericMarker (e.g. 'x' → `&#xAB;`); case-insensitive
  namedScope: string; // scope for a named entity body, e.g. constant.character.entity.named.html
  numericScope: string; // scope for a numeric entity body, e.g. constant.character.entity.html
  punctuationScope: string; // scope for the prefix/terminator punctuation, e.g. punctuation.definition.entity.html
}

/** One injectionSelector clause: a host scope plus the scopes that disqualify it, e.g.
 *  `{scope:'text.pug', excludes:['comment','string.comment']}` → `L:text.pug -comment -string.comment`.
 *  The emitter always appends `-exprEmbed` (so the injection can't re-fire inside an expression
 *  it already embedded — the #5722 guard). */
export interface InjectClause { scope: string; excludes?: Array<string> }

/** A markup-injection layer (Vue directives + `{{ }}` interpolation) injected onto a host
 *  grammar's scopes. Each CONCERN (interpolation / directives) becomes one THIN-STUB grammar
 *  file: its `scopeName` + `selector`, with `patterns:[{include: <host>#<repoKey>}]`. The rule
 *  BODIES live in the host (main) grammar's repository under `repoKey` — exactly the official
 *  Vue topology (`vue-directives.json` / `vue-interpolations.json` include `text.html.vue#…`),
 *  so the files are byte-diffable against it. All scope names + delimiters are DATA. */
export interface MarkupInject {
  exprEmbed: string; // scope wrapping an embedded expression (e.g. source.ts.embedded.html.vue)
  exprInclude: string; // grammar to tokenize the expression (e.g. source.ts#expression — Monogram's own TS)
  // `{{ … }}` interpolation in text content → injected onto the embedded-HTML scope.
  interpolation?: {
    scopeName: string; // emitted file's scopeName, e.g. vue.interpolations
    repoKey: string; // main-grammar repository key the stub includes, e.g. vue-interpolations
    selector: Array<InjectClause>; // host scopes (e.g. text.html.derivative / markdown / pug)
    open: string;
    close: string;
    beginScope: string;
    endScope: string;
  };
  // Directives in tag-attribute position → injected onto the tag scope.
  directives?: {
    scopeName: string; // emitted file's scopeName, e.g. vue.directives
    repoKey: string; // main-grammar repository key the stub includes, e.g. vue-directives
    selector: Array<InjectClause>; // host scopes (e.g. meta.tag / meta.element)
    control: Array<{ match: string; scope: string }>; // e.g. [{match:'v-for', scope:'keyword.control.loop.vue'}, …]
    shorthand: Array<{ char: string; scope: string }>; // e.g. [{char:':', scope:'punctuation.attribute-shorthand.bind.html.vue'}, …]
    prefix: string; // long-form directive prefix, e.g. 'v-'
    nameScope: string; // scope for a directive name / argument (entity.other.attribute-name.html.vue)
    eqScope: string; // scope for the `=` before a directive value (punctuation.separator.key-value.html.vue)
    // Optional scope for the quotes around a directive value. DATA, so the engine names them
    // from the grammar instead of inventing a scope string; omit → quotes left unscoped.
    valueString?: { begin: string; end: string };
  };
}

/** A small TextMate-rule fragment a grammar may inline as DATA — either a reuse `include` of an
 *  existing internal repository key, or an inline `match` with a scope `name` (e.g. an attribute
 *  value sub-pattern; see `MarkupConfig.attributeEmbed.valuePatterns`). gen-tm passes it through
 *  verbatim, so it stays language-agnostic (the engine never inspects the strings). */
export interface RepoAlias {
  include?: string; // e.g. '#type-inner'  (reuse an existing internal key)
  name?: string; // scope for an inline match
  match?: string; // inline pattern
}

export interface PrecOperator {
  value: string;
  position: 'infix' | 'prefix' | 'postfix';
  noUnaryLhs?: boolean; // infix op whose left operand may not be a bare unary-prefix expression (e.g. JS `**`)
}

export interface PrecLevel {
  assoc: 'left' | 'right' | 'none';
  operators: Array<PrecOperator>;
}

export type RuleExpr = | { type: 'seq'; items: Array<RuleExpr> }
  | { type: 'alt'; items: Array<RuleExpr> }
  | { type: 'literal'; value: string }
  | { type: 'ref'; name: string }
  | { type: 'quantifier'; body: RuleExpr; kind: '*' | '+' | '?' }
  | { type: 'group'; body: RuleExpr; suppress?: Array<string> } // suppress: LED connectors disabled while parsing body (e.g. no-`in`)
  // Zero-width negative lookahead: matches (consuming nothing) iff `body` does
  // NOT match at the current position. Used to express disambiguations the
  // longest-match parser can't reach by structure alone (e.g. a `<…>` type-arg
  // list in expression position is only a bare instantiation when it isn't
  // followed by something that starts an expression). Non-consuming → invisible
  // to highlighting / AST shape / other generators.
  | { type: 'not'; body: RuleExpr }
  // Zero-width "no LineTerminator here" assertion: matches (consuming nothing)
  // iff the NEXT token is on the same line (no preceding newline). Encodes
  // ECMAScript/TS restricted productions like an array/indexed-access type's `[`,
  // which must not follow a line terminator. Non-consuming → invisible to other
  // generators (they treat it as a no-op marker).
  | { type: 'sameLine' }
  | { type: 'sep'; element: RuleExpr; delimiter: string }
  | { type: 'op' }
  | { type: 'prefix' }
  | { type: 'postfix' };

export interface RuleDecl {
  name: string;
  body: RuleExpr;
  flags: Array<string>;
}

export interface CstGrammar {
  tokens: Array<TokenDecl>;
  precs: Array<PrecLevel>;
  rules: Array<RuleDecl>;
  scopeOverrides: Map<string, Array<string>>; // literal → scope overrides from `scopes` section (multiple if keyword appears in multiple groups)
  name?: string;
  scopeName?: string; // declared TextMate scope name (e.g. source.ts); its suffix drives every scope's language tag
  markup?: MarkupConfig; // opt-in markup-mode tokenization (HTML/Vue); absent for token-stream languages
  expressionRule?: string; // name of the rule that produces an EXPRESSION; lets gen-tm derive a `#expression` sub-grammar (for expression-only embeds, e.g. Vue `{{ }}`)
  // Extra TextMate grammars that just RE-EXPOSE this one under another scopeName (thin
  // `{scopeName, patterns:[{include: <this.scopeName>}]}` wrappers). HTML declares
  // text.html.derivative this way — the embedded-fragment scope Vue/markdown/pug inject onto;
  // VS Code ships it as a separate grammar for the same reason. gen-tm emits one file each.
  aliasScopes?: Array<{ scope: string; file: string }>;
  // Repository-key NAMING CONSTRAINT ("限制器"): a DATA map { OFFICIAL key name → the structural
  // key(s) gen-tm derived for the SAME construct }. For Monogram's source.ts to be a repository-level
  // DROP-IN, the key NAMES external grammars `#include` (`source.ts#type`, `#qstring-double`,
  // `#comment`, …) must be the names Monogram NATIVELY emits — not a structural name (`#type-inner`)
  // plus an additive alias. This map CONSTRAINS gen-tm's key emission: after the repository is built
  // with structural names, gen-tm projects the structural identity through this constraint, producing
  // the canonical official name DIRECTLY (the structural name ceases to exist — it is RENAMED, not
  // aliased) and rewriting every `#…` reference to that key consistently, so the repository holds ONE
  // key, natively named. Two value forms encode the two construct↔key relationships gen-tm derives:
  //   • a STRING (`'type': 'type-inner'`) → the official construct maps 1:1 to one structural key;
  //     RENAME that key (and all references) to the official name. The old name is gone.
  //   • an ARRAY (`'comment': ['jsdoc','linecomment',…]`) → the official key is a UNION the official
  //     grammar itself expresses as a `{patterns:[…]}` wrapper; Monogram derives the members as
  //     separate, independently-referenced keys, so no single rename can carry the official name.
  //     gen-tm SYNTHESISES the wrapper key `{patterns:[{include:#member}…]}` under the official name,
  //     each member resolved through any 1:1 rename above (so a renamed member is referenced by its
  //     final name). The members keep their own structural names (they are used elsewhere too).
  // It is purely a NAMING projection — no `match`/`begin`/`name`/scope changes — so the tokenization of
  // every input is byte-for-byte identical (it is a rename, not a pattern edit). An official name that
  // already exists as a real Monogram key (e.g. `namespace-declaration`, `expression`) is left ALONE
  // (never clobbered). The NAMES are language-specific DATA and live in the grammar definition
  // (typescript.ts may know TS names, as it knows the `scopes` map); gen-tm applies the map generically
  // (look up + substitute), so the engine stays language-agnostic — a grammar declaring none is
  // unaffected. REPLACES `repoAliases` (which left a redundant 2nd entry); this leaves none.
  canonicalRepoNames?: Record<string, string | Array<string>>;
  // VS Code extension `contributes` data — packaging info a consumer needs to wire the
  // generated grammars into an editor (and to make Monogram's Vue a true drop-in for
  // vuejs/language-tools' files). All DATA the grammar declares; gen emits a pasteable
  // `<name>.contributes.json` snippet. Absent → no manifest emitted.
  manifest?: ContributesManifest;
}

/** VS Code `contributes` packaging for a grammar. The emitter pairs this with what it
 *  already knows (scopeName, name, the injection scopeNames, the generated filenames) to
 *  build a `{languages, grammars}` snippet — so the only DATA here is what isn't derivable. */
export interface ContributesManifest {
  extensions?: Array<string>; // language file extensions (e.g. ['.vue']); default ['.' + name]
  // Host grammars each injection loads into (VS Code `injectTo`). For Vue: the SFC itself plus
  // the places a Vue template appears — text.html.vue / markdown / derivative / pug. This is a
  // packaging fact (which document languages activate the injection), distinct from a selector.
  injectTo?: Array<string>;
  // scope → VS Code language id for the main grammar's embedded regions (template/script/style),
  // so the editor knows each embed's language for IntelliSense / indentation / comments.
  embeddedLanguages?: Record<string, string>;
}
