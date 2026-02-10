---
title: "July 2025 Recap"
description: "New integrations for Next.js, Vite, and Astro, plus core bug fixes and improvements."
date: 2025-07-31
image: ../../assets/blog/july-2025-recap.jpeg
authors:
  - name: "Varlock Team"
---

July was a busy month! We shipped lots of integrations and improvements to varlock itself and started to get the word out. Shout out to [Console.dev](https://console.dev) and [Next.js Weekly](https://nextjsweekly.com/issues/94) for the features.

> Most importantly thanks to each and every one of you who has given varlock a try or [starred us](https://github.com/dmno-dev/varlock) on GitHub.

## New Integrations

- **[Next.js](https://varlock.dev/integrations/nextjs/):** Drop-in replacement for `next-env`, and additional security features like log redaction and leak detection
- **[Vite](https://varlock.dev/integrations/vite/):** Integration for projects that use Vite directly, including support for HTML replacement and env vars in Vite config
- **[Astro](https://varlock.dev/integrations/astro/):** Built on top of our Vite integration, includes leak detection middleware and support for env vars in your Astro config!

## Core Bug Fixes & Enhancements

- The `varlock init` command received important bug fixes.
- The core package now handles empty `.env` files and missing schema files more gracefully.
- The Next.js integration got a fix for its development server reloading behavior.
- The `load` command help text now includes all available formats.

## What's Next

- More integrations (starting with more frameworks that use Vite)
- Docker Image and GitHub Action with the varlock CLI
- GitHub App including things like PR schema validation and reporting

## How Can You Help?

- Please comment on the @env-spec [RFC](https://github.com/dmno-dev/varlock/discussions/17)
- Share varlock with anyone who might be interested
- And let us know how we can improve! ([Discord](https://chat.dmno.dev) | [GH Discussions](https://github.com/dmno-dev/varlock/discussions))
