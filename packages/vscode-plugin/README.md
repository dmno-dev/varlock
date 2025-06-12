# `@env-spec` VSCode Extension

This VSCode extension adds **@env-spec** language support for your `.env` files.

This new DSL builds upon the common `.env` format, adding support for JSDoc style `@decorator` comments to provide additional metadata about your environment variables, and explicit function-call style values, to load data from external sources.

## Features

- Syntax highlighting
- Hover info for common `@decorators`
- Comment continuation (automatically continue comment blocks when you hit enter within one)

## How to use this

The new `env-spec` language mode should be enabled automatically for any `.env` and `.env.*` files, but you can always set it via the Language Mode selector in the bottom right of your editor.

### Feeback, Contributing, Support

We are actively iterating on `@env-spec` and your feedback is invaluable. Please read through our [RFC](https://github.com/dmno-dev/varlock/discussions/17) and let us know what you think!

For more immediate support, or to chat with us, please join our [Discord](https://chat.dmno.dev).
