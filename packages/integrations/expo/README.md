# @varlock/expo-integration

This package helps you integrate [varlock](https://varlock.dev) into an [Expo](https://expo.dev) / React Native project.

It provides a **Babel plugin** for compile-time replacement of `ENV.xxx` references, and a **Metro config wrapper** that initializes the `ENV` proxy at runtime for server routes.

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

## Setup

### 1. Babel plugin

Add the Babel plugin to your `babel.config.js`:

```js
module.exports = {
  presets: ['babel-preset-expo'],
  plugins: [
    require('@varlock/expo-integration/babel-plugin'),
  ],
};
```

This handles compile-time replacement of non-sensitive `ENV.xxx` references with their resolved values, similar to how Vite/webpack replace `import.meta.env.xxx` or `process.env.xxx`.

### 2. Metro config (required for server routes)

If you use [Expo Router API routes](https://docs.expo.dev/router/reference/api-routes/) (`+api` files), wrap your Metro config with `withVarlockMetroConfig`:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withVarlockMetroConfig } = require('@varlock/expo-integration/metro-config');

const config = getDefaultConfig(__dirname);

module.exports = withVarlockMetroConfig(config);
```

This initializes the `ENV` proxy in the main Metro process so that sensitive values are available at runtime in server routes. Without this, `ENV.xxx` for sensitive values will throw in `+api` files.

> **Why is this needed?** Metro forks worker processes for Babel transforms. The Babel plugin runs in those workers, but server routes are evaluated in the main Metro process. The Metro config wrapper ensures the environment is initialized in the correct process.

## Usage

Import and use `ENV` in your code:

```ts
import { ENV } from 'varlock/env';

// Non-sensitive — replaced at compile time
const apiUrl = ENV.API_URL;
```

In server routes (`+api` files), both sensitive and non-sensitive values are accessible:

```ts
// app/secret+api.ts
import { ENV } from 'varlock/env';

export function GET() {
  // Sensitive values work at runtime in server routes
  const key = ENV.SECRET_KEY;
  return Response.json({ authorized: !!key });
}
```

## How it works

1. When Metro starts, `withVarlockMetroConfig` calls `varlock load` to resolve all environment variables and initializes the `ENV` proxy in the main process.
2. The Babel plugin runs in Metro's worker processes and replaces non-sensitive `ENV.xxx` member expressions with their resolved literal values at compile time.
3. Sensitive vars remain as `ENV.xxx` references in the compiled code. In `+api` server routes they resolve at runtime via the proxy. In native code they throw.

## Sensitive values

Values marked with `@sensitive` in your `.env.schema` are **never** inlined into the JavaScript bundle. This prevents secrets from being embedded in code that ships to user devices.

### In native code (client)

Sensitive values are **not available** in native app code. React Native apps run entirely on the device — there is no server to keep secrets safe. Accessing a sensitive value in native code will **throw at runtime**.

The Babel plugin also emits a **build-time warning** when it detects a sensitive `ENV.xxx` reference in a non-server file, so you can catch these issues before they reach production.

If you need a value in native code, reconsider whether it should be marked `@sensitive`. API keys for public services (e.g. a Maps API key) are typically non-sensitive and can be safely inlined.

### In server routes (+api files)

Sensitive values **are** accessible at runtime via the `ENV` proxy in [Expo Router API routes](https://docs.expo.dev/router/reference/api-routes/). These files run server-side in the Metro process where `withVarlockMetroConfig` has initialized the environment.

> **Note:** Expo Router pages are universal — they render on both server (SSR) and client. This means you cannot access sensitive values directly in page components like you can in Next.js Server Components. Use `+api` server routes for any logic that requires secrets.

## Security

- Sensitive values (marked `@sensitive`) are never statically inlined into the bundle.
- `patchGlobalConsole()` is called automatically to redact sensitive values from logs.
- A build-time warning is emitted when sensitive values are referenced in native (non-server) code.
- Accessing a sensitive value in client code throws at runtime, preventing accidental secret exposure.
