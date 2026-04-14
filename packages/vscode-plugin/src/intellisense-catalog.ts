/* eslint-disable no-template-curly-in-string */

export type DecoratorInfo = {
  name: string;
  scope: 'root' | 'item';
  summary: string;
  documentation: string;
  insertText: string;
  isFunction?: boolean;
  deprecated?: string;
};

export type DataTypeInfo = {
  name: string;
  summary: string;
  documentation: string;
  insertText?: string;
  optionSnippets?: Array<{
    name: string;
    insertText: string;
    documentation: string;
  }>;
};

function booleanChoiceSnippet(defaultValue: 'true' | 'false' = 'true') {
  return defaultValue === 'false' ? '${1|false,true|}' : '${1|true,false|}';
}

export type ResolverInfo = {
  name: string;
  summary: string;
  documentation: string;
  insertText: string;
};

export const ROOT_DECORATORS: Array<DecoratorInfo> = [
  {
    name: 'envFlag',
    scope: 'root',
    summary: 'Deprecated environment flag decorator.',
    documentation: 'Deprecated at v0.1. Use `@currentEnv=$APP_ENV` instead.',
    insertText: '@envFlag=${1:APP_ENV}',
    deprecated: 'Use @currentEnv instead.',
  },
  {
    name: 'currentEnv',
    scope: 'root',
    summary: 'Sets the env var reference used to select environment-specific files.',
    documentation: 'Usually used in `.env.schema`, for example `# @currentEnv=$APP_ENV`.',
    insertText: '@currentEnv=$${1:APP_ENV}',
  },
  {
    name: 'defaultRequired',
    scope: 'root',
    summary: 'Controls whether items default to required, optional, or inferred.',
    documentation: 'Valid values are `true`, `false`, or `infer`.',
    insertText: '@defaultRequired=${1|infer,true,false|}',
  },
  {
    name: 'defaultSensitive',
    scope: 'root',
    summary: 'Controls whether items default to sensitive.',
    documentation: 'Valid values are `true`, `false`, or `inferFromPrefix(PUBLIC_)`.',
    insertText: '@defaultSensitive=${1|true,false,inferFromPrefix(PUBLIC_)|}',
  },
  {
    name: 'disable',
    scope: 'root',
    summary: 'Disables the current file, optionally conditionally.',
    documentation: 'Can be set directly or with a boolean resolver like `forEnv(test)`.',
    insertText: `@disable=${booleanChoiceSnippet()}`,
  },
  {
    name: 'generateTypes',
    scope: 'root',
    summary: 'Generates types from the schema.',
    documentation: 'Common usage: `# @generateTypes(lang=ts, path=./env.d.ts)`.',
    insertText: '@generateTypes(lang=${1:ts}, path=${2:./env.d.ts})',
    isFunction: true,
  },
  {
    name: 'import',
    scope: 'root',
    summary: 'Imports schema and values from another file or directory.',
    documentation: 'Takes a path as the first positional arg. Optional named args include `enabled` and `allowMissing`.',
    insertText: '@import(${1:./.env.shared})',
    isFunction: true,
  },
  {
    name: 'plugin',
    scope: 'root',
    summary: 'Loads a plugin that can register decorators, types, and resolvers.',
    documentation: 'Use the package name or identifier as the first argument.',
    insertText: '@plugin(${1:@varlock/plugin-name})',
    isFunction: true,
  },
  {
    name: 'redactLogs',
    scope: 'root',
    summary: 'Controls whether sensitive values are redacted in logs.',
    documentation: 'Boolean decorator. Sensitive values are replaced with redacted output when enabled.',
    insertText: `@redactLogs=${booleanChoiceSnippet()}`,
  },
  {
    name: 'preventLeaks',
    scope: 'root',
    summary: 'Controls whether outgoing responses are scanned for secret leaks.',
    documentation: 'Boolean decorator that enables leak-prevention checks.',
    insertText: `@preventLeaks=${booleanChoiceSnippet()}`,
  },
  {
    name: 'setValuesBulk',
    scope: 'root',
    summary: 'Injects many config values from a single data source.',
    documentation: 'Common usage: `# @setValuesBulk(exec("vault kv get ..."), format=json)`.',
    insertText: '@setValuesBulk(${1:exec("command")}, format=${2|json,env|})',
    isFunction: true,
  },
];

export const ITEM_DECORATORS: Array<DecoratorInfo> = [
  {
    name: 'required',
    scope: 'item',
    summary: 'Marks an item as required.',
    documentation: 'Equivalent to `@required=true`. Can also be driven by boolean resolvers like `forEnv(...)`.',
    insertText: '@required',
  },
  {
    name: 'optional',
    scope: 'item',
    summary: 'Marks an item as optional.',
    documentation: 'Equivalent to `@required=false`.',
    insertText: '@optional',
  },
  {
    name: 'sensitive',
    scope: 'item',
    summary: 'Marks an item as sensitive.',
    documentation: 'Sensitive items are redacted and treated as secrets.',
    insertText: '@sensitive',
  },
  {
    name: 'public',
    scope: 'item',
    summary: 'Marks an item as not sensitive.',
    documentation: 'Equivalent to `@sensitive=false`.',
    insertText: '@public',
  },
  {
    name: 'type',
    scope: 'item',
    summary: 'Sets the item data type.',
    documentation: 'Accepts a data type name or configured type call like `string(minLength=5)`.',
    insertText: '@type=${1:string}',
  },
  {
    name: 'example',
    scope: 'item',
    summary: 'Adds an example value.',
    documentation: 'Use an example when the stored value should stay empty or secret.',
    insertText: '@example=${1:"example value"}',
  },
  {
    name: 'docsUrl',
    scope: 'item',
    summary: 'Deprecated single docs URL decorator.',
    documentation: 'Deprecated. Prefer `@docs(...)`, which supports multiple docs entries.',
    insertText: '@docsUrl=${1:https://example.com/docs}',
    deprecated: 'Use docs() instead.',
  },
  {
    name: 'docs',
    scope: 'item',
    summary: 'Attaches documentation URLs to an item.',
    documentation: 'Supports `@docs(url)` or `@docs("Label", url)` and may be used multiple times.',
    insertText: '@docs(${1:https://example.com/docs})',
    isFunction: true,
  },
  {
    name: 'icon',
    scope: 'item',
    summary: 'Attaches an icon identifier to an item.',
    documentation: 'Useful for generated docs and UI surfaces that show schema metadata.',
    insertText: '@icon=${1:mdi:key}',
  },
];

export const DATA_TYPES: Array<DataTypeInfo> = [
  {
    name: 'string',
    summary: 'String value with optional length, casing, and pattern settings.',
    documentation: 'Example: `@type=string(minLength=5, startsWith=pk-)`.',
    insertText: 'string',
    optionSnippets: [
      { name: 'minLength', insertText: 'minLength=${1:1}', documentation: 'Minimum allowed string length.' },
      { name: 'maxLength', insertText: 'maxLength=${1:255}', documentation: 'Maximum allowed string length.' },
      { name: 'isLength', insertText: 'isLength=${1:32}', documentation: 'Exact required string length.' },
      { name: 'startsWith', insertText: 'startsWith=${1:prefix-}', documentation: 'Required starting substring.' },
      { name: 'endsWith', insertText: 'endsWith=${1:-suffix}', documentation: 'Required ending substring.' },
      { name: 'matches', insertText: 'matches=${1:"^[A-Z0-9_]+$"}', documentation: 'Regex or string pattern to match.' },
      { name: 'toUpperCase', insertText: `toUpperCase=${booleanChoiceSnippet()}`, documentation: 'Coerce the final value to uppercase.' },
      { name: 'toLowerCase', insertText: `toLowerCase=${booleanChoiceSnippet()}`, documentation: 'Coerce the final value to lowercase.' },
      { name: 'allowEmpty', insertText: `allowEmpty=${booleanChoiceSnippet()}`, documentation: 'Allow empty string values.' },
    ],
  },
  {
    name: 'number',
    summary: 'Number with min/max, precision, and divisibility options.',
    documentation: 'Example: `@type=number(min=0, max=100, precision=1)`.',
    insertText: 'number',
    optionSnippets: [
      { name: 'min', insertText: 'min=${1:0}', documentation: 'Minimum allowed number.' },
      { name: 'max', insertText: 'max=${1:100}', documentation: 'Maximum allowed number.' },
      { name: 'coerceToMinMaxRange', insertText: `coerceToMinMaxRange=${booleanChoiceSnippet()}`, documentation: 'Clamp values into the allowed min/max range.' },
      { name: 'isDivisibleBy', insertText: 'isDivisibleBy=${1:1}', documentation: 'Require divisibility by the given number.' },
      { name: 'isInt', insertText: `isInt=${booleanChoiceSnippet()}`, documentation: 'Require integer values.' },
      { name: 'precision', insertText: 'precision=${1:2}', documentation: 'Allowed decimal precision for non-integers.' },
    ],
  },
  {
    name: 'boolean',
    summary: 'Boolean value.',
    documentation: 'Accepts common truthy and falsy string values during coercion.',
    insertText: 'boolean',
  },
  {
    name: 'url',
    summary: 'URL with optional HTTPS prepending, allowed-domain checks, trailing-slash enforcement, and regex matching.',
    documentation: 'Example: `@type=url(prependHttps=true)`.',
    insertText: 'url',
    optionSnippets: [
      { name: 'prependHttps', insertText: `prependHttps=${booleanChoiceSnippet()}`, documentation: 'Automatically add `https://` when missing.' },
      { name: 'allowedDomains', insertText: 'allowedDomains=${1:"example.com"}', documentation: 'Restrict the URL host to an allowed domain list.' },
      { name: 'noTrailingSlash', insertText: `noTrailingSlash=${booleanChoiceSnippet()}`, documentation: 'Disallow a trailing slash on the URL path.' },
      { name: 'matches', insertText: 'matches=${1:"pattern"}', documentation: 'A regular expression that the full URL must match.' },
    ],
  },
  {
    name: 'simple-object',
    summary: 'JSON-like object value.',
    documentation: 'Coerces plain objects or JSON strings into objects.',
    insertText: 'simple-object',
  },
  {
    name: 'enum',
    summary: 'Restricted value list.',
    documentation: 'Requires explicit options, for example `@type=enum(dev, preview, prod)`.',
    insertText: 'enum(${1:development}, ${2:preview}, ${3:production})',
  },
  {
    name: 'email',
    summary: 'Email address.',
    documentation: 'Example: `@type=email(normalize=true)`.',
    insertText: 'email',
    optionSnippets: [{ name: 'normalize', insertText: `normalize=${booleanChoiceSnippet()}`, documentation: 'Lowercase the email before validation.' }],
  },
  {
    name: 'ip',
    summary: 'IPv4 or IPv6 address.',
    documentation: 'Example: `@type=ip(version=4, normalize=true)`.',
    insertText: 'ip',
    optionSnippets: [
      { name: 'version', insertText: 'version=${1|4,6|}', documentation: 'Restrict to IPv4 or IPv6.' },
      { name: 'normalize', insertText: `normalize=${booleanChoiceSnippet()}`, documentation: 'Normalize the value before validation.' },
    ],
  },
  {
    name: 'port',
    summary: 'Port number between 0 and 65535.',
    documentation: 'Example: `@type=port(min=1024, max=9999)`.',
    insertText: 'port',
    optionSnippets: [
      { name: 'min', insertText: 'min=${1:1024}', documentation: 'Minimum allowed port.' },
      { name: 'max', insertText: 'max=${1:9999}', documentation: 'Maximum allowed port.' },
    ],
  },
  {
    name: 'semver',
    summary: 'Semantic version string.',
    documentation: 'Validates standard semver values like `1.2.3`.',
    insertText: 'semver',
  },
  {
    name: 'isoDate',
    summary: 'ISO 8601 date string.',
    documentation: 'Supports date strings with optional time and milliseconds.',
    insertText: 'isoDate',
  },
  {
    name: 'uuid',
    summary: 'UUID string.',
    documentation: 'Validates RFC4122 UUIDs.',
    insertText: 'uuid',
  },
  {
    name: 'md5',
    summary: 'MD5 hash string.',
    documentation: 'Validates 32-character hexadecimal MD5 values.',
    insertText: 'md5',
  },
];

export const RESOLVERS: Array<ResolverInfo> = [
  {
    name: 'concat',
    summary: 'Concatenates multiple values into one string.',
    documentation: 'Equivalent to string expansion with multiple segments.',
    insertText: 'concat(${1:"prefix-"}, ${2:$$OTHER})',
  },
  {
    name: 'fallback',
    summary: 'Returns the first non-empty value.',
    documentation: 'Useful for layered defaults and optional sources.',
    insertText: 'fallback(${1:$$PRIMARY}, ${2:$$SECONDARY}, ${3:"default"})',
  },
  {
    name: 'exec',
    summary: 'Executes a command and uses stdout as the value.',
    documentation: 'Trailing newlines are trimmed automatically.',
    insertText: 'exec(`${1:command}`)',
  },
  {
    name: 'ref',
    summary: 'References another config item.',
    documentation: 'Usually you can use `$ITEM` directly, but `ref()` is useful when composing functions.',
    insertText: 'ref(${1:"OTHER_KEY"})',
  },
  {
    name: 'regex',
    summary: '*(deprecated)* Creates a regular expression for use inside other functions.',
    documentation: 'Deprecated — use regex literal syntax instead: `/pattern/flags`. For example: `remap($VAR, /^dev.*/, result)`.',
    insertText: 'regex(${1:"^dev.*"})',
  },
  {
    name: 'remap',
    summary: 'Maps one value to another based on match rules.',
    documentation: 'Use key/value remapping pairs after the source value.',
    insertText: 'remap(${1:$$SOURCE}, ${2:production}=${3:"main"})',
  },
  {
    name: 'forEnv',
    summary: 'Resolves to true when the current environment matches.',
    documentation: 'Requires `@currentEnv` to be set in the schema.',
    insertText: 'forEnv(${1:development})',
  },
  {
    name: 'eq',
    summary: 'Checks whether two values are equal.',
    documentation: 'Returns a boolean.',
    insertText: 'eq(${1:$$LEFT}, ${2:"value"})',
  },
  {
    name: 'if',
    summary: 'Returns different values based on a boolean condition.',
    documentation: 'Supports boolean-only usage or explicit true/false values.',
    insertText: 'if(${1:eq($$ENV, "prod")}, ${2:"https://api.example.com"}, ${3:"https://staging-api.example.com"})',
  },
  {
    name: 'not',
    summary: 'Negates a value.',
    documentation: 'Falsy values become `true`, truthy values become `false`.',
    insertText: 'not(${1:forEnv(production)})',
  },
  {
    name: 'isEmpty',
    summary: 'Checks whether a value is undefined or empty.',
    documentation: 'Useful for conditionals and optional env values.',
    insertText: 'isEmpty(${1:$$OPTIONAL_KEY})',
  },
  {
    name: 'inferFromPrefix',
    summary: 'Special helper for `@defaultSensitive`.',
    documentation: 'Used as `@defaultSensitive=inferFromPrefix(PUBLIC_)`.',
    insertText: 'inferFromPrefix(${1:PUBLIC_})',
  },
];

export const DECORATORS_BY_NAME = Object.fromEntries(
  [...ROOT_DECORATORS, ...ITEM_DECORATORS].map((decorator) => [decorator.name, decorator]),
) as Record<string, DecoratorInfo>;
