---
title: "September 2025 Recap"
description: "Introducing the new @import decorator, improved leak detection, and a live stream with GitHub Open Source Friday."
date: 2025-09-30
image: ../../assets/blog/september-2025-recap.png
authors:
  - name: "Varlock Team"
---

We had a great time live streaming with GitHub Open Source Friday. You can watch the full stream [here](https://www.youtube.com/watch?v=5ShnL40r-ko). 

September has flown by! Here are some of the highlights.

## New `@import` Decorator

You can now import schema and values from other `.env` files using the new `@import` decorator. This is useful for sharing common variables across a monorepo, pulling values from local files outside of your repo, and breaking up very large schemas. For now, you can only import local files, but soon we'll support remote imports and publish schemas for the env vars injected by popular platforms.

> See our [@import guide](https://varlock.dev/guides/import) for more details.

## Other Improvements & Bug Fixes

- We've improved our leak detection to work in more situations.
- We've fixed a bug with URL data type validation.
- The env-spec parser now supports `\r\n` newlines.
- We formalized our [Security policy](https://github.com/dmno-dev/varlock?tab=security-ov-file) and added private reporting for responsible disclosure.

> As always, you can find the full details in the [release notes](https://github.com/dmno-dev/varlock/releases).

## New GitHub Discussions

We've had some great discussions on GitHub this month. Join the conversation:

- [Multi-line item value function calls](https://github.com/dmno-dev/varlock/discussions/154)
- [Section/blocks improvements](https://github.com/dmno-dev/varlock/discussions/149)
- [Remote @import](https://github.com/dmno-dev/varlock/discussions/151)

## Social Buzz

- [Nick Taylor](https://bsky.app/profile/nickyt.online) gave a [great overview](https://bsky.app/profile/nickyt.online/post/3lxrnjvaats2h) of how Varlock can help with deployment pitfalls.
- 1Password launched local [env files](https://bsky.app/profile/dmno.bsky.social/post/3m232pdwzkk2q) as a destination for their new Environments and varlock supports it out of the box!
- Phil gave a [talk at React Toronto](https://bsky.app/profile/reactadvanced.gitnation.org/post/3lykokhjcis2e) about securing secrets in Next.js. Stream it [here](https://www.youtube.com/live/uiR_Xu5sz_Q?t=3895s).
