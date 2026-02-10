---
title: "October 2025 Recap"
description: "Major varlock@0.1.0 release with the new plugin system, 1Password integration, and updated docs."
date: 2025-10-31
image: ../../assets/blog/october-2025-recap.png
authors:
  - name: "Varlock Team"
---

October was focused on major foundational work that will unlock lots of future plugins and integrations.

## Releases

Our main focus was our new plugin system, including a first-party plugin for 1Password.

- **`varlock@0.1.0`**: This release unifies resolvers with decorators, introduces a new plugin system.
- **`@varlock/1password-plugin@0.1.0`**: Our first plugin for the new plugin system. It allows seamless use of the desktop app or service accounts for local dev, and service accounts in CI/CD and deployed environments.
- **Integrations** - All of our integrations are now updated (as of `v0.1.0`), to support the new plugin system.
- **`@env-spec/parser@0.0.7`**: A new version of the env-spec parser that underpins the varlock release, including unified resolvers and decorators.

> Try these updates and let us know what you think!

## Docs Updates

- **[Docs MCP](https://varlock.dev/guides/mcp/#docs-mcp)** - Search our docs from the comfort of your favourite AI agent.
- **[1Password Plugin](https://varlock.dev/plugins/1password/)** - Secure your secrets with everyone's favourite password manager.
- **[Plugins](https://varlock.dev/guides/plugins/)** - Read more about how our plugin system works.
- **[AI Tools](https://varlock.dev/guides/ai-tools/#securely-inject-secrets-into-ai-cli-tools)** - Updated docs about securely loading secrets into your favorite AI tools with Varlock.

## Deprecations

- **`envFlag`** - As of `varlock@0.1.0`, `envFlag` has been deprecated and is replaced by `currentEnv`, see more in the [docs](https://varlock.dev/reference/root-decorators/#currentenv).
- **`docsUrl`** - As of `varlock@0.1.0`, `docsUrl` has been deprecated and is replaced by `docs()`, see more in the [docs](http://varlock.dev/reference/item-decorators/#docs).

## Community

We have a new RFC in our GitHub discussions:

- **[RFC: Baked-in Functions and Utilities](https://github.com/dmno-dev/varlock/discussions/176)**: This RFC proposes adding utilities function and new types to Varlock, such as `replace()`, `gt()`, `lt()`, and other comparison and logical operators. Thanks to [rennokki](https://github.com/rennokki) for starting the discussion!

## Upcoming Events

- **[DevtoolsTO](https://luma.com/gjwhlojt)**: Phil will be speaking at DevtoolsTO on Nov 4.
