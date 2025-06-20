# Varlock + Env-Spec Monorepo

> https://varlock.dev

## env-spec

env-spec is a new language / DSL for attaching a schema and additional functionality to .env files
using JSDoc style comments. The env-spec package contains a parser and info about the spec/language itself.

A sample .env file with a schema:
```bash
# Description
# @required @sensitive
MY_SECRET=my-secret
```
Read the RFC for more details: https://github.com/dmno-dev/varlock/discussions/17

## Varlock

Varlock is our tool that uses this parser to actually load your .env files, and then applies the schema
that you have defined. It is a CLI, library, and will communicate with a native Mac application that 
enables using biometric auth to securely encrypt your local secrets.

You can get started with varlock by installing the CLI: 

```bash
# Install as standalone CLI via homebrew
brew install varlock

# OR install via cURL
curl -sSfL https://varlock.dev/install.sh | sh -s

# OR install as a dependency in a js project
npx varlock init
```


## Development

This monorepo contains the following packages:

- [`env-spec-parser`](./packages/env-spec-parser): The parser and info about the spec/language itself.
- [`varlock`](./packages/varlock): The CLI that uses the parser to load your .env files, and then applies the schema to validate and load your env vars.
- [`varlock-website`](./packages/varlock-website): The website for varlock and env-spec.
- [`vscode-plugin`](./packages/vscode-plugin): The VSCode extension for env-spec. It provides basic syntax highlighting and IntelliSense for the env-spec language.

To get started, run: 

```bash
# Install dependencies
pnpm install

# Build the libraries
pnpm build:libs
```
> See individual package READMEs for more details more details.
