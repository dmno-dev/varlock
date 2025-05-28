# Varlock

See https://varlock.dev for more info

To install the CLI, run:

```bash
# Install as standalone CLI via homebrew
brew install varlock

# OR install via cURL
curl -sSfL https://varlock.dev/install.sh | sh -s

# OR install as a dependency in a js project
npx varlock init
```

----

## Development

To get started, in the monorepo root, run: 

```bash
pnpm install
pnpm build:libs

cd packages/varlock
pnpm dev
```

> To test the CLI locally, you can use the [example-repo](../../example-repo) and [example-repo-init](../../example-repo-init) repos.

## Structure

The CLI is structured as follows:

- [src/cli/cli-executable.ts](./src/cli/cli-executable.ts): Entry point for the CLI.
- [src/cli/commands](./src/cli/commands): Commands for the CLI.
- [src/cli/helpers](./src/cli/helpers): Helpers for the CLI.
- [src/lib/](./src/lib): Utility functions for the CLI.


## Debugging

To get TS source maps enabled, run this command: `export NODE_OPTIONS='--enable-source-maps'`