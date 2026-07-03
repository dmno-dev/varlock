import {
  alt,
  altPattern,
  anyChar,
  defineGrammar,
  end,
  followedBy,
  many,
  many1,
  never,
  noneOf,
  notFollowedBy,
  oneOf,
  opt,
  optPattern,
  plus,
  range,
  repeat,
  precededBy,
  rule,
  sep,
  seq,
  star,
  token,
} from 'monogram/src/api';

// ── Token pattern building blocks ──
const hspace = oneOf(' ', '\t');
const digit = range('0', '9');
const alpha = oneOf(range('a', 'z'), range('A', 'Z'));
const wordChar = oneOf(alpha, digit, '_');
const identStart = oneOf(alpha, '_');
const identChar = oneOf(alpha, digit, '.', '_', '-');
// lookahead used to keep text tokens from swallowing a function call (`fn(...)`)
const fnCallAhead = seq(alpha, star(wordChar), star(hspace), '(');

const WS = token(plus(hspace), { skip: true, scope: 'meta.whitespace' });
// Structural tokens emitted by Monogram indentation mode (placeholder patterns).
const INDENT = token(never(), {});
const DEDENT = token(never(), {});
const NEWLINE = token(never(), { scope: 'meta.separator.newline' });

const DIVIDER = token(
  seq('#', star(hspace), repeat(oneOf('-', '=', '*', '#'), 3), star(noneOf('\r', '\n'))),
  { scope: 'comment.line' },
);
const HASH = token('#', { scope: 'comment.line' });

const EXPORT = token(seq('export', notFollowedBy(wordChar)), { scope: 'keyword.control.export' });
const ASSIGN_KEY = token(seq(identStart, star(identChar), followedBy('=')), { scope: 'entity.name.tag' });
const FUNCTION_NAME = token(
  seq(alpha, star(wordChar), followedBy(seq(star(hspace), '('))),
  { scope: 'variable.function' },
);
const IDENT = token(
  seq(identStart, star(identChar), followedBy(altPattern(oneOf(' ', '\t', '\n', '#', '=', '(', ')', ',', '}', ']'), end()))),
  { scope: 'variable.other.readwrite' },
);
const DEC_NAME = token(
  seq('@', alpha, star(noneOf(' ', '\t', '\n', '=', '(', ')', '#', '@')), followedBy(altPattern(oneOf(' ', '\t', '\n', '=', '(', ')', '#'), end()))),
);
const DEC_VALUE_TEXT = token(
  seq(
    notFollowedBy(fnCallAhead),
    noneOf('#', ' ', '\t', '\n', '=', '(', ')', ',', '"', "'", '`', '$', '{', '[', '}', ']'),
    star(noneOf('#', ' ', '\t', '\n', '=', '(', ')', ',', '$', '}', ']')),
  ),
  { scope: 'string.unquoted' },
);
const DEC_ARG_TEXT = token(
  seq(
    notFollowedBy(fnCallAhead),
    noneOf(' ', '\t', '\n', ',', '(', ')', '#', '=', '"', "'", '`', '$', '{', '[', '}', ']'),
    star(noneOf(' ', '\t', '\n', ',', '(', ')', '#', '=', '$', '}', ']')),
  ),
  { scope: 'string.unquoted' },
);
const DEC_TEXT = token(
  seq(
    notFollowedBy(fnCallAhead),
    noneOf('@', '#', '=', ' ', '\t', '\n', '\r', '\f', '(', ')', ',', '"', "'", '`', '$', '{', '[', '}', ']'),
    star(noneOf('@', '#', '=', ' ', '\t', '\n', '\r', '\f', '(', ')', ',', '"', "'", '`', '$', '{', '[', '}', ']')),
  ),
  { scope: 'string.unquoted' },
);

const NUMBER = token(
  seq(
    optPattern('-'),
    altPattern(seq(plus(digit), '.', plus(digit)), plus(digit)),
    followedBy(altPattern(oneOf(' ', '\t', '\n', '#', ',', ')', '=', '}', ']'), end())),
  ),
  { scope: 'constant.numeric' },
);
const BOOL = token(seq(altPattern('true', 'false'), notFollowedBy(wordChar)), { scope: 'constant.language.boolean' });
const UNDEFINED = token(seq('undefined', notFollowedBy(wordChar)), { scope: 'constant.language.undefined' });

const TRIPLE_DOUBLE = token(
  seq('"""', star(anyChar(), { greedy: false }), '\n', star(anyChar(), { greedy: false }), '"""'),
  { scope: 'string.quoted.triple', string: true },
);
const TRIPLE_TICK = token(
  seq('```', star(altPattern(seq('\\', '```'), anyChar()), { greedy: false }), '```'),
  { scope: 'string.quoted.triple', string: true },
);
const STRING_INTERPOLATION = [
  {
    begin: '${',
    end: '}',
    beginScope: 'punctuation.definition.interpolation.begin',
    endScope: 'punctuation.definition.interpolation.end',
    contentScope: 'variable.function',
  },
  {
    begin: '$(',
    end: ')',
    beginScope: 'punctuation.definition.interpolation.begin',
    endScope: 'punctuation.definition.interpolation.end',
    contentScope: 'variable.function',
  },
];
const stringEscape = seq('\\', anyChar());
const DQ_STRING = token(seq('"', star(altPattern(stringEscape, noneOf('"', '\\'))), '"'), {
  scope: 'string.quoted.double',
  string: true,
  escape: stringEscape,
  interpolation: STRING_INTERPOLATION,
});
const SQ_STRING = token(seq("'", star(altPattern(stringEscape, noneOf("'", '\\'))), "'"), {
  scope: 'string.quoted.single',
  string: true,
  escape: stringEscape,
});
const BT_STRING = token(seq('`', star(altPattern(stringEscape, noneOf('`', '\\'))), '`'), {
  scope: 'string.quoted.other',
  string: true,
  escape: stringEscape,
  interpolation: STRING_INTERPOLATION,
});
const QUOTE_CHUNK = token(plus(oneOf('"', "'", '`')), { scope: 'string.unquoted' });

const EXPANSION = token(
  altPattern(
    seq(optPattern('\\'), '$', optPattern('{'), identStart, star(wordChar), optPattern('}')),
    seq(optPattern('\\'), '$', '(', plus(noneOf(')')), ')'),
  ),
  { scope: 'variable.function' },
);

// Slash-prefixed unquoted segments (e.g. regex-like patterns such as `/^foo$/i`).
// Kept separate from UNQUOTED_TEXT so `$` still tokenizes as EXPANSION in normal values.
// `[...]` char classes and `{...}` quantifiers are consumed as pairs so regexes like
// `/^[A-Z]{2,3}$/` stay one token; a bare `}`/`]` still ends the token (literal close).
const SLASH_TEXT = token(
  seq('/', star(altPattern(
    seq('[', star(noneOf(']', '\r', '\n')), ']'),
    seq('{', star(noneOf('}', '\r', '\n')), '}'),
    noneOf('#', '=', ',', '\r', '\n', '(', ')', '{', '[', '}', ']'),
  ))),
  { scope: 'string.unquoted' },
);
const UNQUOTED_TEXT = token(
  seq(
    notFollowedBy(fnCallAhead),
    noneOf('#', '=', ',', '\r', '\n', '(', ')', '$', '"', "'", '`', '\t', ' ', '{', '[', '}', ']'),
    star(noneOf('#', '=', ',', '\r', '\n', '(', ')', '$', '}', ']')),
  ),
  { scope: 'string.unquoted' },
);
const ARG_UNQUOTED_TEXT = token(
  seq(
    notFollowedBy(fnCallAhead),
    noneOf(' ', '\t', '\n', ',', '(', ')', '=', '#', '{', '[', '}', ']'),
    star(noneOf(' ', '\t', '\n', ',', ')', '}', ']')),
  ),
);
// A `#` glued to preceding content is part of the value (`fn(unq#uoted)`), unlike a
// space-separated `#` which starts a comment.
const GLUED_HASH_TEXT = token(
  seq(precededBy(noneOf(' ', '\t', '\n', '\r')), '#', star(noneOf(' ', '\t', '\n', ',', ')', '}', ']'))),
  { scope: 'string.unquoted' },
);

// ── Flow fillers: comments + multiline continuation inside `(...)` / `{...}` / `[...]` ──

// Any token that can appear inside a `#` comment (everything except the structural
// INDENT/DEDENT/NEWLINE tokens — a comment always ends at the line boundary).
const FlowCommentPart = rule((_self) => [
  DIVIDER,
  HASH,
  EXPORT,
  ASSIGN_KEY,
  FUNCTION_NAME,
  IDENT,
  DEC_NAME,
  NUMBER,
  BOOL,
  UNDEFINED,
  TRIPLE_DOUBLE,
  TRIPLE_TICK,
  DQ_STRING,
  SQ_STRING,
  BT_STRING,
  QUOTE_CHUNK,
  EXPANSION,
  SLASH_TEXT,
  UNQUOTED_TEXT,
  ARG_UNQUOTED_TEXT,
  GLUED_HASH_TEXT,
  DEC_VALUE_TEXT,
  DEC_ARG_TEXT,
  DEC_TEXT,
  '=',
  ',',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
]);

// A spaced `#` inside args/literals starts a comment running to the end of the
// physical line (comment content can never cross a NEWLINE/INDENT/DEDENT token).
const FlowComment = rule((_self) => [[HASH, many(FlowCommentPart)]]);

// NOTE: fillers can match empty, so they must be INLINED as combinators — a standalone
// rule that can match the empty string is not supported by the monogram parser engine.
// Value context: plain newlines + comments are free filler.
const valFill = () => many(alt(NEWLINE, INDENT, DEDENT, FlowComment));
// Decorator context: crossing a line boundary REQUIRES a `#` continuation marker
// (so a missing `#` can never silently swallow following config items); a `#` that
// does NOT directly follow a line boundary is a comment to end-of-line.
const decFill = () => many(alt(
  [many1(alt(NEWLINE, INDENT, DEDENT)), HASH],
  FlowComment,
));

const StaticValuePart = rule((_self) => [
  TRIPLE_DOUBLE,
  TRIPLE_TICK,
  DQ_STRING,
  SQ_STRING,
  BT_STRING,
  QUOTE_CHUNK,
  NUMBER,
  BOOL,
  UNDEFINED,
  EXPANSION,
  SLASH_TEXT,
  IDENT,
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  UNQUOTED_TEXT,
]);

const FunctionArgValuePart = rule((_self) => [
  // eslint-disable-next-line no-use-before-define
  ObjectLiteral,
  // eslint-disable-next-line no-use-before-define
  ArrayLiteral,
  // eslint-disable-next-line no-use-before-define
  FunctionCall,
  TRIPLE_DOUBLE,
  TRIPLE_TICK,
  DQ_STRING,
  SQ_STRING,
  BT_STRING,
  NUMBER,
  BOOL,
  UNDEFINED,
  EXPANSION,
  SLASH_TEXT,
  UNQUOTED_TEXT,
  IDENT,
  ARG_UNQUOTED_TEXT,
  GLUED_HASH_TEXT,
]);
const FunctionArgValue = rule((_self) => [[many1(FunctionArgValuePart)]]);

const FunctionArgKeyValue = rule((_self) => [[ASSIGN_KEY, '=', FunctionArgValue]]);
const FunctionArg = rule((_self) => [FunctionArgKeyValue, FunctionArgValue]);
const FunctionArgChunk = rule((_self) => [[valFill(), FunctionArg, valFill()]]);
const FunctionArgs = rule((_self) => [['(', opt(sep(FunctionArgChunk, ',')), opt(','), valFill(), ')']]);
const FunctionCall = rule((_self) => [[FUNCTION_NAME, FunctionArgs]]);

// ~ value-context object/array literals (multi-line via plain newlines, like FunctionArgs) ~
const ObjectLiteralEntry = rule((_self) => [[ASSIGN_KEY, '=', FunctionArgValue]]);
const ObjectLiteralEntryChunk = rule((_self) => [[valFill(), ObjectLiteralEntry, valFill()]]);
const ObjectLiteral = rule((_self) => [['{', opt(sep(ObjectLiteralEntryChunk, ',')), opt(','), valFill(), '}']]);
const ArrayLiteralElementChunk = rule((_self) => [[valFill(), FunctionArgValue, valFill()]]);
const ArrayLiteral = rule((_self) => [['[', opt(sep(ArrayLiteralElementChunk, ',')), opt(','), valFill(), ']']]);

const Value = rule((_self) => [
  [FunctionCall],
  [many1(StaticValuePart)],
]);

const DecoratorFunctionArgValue = rule((_self) => [
  // eslint-disable-next-line no-use-before-define
  DecoratorObjectLiteral,
  // eslint-disable-next-line no-use-before-define
  DecoratorArrayLiteral,
  // eslint-disable-next-line no-use-before-define
  DecoratorFunctionCall,
  DQ_STRING,
  SQ_STRING,
  BT_STRING,
  DEC_VALUE_TEXT,
  DEC_TEXT,
  DEC_ARG_TEXT,
  SLASH_TEXT,
  UNQUOTED_TEXT,
  EXPANSION,
  IDENT,
  NUMBER,
  BOOL,
  UNDEFINED,
]);

const DecoratorArgKey = rule((_self) => [ASSIGN_KEY, IDENT]);
const DecoratorFunctionArgKeyValue = rule((_self) => [[DecoratorArgKey, '=', DecoratorFunctionArgValue]]);
const DecoratorFunctionArg = rule((_self) => [DecoratorFunctionArgKeyValue, DecoratorFunctionArgValue]);

const DecoratorFunctionArgChunk = rule((_self) => [[decFill(), DecoratorFunctionArg, decFill()]]);

const DecoratorFunctionArgs = rule((_self) => [
  [
    '(',
    opt(sep(DecoratorFunctionArgChunk, ',')),
    opt(','),
    decFill(),
    ')',
  ],
]);

const DecoratorFunctionCall = rule((_self) => [[FUNCTION_NAME, DecoratorFunctionArgs]]);

// ~ decorator-context literals (multi-line via `#` continuation, like DecoratorFunctionArgs) ~
const DecoratorObjectLiteralEntryChunk = rule((_self) => [[decFill(), DecoratorFunctionArgKeyValue, decFill()]]);
const DecoratorObjectLiteral = rule((_self) => [['{', opt(sep(DecoratorObjectLiteralEntryChunk, ',')), opt(','), decFill(), '}']]);
const DecoratorArrayLiteralElementChunk = rule((_self) => [[decFill(), DecoratorFunctionArgValue, decFill()]]);
const DecoratorArrayLiteral = rule((_self) => [['[', opt(sep(DecoratorArrayLiteralElementChunk, ',')), opt(','), decFill(), ']']]);

const DecoratorValue = rule((_self) => [
  DecoratorObjectLiteral,
  DecoratorArrayLiteral,
  DecoratorFunctionCall,
  DQ_STRING,
  SQ_STRING,
  BT_STRING,
  SLASH_TEXT,
  UNQUOTED_TEXT,
  EXPANSION,
  IDENT,
  NUMBER,
  BOOL,
  UNDEFINED,
  DEC_VALUE_TEXT,
  // fallback: a `{` / `[` that does not form a valid literal parses as plain text
  // (so `# @dec=[` with un-prefixed continuation lines can't swallow following items)
  '{',
  '[',
]);

const DecoratorAssignedValue = rule((_self) => [['=', DecoratorValue]]);

const Decorator = rule((_self) => [
  [
    DEC_NAME,
    opt(alt(DecoratorFunctionArgs, DecoratorAssignedValue)),
  ],
]);

const DecoratorText = rule((_self) => [
  IDENT,
  ASSIGN_KEY,
  NUMBER,
  BOOL,
  UNDEFINED,
  DQ_STRING,
  SQ_STRING,
  BT_STRING,
  UNQUOTED_TEXT,
  EXPANSION,
  DEC_VALUE_TEXT,
  DEC_TEXT,
  GLUED_HASH_TEXT,
  '=',
  ',',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
]);
const DecoratorOrText = rule((_self) => [Decorator, DecoratorText]);

const PostCommentPart = rule((_self) => [
  DEC_NAME,
  DEC_TEXT,
  DEC_VALUE_TEXT,
  ASSIGN_KEY,
  IDENT,
  NUMBER,
  BOOL,
  UNDEFINED,
  DQ_STRING,
  SQ_STRING,
  BT_STRING,
  UNQUOTED_TEXT,
  EXPANSION,
  GLUED_HASH_TEXT,
  '=',
  ',',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
]);

const PostComment = rule((_self) => [[alt(HASH, GLUED_HASH_TEXT), many(PostCommentPart)]]);
const TrailingComment = rule((_self) => [[alt(HASH, GLUED_HASH_TEXT), many(PostCommentPart)]]);
const DecoratorPostComment = rule((_self) => [PostComment, TrailingComment]);

const DecoratorComment = rule((_self) => [
  [
    Decorator,
    many(DecoratorOrText),
    opt(DecoratorPostComment),
  ],
]);

const DecoratorCommentLine = rule((_self) => [[HASH, DecoratorComment]]);
const InlineDecoratorComment = rule((_self) => [[HASH, DecoratorComment]]);

const Statement = rule((_self) => [
  [DIVIDER],
  [DecoratorCommentLine],
  [TrailingComment],
  [opt(EXPORT), ASSIGN_KEY, '=', opt(Value), opt(alt(InlineDecoratorComment, PostComment, TrailingComment))],
]);

const Line = rule((_self) => [
  [many(alt(INDENT, DEDENT)), Statement, opt(NEWLINE)],
  [many1(alt(INDENT, DEDENT)), opt(NEWLINE)],
  [NEWLINE],
]);

const File = rule(() => [[many(Line)]]);

export const envSpecGrammar = defineGrammar({
  name: 'env-spec',
  scopeName: 'source.env-spec',
  tokens: {
    WS,
    INDENT,
    DEDENT,
    NEWLINE,
    DIVIDER,
    GLUED_HASH_TEXT,
    HASH,
    EXPORT,
    ASSIGN_KEY,
    FUNCTION_NAME,
    IDENT,
    DEC_NAME,
    NUMBER,
    BOOL,
    UNDEFINED,
    TRIPLE_DOUBLE,
    TRIPLE_TICK,
    DQ_STRING,
    SQ_STRING,
    BT_STRING,
    QUOTE_CHUNK,
    EXPANSION,
    SLASH_TEXT,
    UNQUOTED_TEXT,
    ARG_UNQUOTED_TEXT,
    DEC_VALUE_TEXT,
    DEC_ARG_TEXT,
    DEC_TEXT,
  },
  rules: {
    FlowCommentPart,
    FlowComment,
    StaticValuePart,
    FunctionArgValuePart,
    FunctionArgValue,
    FunctionArgKeyValue,
    FunctionArg,
    FunctionArgChunk,
    FunctionArgs,
    FunctionCall,
    ObjectLiteralEntry,
    ObjectLiteralEntryChunk,
    ObjectLiteral,
    ArrayLiteralElementChunk,
    ArrayLiteral,
    Value,
    DecoratorFunctionArgValue,
    DecoratorArgKey,
    DecoratorFunctionArgKeyValue,
    DecoratorFunctionArg,
    DecoratorFunctionArgChunk,
    DecoratorFunctionArgs,
    DecoratorFunctionCall,
    DecoratorObjectLiteralEntryChunk,
    DecoratorObjectLiteral,
    DecoratorArrayLiteralElementChunk,
    DecoratorArrayLiteral,
    DecoratorValue,
    DecoratorAssignedValue,
    Decorator,
    DecoratorText,
    DecoratorOrText,
    PostCommentPart,
    PostComment,
    TrailingComment,
    DecoratorPostComment,
    DecoratorComment,
    DecoratorCommentLine,
    InlineDecoratorComment,
    Statement,
    Line,
    File,
  },
  scopes: {
    'keyword.operator.assignment': ['='],
    'punctuation.separator.comma': [','],
    'punctuation.definition.parameters.begin': ['('],
    'punctuation.definition.parameters.end': [')'],
    'punctuation.definition.dictionary.begin': ['{'],
    'punctuation.definition.dictionary.end': ['}'],
    'punctuation.definition.array.begin': ['['],
    'punctuation.definition.array.end': [']'],
  },
  indent: {
    indentToken: 'INDENT',
    dedentToken: 'DEDENT',
    newlineToken: 'NEWLINE',
  },
  entry: File,
  expression: File,
});

export default envSpecGrammar;
