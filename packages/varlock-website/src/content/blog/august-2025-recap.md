---
title: "August 2025 Recap"
description: "New framework integrations for Qwik, React Router, and Cloudflare Workers, plus a Docker image, GitHub Action, and more."
date: 2025-08-31
image: ../../assets/blog/august-2025-recap.png
authors:
  - name: "Varlock Team"
---

We had a great time live streaming with Nick Taylor adding varlock to his Astro project. You can watch the full stream [here](https://www.youtube.com/watch?v=AG9rTCZwokw).

August was a month of stability improvements, bug fixes, and new integrations. We've been listening to your feedback and working hard to make varlock more reliable and easier to use.

## New Features and Content

- **Updated framework integrations:** Building on the foundation of our Vite integration, we've added support for [Qwik](https://varlock.dev/integrations/qwik/), [React Router](https://varlock.dev/integrations/react-router/), and [Cloudflare Workers](https://varlock.dev/integrations/cloudflare-workers/)
- **Docker Image:** We've created a [Docker image](https://github.com/dmno-dev/varlock/pkgs/container/varlock) for varlock, making it easier to use in containerized environments.
- **GitHub Action:** Use varlock in your [GitHub Actions](https://github.com/marketplace/actions/varlock-environment-loader) workflows. Automatically emits resolved env vars so they can be reused and optionally shows a summary of the resolved env vars.
- **@required:** We've added a new [`forEnv()` helper](https://varlock.dev/reference/functions/#forenv) to the `@required` and `@optional` decorators to allow you to make items conditionally required based on the value of your `envFlag`.
- **MCP guide:** We've added a new [guide](https://varlock.dev/guides/mcp) to help you secure your MCP servers.

> Thanks to [reneleonhardt](https://github.com/reneleonhardt) for suggesting both Docker and GitHub Action features.

## Core Bug Fixes & Enhancements

- **Env Handling:** Improved logic around setting `process.env` and handling empty or undefined values.
- **Astro & Vite:** Fixed an issue with the Astro+Vite plugin.
- **Cloudflare:** Addressed a bug with global `Response` patching for Cloudflare environments.
- **Error Handling:** Fixed an error that occurred when Git is not installed.
- **Vite SSR:** The Vite plugin now works better in SSR scenarios, with improved code injection and resolved env handling.
- **.envrc:** Varlock now ignores `.envrc` files to avoid conflicts with tools like `direnv`.
- **envFlag normalization:** We've removed the normalization that previously meant `dev`, `stage`, and `prod` values in `envFlag` would be normalized to `development`, `staging`, and `production`.

## What's Next

- First-party plugin for 1Password
- GitHub App including things like PR schema validation and reporting
- `@import` decorator for importing env vars from other files

## Discussions & RFCs

- [RFC: Env Spec](https://github.com/dmno-dev/varlock/discussions/17)
- [Community RFC: Schema Store](https://github.com/dmno-dev/varlock/discussions/1280)
- [Community RFC: Native Encryption](https://github.com/dmno-dev/varlock/discussions/129)
