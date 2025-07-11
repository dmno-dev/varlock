# @varlock/nextjs-integration

This package helps you integrate [varlock](https://varlock.dev) into a [Next.js](https://nextjs.org) project.

It is designed as a drop-in replacement for `@next/env`, which is the internal package that Next.js uses to load `.env` files.

It also provides a plugin for your `next.config.*` file to enable additional security features, such as:
- Redacting sensitive config values from logs
- Preventing sensitive config values from being leaked – both at build time and runtime


## Installation

First install this module and `varlock` using your package manager of choice:
> `npm install @varlock/nextjs-integration varlock` (or pnpm, yarn, etc)

### Step 1: Install `@next/env` override

You must tell your package manager to override all resolution of `@next/env` with `@varlock/nextjs-integration`.

The method for doing this depends on your package manager:

**NPM**
See [NPM overrides docs](https://docs.npmjs.com/cli/v9/configuring-npm/package-json#overrides)

NPM lets you reference another installed dependency in overrides. For example: `"dep-to-override": "$other-installed-dep"`.

_package.json_
```
  "overrides": {
    "@next/env": "npm:@varlock/nextjs-integration"
  }
```

**Yarn**
See [yarn resolutions docs](https://yarnpkg.com/configuration/manifest#resolutions)

_root package.json_
```
  "resolutions": {
    "**/@next/env": "npm:@varlock/nextjs-integration"
  }
```

> ⚠️ If in a monorepo, this must be done in the monorepo root `package.json` file

**pnpm (version 10+)**
See [pnpm overrides docs](https://pnpm.io/settings#overrides)

> ⚠️ This must be set in `pnpm-workspace.yaml`, regardless of whether you are using a monorepo or not

_pnpm-workspace.yaml_
```
overrides:
  "@next/env": "npm:@varlock/nextjs-integration"
```

**pnpm (version 9)**
See [pnpm overrides docs](https://pnpm.io/settings#overrides)

> ⚠️ If in a monorepo, this must be set in the root `package.json` file

_root package.json_
```
  "pnpm": {
    "overrides": {
      "@next/env": "npm:@varlock/nextjs-integration"
    }
  }
```


### Step 2: Enable `next.config.*` plugin

While using _only_ the override will swap `.env` loading duties over to varlock, to get the full benefits, you must also add a config plugin in your `next.config.ts` (or `next.config.js`) file.

Next.js does not have a proper plugin system, but we can add a small transformation function on top of your existing config, which will install the necessary adjustments.

Here is an example of how to do this:

```ts
import type { NextConfig } from "next";
import { varlockNextConfigPlugin } from '@varlock/nextjs-integration/plugin';

const nextConfig: NextConfig = {
  // your existing config...
};

export default varlockNextConfigPlugin()(nextConfig);
```



## Accessing env vars in your code
While your resolved config will be re-injected as normal env vars and you can continue to use `process.env.SOMEVAR` as usual, we recommend using varlock's imported `ENV` object instead. For example:

```ts
import { ENV } from 'varlock/env';

console.log(process.env.SOMEVAR); // 🆗 still works
console.log(ENV.SOMEVAR);         // ✨ but this is recommended
```

### Type-safety

To enable type-safety and IntelliSense for your env vars, you must enable the [`@generateTypes` root decorator](https://varlock.dev/reference/root-decorators/#generatetypes) in your `.env.schema`.
> ⚠️ If you ran `npx varlock init`, this will likely already be enabled for you.

```env-spec
# @generateTypes(lang='ts', path='env.d.ts')
# ---
# your config items...
```

This will make types available both for `process.env` and for varlock's `ENV` object.

### Why use `ENV` instead of `process.env`?
- Any non-string values (e.g., number, boolean) will actually be their coerced value, rather than a string
- _All_ non-sensitive items will be replaced at build time, not just `NEXT_PUBLIC_` prefixed items
- Better error messages when using invalid keys, or server-side keys that are not available on the client
- Enables further DX improvements in the future, such as tighter control over which items are bundled at build time.



## Managing multiple environments (dev, preview, prod, etc)

Varlock excels at managing multiple environments and can load multiple _environment-specific_ .env files (e.g., `.env.development`, `.env.preview`, `.env.production`, etc.).

While `.env.schema`, `.env`, and `.env.local` will always be loaded, loading env-specific files is controlled by a notion of an _environment flag_.

[Next.js .env handling](https://nextjs.org/docs/pages/guides/environment-variables#loading-environment-variables-with-nextenv) has the following behavior to set the env flag and control loading env-specific .env files:
- use `test` if `NODE_ENV` is set to `test`
- otherwise use `development` if running `next dev`
- otherwise use `production`

By default, this module will match that behaviour, but we recommend using the [`@envFlag` root decorator](https://varlock.dev/reference/root-decorators/#envflag) in your `.env.schema` to specify your own _custom environment flag_, such as `APP_ENV`.

**⚠️ Without a custom env flag, you will not have the ability to use a non-production env file (e.g., `.env.preview`, `.env.staging`, etc) for your non-prod deployments.**

How we set the value of our env flag will depend on your deployment platform.

When running locally, or building and deploying your next app on a platform you control, you can set it explicitly, often passed in via `package.json` scripts. For example:
```json
// package.json
"scripts": {
  "build:preview": "APP_ENV=preview next build",
  "start:preview": "APP_ENV=preview next start",
  "build:prod": "APP_ENV=production next build",
  "start:prod": "APP_ENV=production next start",
  "test": "APP_ENV=test jest"
}
```

However on some cloud platforms (e.g., Vercel, Cloudflare, etc), you may not have control over a boot command, or even the ability to vary environment variables as you would like.
Even if you do, it's not always ideal to have this configuration buried in a UI rather than your code.

In these cases, we can set the value of `APP_ENV` (or whatever you name your env flag) using resolver functions to transform existing env vars that the platform's CI/CD pipeline provides (e.g., branch name, platform's notion of env, etc)

The following examples show how you could do this, but note that you could segment your environments (and name them) however you like.

### Vercel

In Vercel, you can set `APP_ENV` explicitly in their env vars UI. But to keep everything contained in your schema, you can use the injected `VERCEL_ENV`.

```env-spec
# @envFlag=APP_ENV
# ---
# current environment type, injected by vercel during deployments
# @type=enum(development, preview, production)
# @docsUrl="https://vercel.com/docs/environment-variables/system-environment-variables#system-environment-variables"
VERCEL_ENV=
# Our env flag, used to toggle loading of env-specific files
APP_ENV=fallback($VERCEL_ENV, development)
```

If you need more specific environments based on branch names, you can use `VERCEL_GIT_COMMIT_REF` instead. See the Cloudflare example below for more details.

### Cloudflare Workers Build

In Cloudflare Workers Builds, it is not possible to alter our build command for prod versus non-prod builds, and there is no concept of branch-specific env vars.

We must rely on the current branch name, injected as `WORKERS_CI_BRANCH`, to determine what our env flag should be.

We can use the following strategy to set our env flag:
- `production` – if `WORKERS_CI_BRANCH` is set to `main`, this is a production deployment  
- `preview` – if `WORKERS_CI_BRANCH` is set to anything else, this is a preview deployment  
- `development` – if `WORKERS_CI_BRANCH` is not set, this means we are not within CI, so we must be doing local development  
- `test` – we can set this explicitly in our test command. For example, in our `package.json` scripts, we could use `"test": "APP_ENV=test jest"`.

```env-spec
# @envFlag=APP_ENV
# ---
# current branch set by Cloudflare Workers Build
# @docsUrl="https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#environment-variables"
WORKERS_CI_BRANCH=
# Our env flag, used to toggle loading of env-specific files
# @type=enum(development, preview, production, test)
APP_ENV=remap($WORKERS_CI_BRANCH, production="main", preview=regex(.*), development=undefined)
```

## Managing Sensitive Config Values

Next.js itself uses the [`NEXT_PUBLIC_` prefix](https://nextjs.org/docs/pages/guides/environment-variables#bundling-environment-variables-for-the-browser) to determine which env vars can be considered _public_ (i.e., not sensitive). These public vars will be bundled at build-time made available in the browser.

Varlock controls the default sensitive behavior via the [`@defaultSensitive` root decorator](https://varlock.dev/reference/root-decorators/#defaultsensitive).

If you want to continue using the prefix, you can use `# @defaultSensitive=inferFromPrefix('NEXT_PUBLIC_')` in your `.env.schema` file.

```env-spec
# @defaultSensitive=inferFromPrefix('NEXT_PUBLIC_')
# ---
FOO= # sensitive
NEXT_PUBLIC_FOO= # non-sensitive, due to prefix
```

However, we recommend you set `@defaultSensitive` to `true` or `false` and then explicitly tag individual items using the [`@sensitive`](https://varlock.dev/reference/item-decorators/#sensitive) item decorator. For example:

```env-spec
# @defaultSensitive=true
# ---
SECRET_FOO= # will be sensitive, due to default
# @sensitive=false
NON_SECRET_FOO=
```

> ⚠️ NOTE - All non-sensitive items will be bundled at build-time via varlock's `ENV` object, while `process.env` replacements will only include `NEXT_PUBLIC_` prefixed items.


