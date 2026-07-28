# @varlock/proton-pass-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/proton-pass-plugin.svg)](https://npmx.dev/package/@varlock/proton-pass-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/proton-pass-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading secrets from [Proton Pass](https://proton.me/pass) using the Proton Pass CLI.

## Features

- **Read secrets via `pass://` references** in your `.env.schema`
- **Non-interactive login support** for CI using environment variables

## Installation

Install the plugin in a JS/TS project:

```bash
npm install @varlock/proton-pass-plugin
```

Register in your `.env.schema`:

```env-spec
# @plugin(@varlock/proton-pass-plugin)
```

## Setup

Initialize the plugin with credentials (or rely on an already-authenticated `pass-cli` session):

```env-spec
# @initProtonPass(username=$PROTON_PASS_USERNAME, password=$PROTON_PASS_PASSWORD, totp=$PROTON_PASS_TOTP)
```

## Loading secrets

Fetch secrets using Proton Pass secret references:

```env-spec
# DB_PASS is loaded from Proton Pass at pass://<vault>/<item>/password
DB_PASS=protonPass(pass://Production/Database/password)
```

## Reference

See the website docs for full resolver and decorator signatures.

