# Varlock + Env-Spec Monorepo

Monorepo for varlock and env-spec

env-spec is a new language / DSL for attaching a schema and additional functionality to .env files
using JSDoc style comments. The env-spec package contains a parser and info about the spec/language itself.

Varlock is our tool that uses this parser to actually load your .env files, and then applies the schema
that you have defined. It is a CLI, library, and will communicate with a native Mac application that 
enables using biometric auth to securely encrypt your local secrets.