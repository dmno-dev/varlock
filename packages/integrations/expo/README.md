# @varlock/expo-integration

This package helps you integrate [varlock](https://varlock.dev) into an [Expo](https://expo.dev) / React Native project.

It is designed as a [Babel plugin](https://docs.expo.dev/guides/using-custom-babel-plugins/) for the [Metro bundler](https://metrobundler.dev/), which replaces `ENV.xxx` references in your code with their resolved values at compile time for non-sensitive config items.

Compared to the default Expo behavior, this package provides:

- Validation of your env vars against your `.env.schema`
- Optional declarative loading of env var values via [plugins](https://varlock.dev/guides/plugins/)
- Type-generation and type-safe env var access with built-in docs
- Redaction of sensitive values from application logs
- Leak detection and prevention at build time (sensitive values are never inlined into your bundle)
- More flexible multi-env handling

See [our docs site](https://varlock.dev/integrations/expo/) for complete installation and usage instructions.

## Installation

```bash
npm install --save-dev @varlock/expo-integration varlock
# or
yarn add --dev @varlock/expo-integration varlock
# or
bun add --dev @varlock/expo-integration varlock
```

## Usage

Add the Babel plugin to your `babel.config.js`:

```js
module.exports = {
  presets: ['babel-preset-expo'],
  plugins: [
    require('@varlock/expo-integration/babel-plugin'),
  ],
};
```

Then use `ENV.xxx` in your code to access environment variables:

```ts
import { ENV } from 'varlock/env';

const apiUrl = ENV.API_URL; // replaced at compile time if non-sensitive
```

Non-sensitive `ENV.xxx` references are replaced with their static values at compile time, similar to how Vite/webpack replace `import.meta.env.xxx` or `process.env.xxx`.

Sensitive values (marked with `@sensitive` in your `.env.schema`) are **never** inlined into the bundle and must be accessed at runtime via the ENV proxy.

## How it works

1. When Metro starts the bundler, the Babel plugin calls `varlock load` to resolve all your environment variables.
2. During compilation of each file, `ENV.xxx` member expressions are replaced with their resolved literal values (for non-sensitive vars).
3. Sensitive vars remain as `ENV.xxx` references in the compiled code, requiring runtime initialization.

## Security

- Sensitive values (marked `@sensitive`) are never statically inlined into the bundle.
- `patchGlobalConsole()` is called automatically to redact sensitive values from logs.
