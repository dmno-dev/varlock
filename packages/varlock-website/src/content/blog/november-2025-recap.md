---
title: "November 2025 Recap"
description: "Runtime compatibility improvements, Windows support, Epic Stack fixes, and new community discussions."
date: 2025-11-30
image: ../../assets/blog/november-2025-recap.png
authors:
  - name: "Varlock Team"
---

There was lots of incremental improvements and bug fixes this month. Let's dive in!

## Core Bug Fixes & Enhancements

- **Runtime Compatibility**: Enhanced runtime code to ensure `process` object existence, preventing potential errors in environments like SvelteKit.
- **Number Coercion**: Addressed an issue to prevent incorrect auto-coercion of numbers.
- **Windows Support**: Improved the logic for finding the Varlock executable on Windows environments.
- **Path Resolution**: Updated internal logic to consistently use `process.cwd()`, enhancing path resolution and stability.
- **Next.js Integration**: Corrected issues related to Next.js development server error logging.
- **Epic-Stack Fixes**: A comprehensive batch of fixes was implemented, specifically addressing issues identified during the [epic-stack](https://github.com/dmno-dev/epic-stack) implementation.

> These updates are available in [varlock@0.1.3](https://github.com/dmno-dev/varlock/releases/tag/varlock%400.1.3) and [@varlock/nextjs-integration@0.1.1](https://github.com/dmno-dev/varlock/releases/tag/%40varlock%2Fnextjs-integration%400.1.1).

## Docs Updates

- **Getting Started Improvements**: Enhanced the [getting started documentation](https://varlock.dev/getting-started/introduction) with new overview sections.
- **Vite Best Practices**: Clarified usage and best practices for environment variables within [Vite](https://varlock.dev/integrations/vite/) projects.

## Configuration & Infrastructure

- **Telemetry Opt-Out**: Introduced a new project-level [configuration file](https://varlock.dev/guides/telemetry/#with-a-project-config-file) to allow users to opt-out of telemetry.
- **Trusted Publishing**: Established trusted publishing for npm packages, bolstering supply chain security.

## Community

We've had some great new feature discussions on GitHub this month. Join the conversation:

- **[Write value to file](https://github.com/dmno-dev/varlock/discussions/210)**: Exploring ways to fetch values from plugins and write them to files, particularly useful for certificates and other large secrets that don't make sense to pass through environment variables.
- **[Root decorator to apply multiple values](https://github.com/dmno-dev/varlock/discussions/209)**: A proposal for a new root decorator that would allow applying multiple values at once from external sources.

## Social

We've rebranded our social profiles to [Varlock.dev](https://varlock.dev) and you can find us on [X](https://x.com/varlockdev) and [Bluesky](https://bsky.app/profile/varlock.dev).

And we launched [dmno.io](https://dmno.io) to differentiate between our company (DMNO Inc.) and our projects (Varlock, DMNO, etc.).
