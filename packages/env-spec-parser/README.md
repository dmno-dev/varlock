# `@env-spec`

**@env-spec** is a simple DSL/language that extends normal dotenv syntax, allowing you to:
- add structured metadata using `@decorator` style comments similar to [JSDoc](https://jsdoc.app/)
- formalizes a syntax for setting values via function calls

_Here is a short illustrative example:_
```dotenv
# Stripe secret api key
# @required @sensitive @type=string(startsWith="sk_")
# @docsUrl=https://docs.stripe.com/keys
STRIPE_SECRET_KEY=encrypted("asdfqwerqwe2374298374lksdjflksdjf981273948okjdfksdl")
```

This structured data can be used by libraries to provide:
- additional validation, coercion, type-safety on your env vars
- extra guard-rails around handling `@sensitive` data
- more flexible loading logic without additional application code or config files

## How can schema data be used?

This schema information is most valuable when it is shared across team members and machines - so it is intended to be used within a file which is comitted to git.
In most cases, that will mean creating a `.env.schema`, committed to source control, which contains all schema info and possibly some default values.
It's not very different than a having a `.env.example` file - it's just more useful and actually involving it in the env loading process.

Then you could use additional files which set values - and of course they could add additional items or overriding properties of existing ones.
Whether you want to use a single git-ignored `.env` file, or apply a cascade of environment-specific files (e.g., `.env`, `.env.local`, `.env.test`, etc) is up to you.
However the new ability to use function calls to safely decrypt data, or load values from external sources, means you'll likely be tempted to use committed `.env` files much more.


An env-spec enabled tool would load all env files appropriately, merging together both schema and values, as well as additional values read from the shell/process.
Then the schema would be applied which could transform/fill values, for example decrypting or fetching from an external source, as well as applying coercion and validation.

| In a very simple project, you can also imagine using a single committed .env file which contains both schema and values, and takes advantage of function calls to securely load sensitive info.


## Backwards compatibility

This is designed to be mostly backwards compatible with traditional .env files, however there is no standard .env spec and various tools have slightly different rules and features, so we make some decisions to try to standardize things.
Tools may support additional compatibility flags if users want to opt in/out of specific behaviours that match other tools.

The extended feature set means an env-spec enabled parser will successfully parse env files that other tools may not.


## What is _this_ package?
This package defines a parser and related tools for parsing an **@env-spec** enabled .env file.  
It does not provide anything past this parsing step - like actually loading environment variables.  
For a usable tool which lets you actually use it in your .env files, check out https://varlock.com  


-----

# Language Syntax Reference

This is a reference of the details of the env-spec language itself.
Here we don't make and assumptions about the meaning of specific decorators, or function calls.

## Comments

Comments in env-spec (like dotenv) start with a `#`. Comments can be either on their own line, or at the end of a line after something else.
- `# this is a comment`
- `KEY=val # so is this`
- `  # but this is invalid` 

We give these comments additional meaning by letting them contain `@decorators` and attaching them to specific config items.

### `Comment`
A regular comment is a comment that does not start with `@`
- Leading whitespace is optional -- `#these`, `# are`, `#    all valid `
- Decorators within are ignored -- `# this @decorator is ignored`

### `DecoratorComment`
A decorator comment is a comment that starts with an `@` and contains decorators
- It may contain one or multiple decorators -- `# @type=integer`, `# @sensitive @required`
- There may be an additional regular comment after the decorator(s) -- `# @sensitive=false   # key is published in final build`

### `Divider`
A divider is a comment that serves as a separator, like a horizontal line
- A comment starting with `---` or `===` is considered a divider -- `# ---`, `# ===`
- A _single_ leading whitespace is optional -- `# ---`, `#---`
- Anything after that is ignored and valid -- `# --- some info`, `# ------------`

### `CommentBlock`
A comment block is a group of continuous comments that is not attached to a specific config item.
- The comment block is ended by an empty line, a `Divider`, or the end of the file.
- Both `DecoratorComment`s and `RegularComment`s may be interpersed

### `DocumentHeader`
If a `CommentBlock` ends with a `Divider` and is the first element of the document, it will be considered the Header.
- Decorators from this header can be used to configure all contained elements, or the loading process itself


## Decorators

A `Decorator` is used within comments to attach structured data to specific config items or to the entire document and loading process.

- Each decorator has a name and optional value -- `@name=value`
- Using the name only is equivalent to setting the value to true -- `@required` === `@required=true`
- Decorator values will be parsed using the common value-handling rules (see below)

**Valid decorator examples:**
```dotenv
# @willBeTrue @willBeFalse=false @explicitTrue=true @undef=undefined
# @int=123 @float=123.456 @willBeString=123.456.789
# @quoted="with spaces" @trueString="true"
# @singleQuote='hi' @backTickQuote=`hi`
# @withNewline="new\nline"`
# @funcCallNoArgs=func() @dec=funcCallArray(val1, "val2") @dec=funcCallObj(k1=v1, k2="v2")
```

**Invalid decorator examples:**
```dotenv
# @
# @int=
# @spaceNeedsQuotes=spaces without quotes
# @noNewLines="new
#              laksdjf"
```

## Config Items

Config items define individual env vars.
Each has a key, an optional value, and optional attached comments.

- Keys must start with [a-ZA-Z_], followed by any of [a-ZA-Z0-9_] -- ✅ `SOME_ITEM`, ❌ `BAD-KEY`, ❌ `2BAD_KEY`
- Setting no value is allowed and will be treated as `undefined` -- `UNDEF_VAR=`
- An empty string is allowed -- `EMPTY_STRING_VAR=""`
- Single-line values may be wrapped in quotes or not, and will follow the common value-handling rules (see below)
- Multi-line values may be wrapped in either ``( " | """ | ``` )``
- Only comments _directly_ preceeding the item will be attached to the item
- However a `Divider` will break the above comments into a `CommentBlock` that is not attached to the item
- An additional post-comment can appear after the item `ITEM1=foo # post comment`
- This post-comment can contain decorators `ITEM1=foo # @required`



## Common Value-Handling Rules
Values are interpreted similarly for config item values, decorator values, and values within function call arguments. Values may be wrapped in quotes or not, but handling varies slightly.

- Values may never contain actual newlines, but may contain the string `\n`
- Values do not have to be wrapped in quotes if they do not contain spaces
- Unquoted values also may not contain other characters depending on the context:
  - `ConfigItem` values may not contain `[ #]`
  - `Decorator` values may not contain `[ #]`
  - `FunctionCall` args may not contain `[ ,)]`
- Unquoted values will coerce `true`, `false`, `undefined` -- `@foo=false`
- Unquoted values will coerce numeric values -- `@int=123 @float=123.456`
- Otherwise unquoted values will be treated as a string
- A value in quotes is _always_ be treated as a string -- `@d1="with spaces" @trueString="true"`, `@numStr="123"`
- All quote styles ``[`'"]`` are ok -- ``@dq="c" @bt=`b` @sq='a'``
- Escaped quotes matching the wrapping quote style are ok -- `@ok="escaped\"quote"`
- In quote-wrapped values, the string `\n` will be converted to an actual newline

### Function calls

If a value is not wrapped in quotes and looks like a function call - for example `encrypted(ASDF123...)` - we will interpret it as a `FunctionCall`. This is relevant both for config item values and decorator values.

- function names must start with a letter, and can then contain letters, numbers, and underscores `/[a-ZA-Z][a-ZA-Z0-9_]*/`
- function args are always interpreted as either an array or object
- you can pass no args, a single value, or multiple
- or you may pass key value pairs, and the args will be interpreted as an object
- each value will be interpreted using common value-handling rules (see above)

Examples:
```dotenv
# @noArgs=fn()
# @oneArg=fn(asdf) @oneArgQuoted=fn("with quotes")
# @multipleArgs=fn(one, "two", three, 123.456)
# @objArgs=fn(key1=v1, key2="v2", key3=true)
```

------------------
## Notable differences with dotenv/dotenv-expand/dotenvx
- we do not support _nested_ default expansion (ex: `VAR=${FOO:-${BAR}}`
  - instead you can use the `fallback` function directly `VAR=fallback(ref(FOO), ref(BAR))`
- we do not support _unescaped_ quotes within eval expansion (ex: `VAR="$(echo "foo")"`)
  - we support backtick quotes, escaped quotes, or you can use `eval` function directly `VAR=eval(echo "foo")`
------------------

## Local dev and testing workflow

- `pnpm dev` - builds and watches everything
- `pnpm test` builds everything, run tests, and watches for changes to re-run
- `pnpm test:ci` will just build and run the tests once

If you need to pass extra flags to vitest (for example to run specific tests/files)
run `pnpm dev:grammar` in one terminal and `pnpm exec vitest ...` in another

Setting `PEGGY_TRACE=1` will enable tracing in the _built grammar file_.