# @varlock/proton-pass-plugin

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

