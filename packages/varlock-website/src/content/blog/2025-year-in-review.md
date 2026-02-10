---
title: "2025 Year in Review"
description: "From first release to 872 stars, 20 releases, and 157 PRs merged - a look back at an incredible year for Varlock."
date: 2025-12-31
image: ../../assets/blog/2025-year-in-review.jpeg
authors:
  - name: "Varlock Team"
---

> Thank you to each and every one of you who has given varlock a try, [starred us](https://github.com/dmno-dev/varlock) on GitHub, contributed code, opened discussions, or shared feedback on [Discord](https://chat.dmno.dev). This has been an incredible year, and we couldn't have done it without our amazing community.

## By the Numbers

- 🎉 First Release: June 18, 2025
- ⭐ Stars: 872
- 📦 Releases: 20
- 🔀 PRs Merged: 157
- 🐛 Issues Closed: 19
- 💬 Active Discussions: 11

## Major Milestones & Features

2025 was a year of rapid growth and development for Varlock. We started with a vision to make `.env` files built for sharing, powered by `@env-spec` decorator comments, and quickly grew into a trusted tool for managing environment variables across the JavaScript ecosystem and beyond.

### Core Features

- **[`@env-spec` Standard](https://varlock.dev/env-spec/overview/)** - The standard for `.env` files that varlock implements
- **[Security Guardrails](https://varlock.dev/guides/secrets/)** - Leak detection, leak prevention, and log redaction
- **[Type Safety](https://varlock.dev/reference/data-types/)** - Full TypeScript support with schema validation
- **[`@import` Decorator](https://varlock.dev/guides/import)** - Import schemas and values from other `.env` files, perfect for monorepos and sharing common variables
- **[Plugin System](https://varlock.dev/guides/plugins/)** - Extensible architecture for third-party integrations, introduced in `varlock@0.1.0` which unified resolvers with decorators

### Major Releases

- **`varlock@0.1.0`** - Major release that unified resolvers with decorators and introduced our new plugin system
- **[1Password Integration](https://varlock.dev/plugins/1password/)** - Native integration for 1Password, supporting both desktop app and service accounts

### Framework Integrations

We shipped lots of integrations this year, including: **[JavaScript / Node.js](https://varlock.dev/integrations/javascript/)**, **[Next.js](https://varlock.dev/integrations/nextjs/)**, **[Vite](https://varlock.dev/integrations/vite/)**, **[Cloudflare Workers](https://varlock.dev/integrations/cloudflare/)**, and **[Astro](https://varlock.dev/integrations/astro/)**.

### Developer Tools & Infrastructure

We also shipped tools to help you use varlock in your projects including a **[Docker Image](https://varlock.dev/guides/docker/)**, **[GitHub Action](https://varlock.dev/integrations/github-action/)**, and a **[Docs MCP](https://varlock.dev/guides/ai-tools/#varlock-docs-mcp)**.

## Community Highlights

### Active Discussions

Our community has been incredibly engaged with 11 active discussions, including:

- **[@env-spec RFC](https://github.com/dmno-dev/varlock/discussions/17)**: Initial specification for the env-spec standard
- **[Schema Store RFC](https://github.com/dmno-dev/varlock/discussions/1280)**: Community proposal for a schema store
- **[Native Encryption RFC](https://github.com/dmno-dev/varlock/discussions/129)**: Discussion on built-in encryption support
- **[Baked-in Functions RFC](https://github.com/dmno-dev/varlock/discussions/176)**: Proposal for utility functions and operators

### Events & Talks

- **[Live Stream with Nick Taylor](https://www.youtube.com/watch?v=AG9rTCZwokw)** - Theo and Phil live streamed adding varlock to Nick's Astro project.
- **[GitHub Open Source Friday](https://www.youtube.com/watch?v=5ShnL40r-ko)** - Theo and Phil live streamed on GitHub Open Source Friday with Kadesha
- **[TorontoJS](https://www.youtube.com/live/uiR_Xu5sz_Q?t=3895s)** - Phil gave a talk on securing secrets in Next.js
- **[DevtoolsTO](https://x.com/devtoolsTO)** - Phil gave a presentation on varlock at DevtoolsTO
- **[Modern Web Podcast](https://www.youtube.com/watch?v=6TVOrQVtAQs&t=3s)** - Theo and Phil joined Rob on the Modern Web Podcast
- **[Claude Code Vancouver](https://x.com/thedavidweng/status/2001848091386028474)** - Theo closed out the year with a talk at the first ever Claude Code Vancouver event.

### Mentions

- **[Next.js Weekly](https://nextjsweekly.com/issues/94)**
- **[Hacker News](https://news.ycombinator.com/item?id=44519596)**
- **[Daniel Miessler's Newsletter](https://newsletter.danielmiessler.com/p/ul-489)**
- **[ES Next News](https://ecmascript.news/archive/es-next-news-2025-07-30.html)**
- **[Astro Weekly](https://newsletter.astroweekly.dev/p/astro-weekly-98)**
- **[1Password Developer Newsletter](https://www.1password.community/blog/developer-blog/developer-newsletter-august-2025/161229)**
- **[1Password Marketplace](https://marketplace.1password.com/integration/varlock-environment-management)**

## Looking Forward

As we look ahead to 2026, we're excited about:

- **Credential Rotation**: Automatic credential rotation for 1Password and other plugins
- **GitHub App**: PR schema validation and reporting
- **More Plugins**: Expanding our plugin ecosystem with additional integrations
- **More Integrations**: Continuing to support new frameworks and tools
- **Remote `@import`**: Support for importing from remote sources

## Thank You

This year has been incredible, and it's all thanks to our amazing community. Whether you've starred us on GitHub, opened an issue or discussion, submitted a pull request, shared varlock with others, provided feedback and suggestions, or used varlock in your projects - **thank you!**

We're excited to continue building with you in 2026!
