import {
  alt,
  defineGrammar,
  many,
  many1,
  opt,
  rule,
  sep,
  token,
} from 'monogram/src/api';

const WS = token(/[ \t]+/, { skip: true, scope: 'meta.whitespace' });
// Structural tokens emitted by Monogram indentation mode (placeholder regexes).
const INDENT = token(/(?!)/, {});
const DEDENT = token(/(?!)/, {});
const NEWLINE = token(/(?!)/, { scope: 'meta.separator.newline' });

const DIVIDER = token(/#[ \t]*[-=~#]{3,}[^\r\n]*/, { scope: 'comment.line' });
const HASH = token(/#/, { scope: 'comment.line' });

const EXPORT = token(/export\b/, { scope: 'keyword.control.export' });
const ASSIGN_KEY = token(/[a-zA-Z_][a-zA-Z0-9._-]*(?==)/, { scope: 'entity.name.tag' });
const FUNCTION_NAME = token(/[a-zA-Z][a-zA-Z0-9_]*(?=[ \t]*\()/, { scope: 'variable.function' });
const IDENT = token(/[a-zA-Z_][a-zA-Z0-9._-]*(?=[ \t\n#=(),]|$)/, { scope: 'variable.other.readwrite' });
const DEC_NAME = token(/@[a-zA-Z][^ \t\n=()#@]*(?=[ \t\n=()#]|$)/);
const DEC_VALUE_TEXT = token(/(?![a-zA-Z][a-zA-Z0-9_]*[ \t]*\()[^# \t\n=(),"'`$][^# \t\n=(),$]*/, { scope: 'string.unquoted' });
const DEC_ARG_TEXT = token(/(?![a-zA-Z][a-zA-Z0-9_]*[ \t]*\()[^ \t\n,()#="'`$][^ \t\n,()#=$]*/, { scope: 'string.unquoted' });
const DEC_TEXT = token(/(?![a-zA-Z][a-zA-Z0-9_]*[ \t]*\()[^@#=\s(),"'`$][^@#=\s(),"'`$]*/, { scope: 'string.unquoted' });

const NUMBER = token(/-?(?:\d+\.\d+|\d+)(?=[ \t\n#,)=]|$)/, { scope: 'constant.numeric' });
const BOOL = token(/(?:true|false)\b/, { scope: 'constant.language.boolean' });
const UNDEFINED = token(/undefined\b/, { scope: 'constant.language.undefined' });

const TRIPLE_DOUBLE = token(/"""[\s\S]*?\n[\s\S]*?"""/, { scope: 'string.quoted.triple', string: true });
const TRIPLE_TICK = token(/```(?:\\```|[\s\S])*?```/, { scope: 'string.quoted.triple', string: true });
const STRING_INTERPOLATION = [
  {
    begin: /\\?\$\{/.source,
    end: /\}/.source,
    beginScope: 'punctuation.definition.interpolation.begin',
    endScope: 'punctuation.definition.interpolation.end',
    contentScope: 'variable.function',
  },
  {
    begin: /\\?\$\(/.source,
    end: /\)/.source,
    beginScope: 'punctuation.definition.interpolation.begin',
    endScope: 'punctuation.definition.interpolation.end',
    contentScope: 'variable.function',
  },
];
const DQ_STRING = token(/"(?:\\.|[^"\\])*"/, {
  scope: 'string.quoted.double',
  string: true,
  escape: /\\./,
  interpolation: STRING_INTERPOLATION,
});
const SQ_STRING = token(/'(?:\\.|[^'\\])*'/, { scope: 'string.quoted.single', string: true, escape: /\\./ });
const BT_STRING = token(/`(?:\\.|[^`\\])*`/, {
  scope: 'string.quoted.other',
  string: true,
  escape: /\\./,
  interpolation: STRING_INTERPOLATION,
});
const QUOTE_CHUNK = token(/["'`]+/, { scope: 'string.unquoted' });

const EXPANSION = token(/(?:\\?\$\{?[a-zA-Z_][a-zA-Z0-9_]*\}?|\\?\$\([^)]+\))/, {
  scope: 'variable.function',
});

// Slash-prefixed unquoted segments (e.g. regex-like patterns such as `/^foo$/i`).
// Kept separate from UNQUOTED_TEXT so `$` still tokenizes as EXPANSION in normal values.
const SLASH_TEXT = token(/\/[^#=,\r\n()]*/, { scope: 'string.unquoted' });
const UNQUOTED_TEXT = token(/(?![a-zA-Z][a-zA-Z0-9_]*[ \t]*\()[^#=,\r\n()$"'`\t ][^#=,\r\n()$]*/, { scope: 'string.unquoted' });
const ARG_UNQUOTED_TEXT = token(/(?![a-zA-Z][a-zA-Z0-9_]*[ \t]*\()[^ \t\n,()=#][^ \t\n,)]*/);

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
  UNQUOTED_TEXT,
]);

const FunctionArgValuePart = rule((_self) => [
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
  HASH,
]);
const FunctionArgValue = rule((_self) => [[many1(FunctionArgValuePart)]]);

const FunctionArgKeyValue = rule((_self) => [[ASSIGN_KEY, '=', FunctionArgValue]]);
const FunctionArg = rule((_self) => [FunctionArgKeyValue, FunctionArgValue]);
const FunctionArgs = rule((_self) => [['(', opt(sep(FunctionArg, ',')), opt(','), ')']]);
const FunctionCall = rule((_self) => [[FUNCTION_NAME, FunctionArgs]]);

const Value = rule((_self) => [
  [FunctionCall],
  [many1(StaticValuePart)],
]);

const DecoratorFunctionArgValue = rule((_self) => [
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

// Prefix marker for multiline decorator function args continuation lines.
// Must only consume `#` so arg content remains tokenizable by DecoratorFunctionArg.
const DecoratorLinePrefix = rule((_self) => [[HASH]]);

const DecoratorFunctionArgChunk = rule((_self) => [
  [
    opt(DecoratorLinePrefix),
    DecoratorFunctionArg,
  ],
]);

const DecoratorFunctionArgs = rule((_self) => [
  [
    '(',
    opt(sep(DecoratorFunctionArgChunk, ',')),
    opt(','),
    opt(DecoratorLinePrefix),
    ')',
  ],
]);

const DecoratorFunctionCall = rule((_self) => [[FUNCTION_NAME, DecoratorFunctionArgs]]);

const DecoratorValue = rule((_self) => [
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
  '=',
  ',',
  '(',
  ')',
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
  '=',
  ',',
  '(',
  ')',
]);

const PostComment = rule((_self) => [[HASH, many(PostCommentPart)]]);
const TrailingComment = rule((_self) => [[HASH, many(PostCommentPart)]]);
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
    StaticValuePart,
    FunctionArgValuePart,
    FunctionArgValue,
    FunctionArgKeyValue,
    FunctionArg,
    FunctionArgs,
    FunctionCall,
    Value,
    DecoratorLinePrefix,
    DecoratorFunctionArgValue,
    DecoratorArgKey,
    DecoratorFunctionArgKeyValue,
    DecoratorFunctionArg,
    DecoratorFunctionArgChunk,
    DecoratorFunctionArgs,
    DecoratorFunctionCall,
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
  },
  indent: {
    indentToken: 'INDENT',
    dedentToken: 'DEDENT',
    newlineToken: 'NEWLINE',
    flowOpen: ['('],
    flowClose: [')'],
  },
  entry: File,
  expression: File,
});

export default envSpecGrammar;
