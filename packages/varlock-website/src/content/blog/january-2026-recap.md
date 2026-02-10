---
title: "January 2026 Recap"
description: "Enhanced security with stdout/stderr redaction, new Google Secret Manager plugin, and a sneak peek at credential rotation."
date: 2026-01-31
image: ../../assets/blog/january-2026-recap.jpeg
authors:
  - name: "Varlock Team"
---

We've been mostly heads down working on exciting new stuff (more on that below) but we did ship improvements and a new plugin this month.

## Releases

### Core Updates

- **[`varlock@0.1.5`](https://github.com/dmno-dev/varlock/releases/tag/varlock%400.1.5)**: Enhanced security with redaction now applied to stdout and stderr in `varlock run`, preventing accidental secret leaks in command output.
- **[`varlock@0.1.4`](https://github.com/dmno-dev/varlock/releases/tag/varlock%400.1.4)**: Fixed an issue where `@generateTypes` was incorrectly enabled in imported files, improving type generation behavior.

### Plugin Updates

- **[`@varlock/google-secret-manager-plugin@0.0.2`](https://github.com/dmno-dev/varlock/releases/tag/%40varlock%2Fgoogle-secret-manager-plugin%400.0.2)**: We launched the Google Secret Manager plugin this month, enabling seamless integration with Google Cloud Secret Manager for managing your secrets. The plugin now supports dynamic `projectId` configuration, making it easier to work with multiple Google Cloud projects. Thanks to [@ya7010](https://github.com/ya7010) for the contribution!

### Integration Updates

- **[`@varlock/nextjs-integration@0.1.2`](https://github.com/dmno-dev/varlock/releases/tag/%40varlock%2Fnextjs-integration%400.1.2)**: Fixed duplicate labels in loaded env files, improving the developer experience when working with multiple environment files.

## A Sneak Peek at What's Coming Next

A problem that's interested us for a long time is the ability to do credential rotation and dynamic credentials, not just for the narrow list of services that most providers support, but for _any service or SaaS provider_.

If you'd like to learn more about this, we'd love to hear about your use cases and ideas! Reach out on [Discord](https://chat.dmno.dev) or [GitHub Discussions](https://github.com/dmno-dev/varlock/discussions).

## Community

We're always looking for feedback and ideas! Join the conversation:

- Join our [Discord community](https://chat.dmno.dev) to provide feedback and discuss new ideas.
- Engage with us on [GitHub Discussions](https://github.com/dmno-dev/varlock/discussions) with your suggestions and questions.
